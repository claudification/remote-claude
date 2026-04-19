/**
 * Channel handlers: inter-session messaging, session discovery, link management,
 * channel subscriptions, dashboard subscriptions, and session quit relay.
 */

import type { SubscriptionChannel } from '../../shared/protocol'
import { slugify } from '../address-book'
import { getUser } from '../auth'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'
import { resolvePermissionFlags } from '../permissions'
import { computeLocalId, formatAmbiguityError, resolveSendTarget } from './channel-id'

// ─── Dashboard subscription ────────────────────────────────────────

const subscribe: MessageHandler = (ctx, data) => {
  ctx.ws.data.isDashboard = true
  const pv = (data.protocolVersion as number) || 1
  ctx.sessions.addSubscriber(ctx.ws, pv)
  ctx.reply({ type: 'agent_status', connected: ctx.sessions.hasAgent() })

  // Push current usage data if available
  const usage = ctx.sessions.getUsage()
  if (usage) {
    ctx.reply({ type: 'usage_update', usage })
  }

  // Push resolved permissions to client (server owns grant resolution)
  const grants = ctx.ws.data.grants
  if (grants) {
    const user = ctx.ws.data.userName ? getUser(ctx.ws.data.userName) : undefined
    const serverRoles = user?.serverRoles
    // Global permissions (cwd='*')
    const global = resolvePermissionFlags(grants, '*', serverRoles)
    // Per-session permissions (resolved against each session's CWD)
    const sessions: Record<string, ReturnType<typeof resolvePermissionFlags>> = {}
    for (const s of ctx.sessions.getActiveSessions()) {
      sessions[s.id] = resolvePermissionFlags(grants, s.cwd, serverRoles)
    }
    ctx.reply({ type: 'permissions', global, sessions })
  }

  // Push initial shares state to admin subscribers
  ctx.sessions.broadcastSharesUpdate()

  // Push any pending dialogs + plan approvals (reconnect recovery)
  for (const s of ctx.sessions.getActiveSessions()) {
    if (s.pendingDialog) {
      ctx.reply({
        type: 'dialog_show',
        sessionId: s.id,
        dialogId: s.pendingDialog.dialogId,
        layout: s.pendingDialog.layout,
      })
    }
    if (s.pendingPlanApproval) {
      ctx.reply({
        type: 'plan_approval',
        sessionId: s.id,
        requestId: s.pendingPlanApproval.requestId,
        toolUseId: s.pendingPlanApproval.toolUseId,
        plan: s.pendingPlanApproval.plan,
        planFilePath: s.pendingPlanApproval.planFilePath,
        allowedPrompts: s.pendingPlanApproval.allowedPrompts,
      })
    }
    if (s.pendingPermission) {
      ctx.reply({
        type: 'permission_request',
        sessionId: s.id,
        requestId: s.pendingPermission.requestId,
        toolName: s.pendingPermission.toolName,
        description: s.pendingPermission.description,
        inputPreview: s.pendingPermission.inputPreview,
        toolUseId: s.pendingPermission.toolUseId,
      })
    }
    if (s.pendingAskQuestion) {
      ctx.reply({
        type: 'ask_question',
        sessionId: s.id,
        toolUseId: s.pendingAskQuestion.toolUseId,
        questions: s.pendingAskQuestion.questions,
      })
    }
  }

  ctx.log.debug(`Subscriber connected (v${pv}, total: ${ctx.sessions.getSubscriberCount()})`)
}

const refreshSessions: MessageHandler = ctx => {
  ctx.sessions.sendSessionsList(ctx.ws)
}

const syncCheck: MessageHandler = (ctx, data) => {
  ctx.sessions.handleSyncCheck(
    ctx.ws,
    (data.epoch as string) || '',
    (data.lastSeq as number) || 0,
    data.transcripts as Record<string, number> | undefined,
  )
  ctx.log.debug(
    `sync check: epoch=${((data.epoch as string) || '').slice(0, 8)} seq=${data.lastSeq || 0} transcripts=${data.transcripts ? Object.keys(data.transcripts as object).length : 0}`,
  )
}

// ─── Channel subscriptions (per-session event streams) ─────────────

const channelSubscribe: MessageHandler = (ctx, data) => {
  const channel = data.channel as SubscriptionChannel
  const sessionId = data.sessionId as string
  const agentId = data.agentId as string | undefined
  if (!channel || !sessionId) return
  const sess = ctx.sessions.getSession(sessionId)
  if (sess) ctx.requirePermission('chat:read', sess.cwd)
  ctx.sessions.subscribeChannel(ctx.ws, channel, sessionId, agentId)
  ctx.reply({ type: 'channel_ack', channel, sessionId, agentId, status: 'subscribed' })
  ctx.log.debug(`[channel] ${channel}:${sessionId.slice(0, 8)}${agentId ? `:${agentId.slice(0, 8)}` : ''} +sub`)
}

const channelUnsubscribe: MessageHandler = (ctx, data) => {
  const channel = data.channel as SubscriptionChannel
  const sessionId = data.sessionId as string
  const agentId = data.agentId as string | undefined
  if (!channel || !sessionId) return
  ctx.sessions.unsubscribeChannel(ctx.ws, channel, sessionId, agentId)
  ctx.reply({ type: 'channel_ack', channel, sessionId, agentId, status: 'unsubscribed' })
  ctx.log.debug(`[channel] ${channel}:${sessionId.slice(0, 8)}${agentId ? `:${agentId.slice(0, 8)}` : ''} -sub`)
}

const channelUnsubscribeAll: MessageHandler = ctx => {
  ctx.sessions.unsubscribeAllChannels(ctx.ws)
  ctx.log.debug('[channel] unsubscribed all')
}

// ─── Session discovery (list_sessions) ─────────────────────────────

const channelListSessions: MessageHandler = (ctx, data) => {
  const status = (data.status as string) || 'live'
  const showMetadata = !!data.show_metadata
  const callerSession = ctx.ws.data.sessionId
  const callerCwd = ctx.caller?.cwd
  const isBenevolent = ctx.callerSettings?.trustLevel === 'benevolent'
  const all = Array.from(ctx.sessions.getAllSessions())

  // Filter by status and exclude self
  const filtered = all
    .filter(s => {
      if (status === 'all') return true
      const isLive = ctx.sessions.getActiveWrapperCount(s.id) > 0
      return status === 'live' ? isLive : !isLive
    })
    .filter(s => s.id !== callerSession)
    .filter(s => {
      // Hide ad-hoc sessions unless they have an established link with the caller
      const isAdHoc = s.capabilities?.includes('ad-hoc')
      if (!isAdHoc) return true
      if (!callerSession) return false
      const linkStatus = ctx.sessions.checkProjectLink(callerSession, s.id)
      return linkStatus === 'linked'
    })

  // Group sessions by CWD to detect multi-session projects
  const cwdGroups = new Map<string, typeof filtered>()
  for (const s of filtered) {
    const group = cwdGroups.get(s.cwd) || []
    group.push(s)
    cwdGroups.set(s.cwd, group)
  }

  const result = filtered.map(s => {
    const linkStatus = callerSession ? ctx.sessions.checkProjectLink(callerSession, s.id) : 'unknown'
    const isLinked = linkStatus === 'linked'
    const showFull = isBenevolent || isLinked
    const shortCwd = s.cwd.split('/').slice(-2).join('/')
    const projSettings = ctx.getProjectSettings(s.cwd)
    const sessionName = s.title || projSettings?.label || s.cwd.split('/').pop() || s.cwd
    const isLive = ctx.sessions.getActiveWrapperCount(s.id) > 0
    const queueSize = ctx.messageQueue.getQueueSize(s.cwd)

    // Assign a stable project-level slug via the caller's address book.
    // Slug is derived from the PROJECT (label or dirname), never the session title --
    // multiple sessions can share a CWD; the project identity must not depend on
    // whichever session happened to register first.
    const projectName = projSettings?.label || s.cwd.split('/').pop() || s.cwd
    const projectSlug = callerCwd ? ctx.addressBook.getOrAssign(callerCwd, s.cwd, projectName) : slugify(projectName)

    // ALWAYS compound `project:session-slug` -- bare ids would silently flip
    // shape when a second session spawns at the same cwd. See channel-id.ts.
    const cwdGroup = cwdGroups.get(s.cwd) || [s]
    const localId = computeLocalId(s, projectSlug, cwdGroup)

    return {
      id: localId, // stable local address (use for send_message, etc.)
      project: projectSlug, // project-level grouping ID
      session_id: s.id,
      name: sessionName,
      cwd: showFull ? s.cwd : shortCwd,
      status: (isLive ? 'live' : 'inactive') as 'live' | 'inactive',
      capabilities: s.capabilities,
      ...(projSettings?.label && projSettings.label !== sessionName ? { label: projSettings.label } : {}),
      ...(projSettings?.description ? { description: projSettings.description } : {}),
      link: isLinked ? 'connected' : linkStatus === 'blocked' ? 'blocked' : undefined,
      title: s.title,
      summary: s.summary,
      ...(queueSize > 0 ? { queued: queueSize } : {}),
      ...(showMetadata && isBenevolent && projSettings
        ? {
            metadata: {
              label: projSettings.label,
              icon: projSettings.icon,
              color: projSettings.color,
              keyterms: projSettings.keyterms,
            },
          }
        : {}),
    }
  })
  ctx.reply({ type: 'channel_sessions_list', sessions: result })
}

// ─── Inter-session messaging (channel_send) ────────────────────────

/**
 * Compute the sender's routable ID from the receiver's perspective.
 *
 * Must match the ID shape produced by `list_sessions` so a recipient can
 * pass `from_session` straight back as `to` without a round-trip through
 * list_sessions. When the sender's CWD hosts multiple sessions, the ID
 * is compounded `project:session-slug` -- bare project slugs would be
 * ambiguous and rejected by the send resolver.
 */
function computeSenderRoutableId(
  ctx: Parameters<MessageHandler>[0],
  fromSess: { id: string; cwd: string; title?: string } | undefined,
  toCwd: string | undefined,
  fromProject: string,
): { routable: string; project: string } {
  if (!fromSess?.cwd || !toCwd) {
    const fallback = fromSess?.id || slugify(fromProject)
    return { routable: fallback, project: fallback }
  }
  const projectSlug = ctx.addressBook.getOrAssign(toCwd, fromSess.cwd, fromProject)
  const sessionsAtCwd = Array.from(ctx.sessions.getAllSessions()).filter(s => s.cwd === fromSess.cwd)
  // Always compound -- list_sessions must be able to round-trip the from-id.
  const cwdGroup = sessionsAtCwd.length > 0 ? sessionsAtCwd : [fromSess]
  return { routable: computeLocalId(fromSess, projectSlug, cwdGroup), project: projectSlug }
}

const channelSend: MessageHandler = (ctx, data) => {
  const fromSession = ctx.ws.data.sessionId || (data.fromSession as string)
  const toTarget = data.toSession as string
  if (!fromSession || !toTarget) return

  const fromSess = ctx.sessions.getSession(fromSession)
  const callerCwd = fromSess?.cwd

  // Parse compound target: "project:session-name" or bare "project"
  const colonIdx = toTarget.indexOf(':')
  const projectSlug = colonIdx >= 0 ? toTarget.slice(0, colonIdx) : toTarget
  const sessionSlug = colonIdx >= 0 ? toTarget.slice(colonIdx + 1) : undefined

  // Resolve target: address book first, then wrapper ID, then session ID (backwards compat)
  const targetCwd = callerCwd ? ctx.addressBook.resolve(callerCwd, projectSlug) : undefined

  let toSess: ReturnType<typeof ctx.sessions.getSession> | undefined
  if (targetCwd) {
    const sessionsAtCwd = Array.from(ctx.sessions.getAllSessions()).filter(s => s.cwd === targetCwd)
    const projSettings = ctx.getProjectSettings(targetCwd)
    const canonicalProject = slugify(projSettings?.label || targetCwd.split('/').pop() || projectSlug)
    const resolved = resolveSendTarget({
      projectSlug,
      sessionSlug,
      sessionsAtCwd,
      canonicalProject,
      isLive: s => ctx.sessions.getActiveWrapperCount(s.id) > 0,
    })
    if (resolved.kind === 'ambiguous') {
      ctx.reply({
        type: 'channel_send_result',
        ok: false,
        error: formatAmbiguityError(resolved.canonicalProject, resolved.candidates),
      })
      return
    }
    if (resolved.kind === 'resolved') {
      toSess = ctx.sessions.getSession(resolved.session.id)
    }
  } else {
    toSess = ctx.sessions.getSessionByWrapper(toTarget) || ctx.sessions.getSession(toTarget)
  }

  const toSession = toSess?.id

  // If we resolved a CWD but no active session, queue for offline delivery
  if (targetCwd && !toSess) {
    const fromProject =
      ctx.getProjectSettings(callerCwd || '')?.label || callerCwd?.split('/').pop() || fromSession.slice(0, 8)
    // Resolve sender ID from receiver's address book perspective (works even when target is offline).
    // `routable` is a list_sessions-compatible ID the recipient can pass straight back as `to`;
    // `project` is the bare project slug for grouping/context.
    const { routable: fromSlug, project: fromProjectSlug } = computeSenderRoutableId(
      ctx,
      fromSess && { id: fromSess.id, cwd: fromSess.cwd, title: fromSess.title },
      targetCwd,
      fromProject,
    )
    const conversationId = (data.conversationId as string) || `conv_${Date.now().toString(36)}`
    const delivery = {
      type: 'channel_deliver',
      fromSession: fromSlug,
      fromProject: fromProjectSlug,
      intent: data.intent,
      message: data.message,
      context: data.context,
      conversationId,
    }
    ctx.messageQueue.enqueue(targetCwd, callerCwd || '', fromProject, delivery, sessionSlug)

    // Brief wait: if target reconnects within 1s, the queue drains automatically
    // and we can report 'delivered' instead of 'queued'
    async function checkDelivered() {
      for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 250))
        // biome-ignore lint/style/noNonNullAssertion: guaranteed non-null by enclosing if (targetCwd) block
        if (ctx.messageQueue.getQueueSize(targetCwd!) === 0) {
          ctx.reply({ type: 'channel_send_result', ok: true, conversationId, status: 'delivered' })
          ctx.log.debug(`[inter-session] ${fromSession.slice(0, 8)} -> ${toTarget} (queued then delivered)`)
          return
        }
      }
      ctx.reply({ type: 'channel_send_result', ok: true, conversationId, status: 'queued' })
      ctx.log.debug(`[inter-session] ${fromSession.slice(0, 8)} -> ${toTarget} (queued, target offline)`)
    }
    checkDelivered().catch(() => {
      ctx.reply({ type: 'channel_send_result', ok: true, conversationId, status: 'queued' })
    })
    return
  }

  if (!toSess || !toSession) {
    ctx.reply({
      type: 'channel_send_result',
      ok: false,
      error: 'Target not found. Use list_sessions to discover current sessions.',
    })
    return
  }

  const fromProject =
    ctx.getProjectSettings(fromSess?.cwd || '')?.label || fromSess?.cwd?.split('/').pop() || fromSession.slice(0, 8)

  const linkStatus = ctx.sessions.checkProjectLink(fromSession, toSession)
  if (linkStatus === 'blocked') {
    ctx.reply({ type: 'channel_send_result', ok: false, error: 'Session has blocked your messages' })
    return
  }

  const conversationId = (data.conversationId as string) || `conv_${Date.now().toString(36)}`

  // Resolve sender ID from the RECEIVER's address book perspective.
  // `routable` matches what list_sessions would return for this sender,
  // so the recipient can pass `from_session` straight back as `to`.
  const { routable: fromSlug, project: fromProjectSlug } = computeSenderRoutableId(
    ctx,
    fromSess && { id: fromSess.id, cwd: fromSess.cwd, title: fromSess.title },
    toSess.cwd,
    fromProject,
  )

  const delivery = {
    type: 'channel_deliver',
    fromSession: fromSlug,
    fromProject: fromProjectSlug,
    intent: data.intent,
    message: data.message,
    context: data.context,
    conversationId,
  }

  const targetTrust = toSess.cwd ? ctx.getProjectSettings(toSess.cwd)?.trustLevel : undefined
  const fromTrust = fromSess?.cwd ? ctx.getProjectSettings(fromSess.cwd)?.trustLevel : undefined
  // Sister sessions = same CWD, different session IDs (worktrees, parallel headless runs, a PTY
  // and its spawned helper). Cross-project stays on the link-approval path so unexpected A<->B
  // chatter is surfaced to the user instead of being silently auto-linked.
  const isSisterSession = !!fromSess?.cwd && !!toSess.cwd && fromSess.cwd === toSess.cwd
  const isTrusted = isSisterSession || targetTrust === 'open' || fromTrust === 'benevolent'

  const effectiveLinkStatus =
    linkStatus === 'unknown' && isTrusted
      ? 'trusted'
      : linkStatus === 'unknown' && fromSess?.cwd && toSess.cwd && ctx.links.find(fromSess.cwd, toSess.cwd)
        ? 'persisted'
        : linkStatus

  if (effectiveLinkStatus === 'linked' || effectiveLinkStatus === 'persisted' || effectiveLinkStatus === 'trusted') {
    if (effectiveLinkStatus !== 'linked') {
      ctx.sessions.linkProjects(fromSession, toSession)
      ctx.log.debug(
        `[links] Auto-linked (${effectiveLinkStatus}): ${fromSession.slice(0, 8)} <-> ${toSession.slice(0, 8)}`,
      )
    }

    const targetWs = ctx.sessions.getSessionSocket(toSession)
    if (targetWs) {
      targetWs.send(JSON.stringify(delivery))
      ctx.reply({ type: 'channel_send_result', ok: true, conversationId, status: 'delivered' })

      const toProject =
        ctx.getProjectSettings(toSess.cwd)?.label || toSess.cwd.split('/').pop() || toSession.slice(0, 8)
      if (fromSess?.cwd && toSess.cwd) {
        ctx.links.touch(fromSess.cwd, toSess.cwd)
        ctx.logMessage({
          ts: Date.now(),
          from: { sessionId: fromSession, wrapperId: ctx.ws.data.wrapperId, cwd: fromSess.cwd, name: fromProject },
          to: { sessionId: toSession, cwd: toSess.cwd, name: toProject },
          intent: (data.intent as string) || 'notify',
          conversationId,
          preview: ((data.message as string) || '').slice(0, 200),
          fullLength: ((data.message as string) || '').length,
        })
      }
    } else {
      ctx.reply({
        type: 'channel_send_result',
        ok: false,
        error: 'Target session not connected. It may have restarted. Use list_sessions to resolve current IDs.',
      })
    }
  } else {
    ctx.sessions.queueProjectMessage(fromSession, toSession, delivery)
    const toProject = ctx.getProjectSettings(toSess.cwd)?.label || toSess.cwd.split('/').pop() || toSession.slice(0, 8)
    ctx.broadcast({
      type: 'channel_link_request',
      fromSession,
      fromProject,
      toSession,
      toProject,
    })
    ctx.reply({ type: 'channel_send_result', ok: true, conversationId, status: 'queued' })
  }
  ctx.log.debug(
    `[inter-session] ${fromSession.slice(0, 8)} -> ${toSession.slice(0, 8)}: ${data.intent} (${linkStatus})`,
  )
}

// ─── Quit session relay (dashboard -> wrapper) ─────────────────────

const quitSession: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const session = sessionId ? ctx.sessions.getSession(sessionId) : undefined
  if (session) ctx.requirePermission('chat', session.cwd)
  const targetWs = sessionId ? ctx.sessions.getSessionSocket(sessionId) : null
  if (targetWs) {
    targetWs.send(JSON.stringify({ type: 'terminate_session', sessionId }))
    ctx.log.debug(`Session ${sessionId.slice(0, 8)} - SIGTERM sent to wrapper`)
  }
}

// ─── Session viewed (clear notification badge) ────────────────────

const sessionViewed: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  if (!sessionId) return
  const session = ctx.sessions.getSession(sessionId)
  if (session) ctx.requirePermission('chat:read', session.cwd)
  if (session?.hasNotification) {
    session.hasNotification = false
    ctx.sessions.broadcastSessionUpdate(sessionId)
  }
}

// ─── Link management (dashboard actions) ───────────────────────────

const channelLinkResponse: MessageHandler = (ctx, data) => {
  const fromSession = data.fromSession as string
  const toSession = data.toSession as string
  if (!fromSession || !toSession) return

  // Link approval creates persistent project-level trust -- require settings on BOTH projects
  const fromSess = ctx.sessions.getSession(fromSession)
  const toSess = ctx.sessions.getSession(toSession)
  if (!fromSess || !toSess) {
    ctx.reply({ type: 'error', error: 'Both sessions must exist to approve/block a link' })
    return
  }
  ctx.requirePermission('settings', fromSess.cwd)
  ctx.requirePermission('settings', toSess.cwd)

  if (data.action === 'approve') {
    ctx.sessions.linkProjects(fromSession, toSession)
    const fromSess = ctx.sessions.getSession(fromSession)
    const toSess = ctx.sessions.getSession(toSession)
    if (fromSess?.cwd && toSess?.cwd) ctx.links.add(fromSess.cwd, toSess.cwd)
    const queued = ctx.sessions.drainProjectMessages(fromSession, toSession)
    const targetWs = ctx.sessions.getSessionSocket(toSession)
    if (targetWs) {
      for (const msg of queued) targetWs.send(JSON.stringify(msg))
    }
    ctx.log.debug(`Link approved + persisted: ${fromSession.slice(0, 8)} <-> ${toSession.slice(0, 8)}`)
  } else {
    ctx.sessions.blockProject(fromSession, toSession)
    const fromSess = ctx.sessions.getSession(fromSession)
    const toSess = ctx.sessions.getSession(toSession)
    if (fromSess?.cwd && toSess?.cwd) ctx.links.remove(fromSess.cwd, toSess.cwd)
    ctx.sessions.drainProjectMessages(fromSession, toSession) // discard
    ctx.log.debug(`Link blocked: ${fromSession.slice(0, 8)} X ${toSession.slice(0, 8)}`)
  }
}

const channelUnlink: MessageHandler = (ctx, data) => {
  // CWD-based path (preferred -- projects are the linked entity)
  const cwdA = data.cwdA as string | undefined
  const cwdB = data.cwdB as string | undefined
  if (cwdA && cwdB) {
    ctx.requirePermission('settings', cwdA)
    ctx.requirePermission('settings', cwdB)
    ctx.sessions.unlinkProjectsByCwd(cwdA, cwdB)
    ctx.links.remove(cwdA, cwdB)
    ctx.sessions.broadcastForProjectCwd(cwdA)
    ctx.sessions.broadcastForProjectCwd(cwdB)
    ctx.log.debug(`Link severed (CWD): ${cwdA.split('/').pop()} X ${cwdB.split('/').pop()}`)
    return
  }
  // Legacy session-ID path
  const sessionA = data.sessionA as string
  const sessionB = data.sessionB as string
  if (!sessionA || !sessionB) return
  const sessA = ctx.sessions.getSession(sessionA)
  const sessB = ctx.sessions.getSession(sessionB)
  if (!sessA || !sessB) {
    ctx.reply({ type: 'error', error: 'Both sessions must exist to sever a link' })
    return
  }
  ctx.requirePermission('settings', sessA.cwd)
  ctx.requirePermission('settings', sessB.cwd)
  ctx.sessions.unlinkProjects(sessionA, sessionB)
  if (sessA.cwd && sessB.cwd) ctx.links.remove(sessA.cwd, sessB.cwd)
  ctx.sessions.broadcastSessionUpdate(sessionA)
  ctx.sessions.broadcastSessionUpdate(sessionB)
  ctx.log.debug(`Link severed: ${sessionA.slice(0, 8)} X ${sessionB.slice(0, 8)}`)
}

export function registerChannelHandlers(): void {
  registerHandlers({
    // Dashboard
    subscribe,
    refresh_sessions: refreshSessions,
    sync_check: syncCheck,
    // Channel subscriptions
    channel_subscribe: channelSubscribe,
    channel_unsubscribe: channelUnsubscribe,
    channel_unsubscribe_all: channelUnsubscribeAll,
    // Session discovery
    channel_list_sessions: channelListSessions,
    // Inter-session messaging
    channel_send: channelSend,
    // Session terminate relay
    terminate_session: quitSession,
    quit_session: quitSession, // deprecated alias
    // Notification badge
    session_viewed: sessionViewed,
    // Link management
    channel_link_response: channelLinkResponse,
    channel_unlink: channelUnlink,
  })
}
