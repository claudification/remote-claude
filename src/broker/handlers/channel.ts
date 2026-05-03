/**
 * Channel handlers: inter-conversation messaging, session discovery, link management,
 * channel subscriptions, dashboard subscriptions, and session quit relay.
 */

import { extractProjectLabel, isSameProject, parseProjectUri } from '../../shared/project-uri'
import type { SubscriptionChannel } from '../../shared/protocol'
import { slugify } from '../address-book'
import { getUser } from '../auth'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'
import { resolvePermissionFlags } from '../permissions'
import { computeLocalId, formatAmbiguityError, resolveSendTarget } from './channel-id'

// ─── Dashboard subscription ────────────────────────────────────────

const subscribe: MessageHandler = (ctx, data) => {
  ctx.ws.data.isControlPanel = true
  const pv = (data.protocolVersion as number) || 1
  ctx.conversations.addSubscriber(ctx.ws, pv)
  ctx.reply({ type: 'sentinel_status', connected: ctx.conversations.hasSentinel() })

  // Push current usage data if available
  const usage = ctx.conversations.getUsage()
  if (usage) {
    ctx.reply({ type: 'usage_update', usage })
  }

  // Push resolved permissions to client (server owns grant resolution)
  const grants = ctx.ws.data.grants
  if (grants) {
    const user = ctx.ws.data.userName ? getUser(ctx.ws.data.userName) : undefined
    const serverRoles = user?.serverRoles
    // Global permissions (project='*')
    const global = resolvePermissionFlags(grants, '*', serverRoles)
    // Per-session permissions (resolved against each conversation's project)
    const sessions: Record<string, ReturnType<typeof resolvePermissionFlags>> = {}
    for (const s of ctx.conversations.getActiveConversations()) {
      sessions[s.id] = resolvePermissionFlags(grants, s.project, serverRoles)
    }
    ctx.reply({ type: 'permissions', global, sessions })
  }

  // Push initial shares state to admin subscribers
  ctx.conversations.broadcastSharesUpdate()

  // Push any pending dialogs + plan approvals (reconnect recovery)
  for (const s of ctx.conversations.getActiveConversations()) {
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

  ctx.log.debug(`Subscriber connected (v${pv}, total: ${ctx.conversations.getSubscriberCount()})`)
}

const refreshSessions: MessageHandler = ctx => {
  ctx.conversations.sendConversationsList(ctx.ws)
}

const syncCheck: MessageHandler = (ctx, data) => {
  // handleSyncCheck logs request + response in one line
  ctx.conversations.handleSyncCheck(
    ctx.ws,
    (data.epoch as string) || '',
    (data.lastSeq as number) || 0,
    data.transcripts as Record<string, number> | undefined,
  )
}

// ─── Channel subscriptions (per-conversation event streams) ─────────────

const channelSubscribe: MessageHandler = (ctx, data) => {
  const channel = data.channel as SubscriptionChannel
  const conversationId = (data.conversationId || data.sessionId) as string
  const agentId = data.agentId as string | undefined
  if (!channel || !conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) ctx.requirePermission('chat:read', conversation.project)
  ctx.conversations.subscribeChannel(ctx.ws, channel, conversationId, agentId)
  ctx.reply({ type: 'channel_ack', channel, sessionId: conversationId, agentId, status: 'subscribed' })
  ctx.log.debug(`[channel] ${channel}:${conversationId.slice(0, 8)}${agentId ? `:${agentId.slice(0, 8)}` : ''} +sub`)
}

const channelUnsubscribe: MessageHandler = (ctx, data) => {
  const channel = data.channel as SubscriptionChannel
  const conversationId = (data.conversationId || data.sessionId) as string
  const agentId = data.agentId as string | undefined
  if (!channel || !conversationId) return
  ctx.conversations.unsubscribeChannel(ctx.ws, channel, conversationId, agentId)
  ctx.reply({ type: 'channel_ack', channel, sessionId: conversationId, agentId, status: 'unsubscribed' })
  ctx.log.debug(`[channel] ${channel}:${conversationId.slice(0, 8)}${agentId ? `:${agentId.slice(0, 8)}` : ''} -sub`)
}

const channelUnsubscribeAll: MessageHandler = ctx => {
  ctx.conversations.unsubscribeAllChannels(ctx.ws)
  ctx.log.debug('[channel] unsubscribed all')
}

// ─── Session discovery (list_sessions) ─────────────────────────────

const channelListSessions: MessageHandler = (ctx, data) => {
  const status = (data.status as string) || 'live'
  const showMetadata = !!data.show_metadata
  const callerSession = ctx.ws.data.conversationId
  const callerProject = ctx.caller?.project
  const isBenevolent = ctx.callerSettings?.trustLevel === 'benevolent'
  const all = Array.from(ctx.conversations.getAllConversations())

  // Filter by status and exclude self
  const filtered = all
    .filter(s => {
      if (status === 'all') return true
      const isLive = ctx.conversations.getActiveConversationCount(s.id) > 0
      return status === 'live' ? isLive : !isLive
    })
    .filter(s => s.id !== callerSession)
    .filter(s => {
      // Hide ad-hoc sessions unless they have an established link with the caller
      const isAdHoc = s.capabilities?.includes('ad-hoc')
      if (!isAdHoc) return true
      if (!callerSession) return false
      const linkStatus = ctx.conversations.checkProjectLink(callerSession, s.id)
      return linkStatus === 'linked'
    })

  // Group sessions by project to detect multi-session projects
  const projectGroups = new Map<string, typeof filtered>()
  for (const s of filtered) {
    const group = projectGroups.get(s.project) || []
    group.push(s)
    projectGroups.set(s.project, group)
  }

  const result = filtered.map(s => {
    const linkStatus = callerSession ? ctx.conversations.checkProjectLink(callerSession, s.id) : 'unknown'
    const isLinked = linkStatus === 'linked'
    const showFull = isBenevolent || isLinked
    const shortProject = extractProjectLabel(s.project)
    const projSettings = ctx.getProjectSettings(s.project)
    const sessionName = s.title || projSettings?.label || extractProjectLabel(s.project)
    const isLive = ctx.conversations.getActiveConversationCount(s.id) > 0
    const queueSize = ctx.messageQueue.getQueueSize(s.project)

    // Assign a stable project-level slug via the caller's address book.
    // Slug is derived from the PROJECT (label or dirname), never the conversation title --
    // multiple sessions can share a project; the project identity must not depend on
    // whichever session happened to register first.
    const projectName = projSettings?.label || extractProjectLabel(s.project)
    const projectSlug = callerProject
      ? ctx.addressBook.getOrAssign(callerProject, s.project, projectName)
      : slugify(projectName)

    // ALWAYS compound `project:session-slug` -- bare ids would silently flip
    // shape when a second session spawns at the same project. See channel-id.ts.
    const projGroup = projectGroups.get(s.project) || [s]
    const localId = computeLocalId(s, projectSlug, projGroup)

    return {
      id: localId, // stable local address (use for send_message, etc.)
      project: projectSlug, // project-level grouping ID
      session_id: s.id,
      name: sessionName,
      projectUri: s.project,
      cwd: showFull ? parseProjectUri(s.project).path : shortProject, // backward compat for MCP consumers
      status: (isLive ? 'live' : 'inactive') as 'live' | 'inactive',
      capabilities: s.capabilities,
      ...(projSettings?.label && projSettings.label !== sessionName ? { label: projSettings.label } : {}),
      ...(s.description ? { description: s.description } : {}),
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
  // Build self identity from caller's session
  let self: Record<string, unknown> | undefined
  if (callerSession) {
    const s = ctx.conversations.getConversation(callerSession)
    if (s) {
      const projSettings = ctx.getProjectSettings(s.project)
      const projectName = projSettings?.label || extractProjectLabel(s.project)
      const projectSlug = callerProject
        ? ctx.addressBook.getOrAssign(callerProject, s.project, projectName)
        : slugify(projectName)
      const allAtProject = all.filter(x => isSameProject(x.project, s.project))
      const localId = computeLocalId(s, projectSlug, allAtProject)
      self = {
        id: localId,
        project: projectSlug,
        session_id: s.id,
        name: s.title || projSettings?.label || extractProjectLabel(s.project),
        projectUri: s.project,
        cwd: parseProjectUri(s.project).path, // backward compat for MCP consumers
        model: s.configuredModel || s.model,
        permissionMode: s.permissionMode,
        effortLevel: s.effortLevel,
        status: 'live' as const,
      }
    }
  }

  ctx.reply({ type: 'channel_sessions_list', sessions: result, self })
}

// ─── Inter-session messaging (channel_send) ────────────────────────

/**
 * Compute the sender's routable ID from the receiver's perspective.
 *
 * Must match the ID shape produced by `list_sessions` so a recipient can
 * pass `from_session` straight back as `to` without a round-trip through
 * list_sessions. When the sender's project hosts multiple sessions, the ID
 * is compounded `project:session-slug` -- bare project slugs would be
 * ambiguous and rejected by the send resolver.
 */
function computeSenderRoutableId(
  ctx: Parameters<MessageHandler>[0],
  fromSess: { id: string; project: string; title?: string } | undefined,
  toProject: string | undefined,
  fromProjectName: string,
): { routable: string; project: string } {
  if (!fromSess?.project || !toProject) {
    const fallback = fromSess?.id || slugify(fromProjectName)
    return { routable: fallback, project: fallback }
  }
  const projectSlug = ctx.addressBook.getOrAssign(toProject, fromSess.project, fromProjectName)
  const sessionsAtProject = Array.from(ctx.conversations.getAllConversations()).filter(s =>
    isSameProject(s.project, fromSess.project),
  )
  // Always compound -- list_sessions must be able to round-trip the from-id.
  const projGroup = sessionsAtProject.length > 0 ? sessionsAtProject : [fromSess]
  return { routable: computeLocalId(fromSess, projectSlug, projGroup), project: projectSlug }
}

const channelSend: MessageHandler = (ctx, data) => {
  const fromSession = ctx.ws.data.conversationId || (data.fromSession as string)
  const toTarget = data.toSession as string
  if (!fromSession || !toTarget) return

  const fromSess = ctx.conversations.getConversation(fromSession)
  const callerProject = fromSess?.project

  // Parse compound target: "project:session-name" or bare "project"
  const colonIdx = toTarget.indexOf(':')
  const projectSlug = colonIdx >= 0 ? toTarget.slice(0, colonIdx) : toTarget
  const sessionSlug = colonIdx >= 0 ? toTarget.slice(colonIdx + 1) : undefined

  // Resolve target: address book first, auto-populate on miss, then raw ID fallback
  let targetProject = callerProject ? ctx.addressBook.resolve(callerProject, projectSlug) : undefined

  // Address book miss -- populate from all known sessions (same as list_sessions),
  // then retry. This makes send_message work on first call without a prior list_sessions.
  if (!targetProject && callerProject) {
    for (const s of ctx.conversations.getAllConversations()) {
      if (s.id === fromSession) continue
      const projSettings = ctx.getProjectSettings(s.project)
      const projectName = projSettings?.label || extractProjectLabel(s.project)
      ctx.addressBook.getOrAssign(callerProject, s.project, projectName)
    }
    targetProject = ctx.addressBook.resolve(callerProject, projectSlug)
  }

  let toSess: ReturnType<typeof ctx.conversations.getConversation> | undefined
  if (targetProject) {
    const sessionsAtProject = Array.from(ctx.conversations.getAllConversations()).filter(s =>
      isSameProject(s.project, targetProject),
    )
    const projSettings = ctx.getProjectSettings(targetProject)
    const canonicalProject = slugify(projSettings?.label || extractProjectLabel(targetProject))
    const resolved = resolveSendTarget({
      projectSlug,
      sessionSlug,
      sessionsAtProject,
      canonicalProject,
      isLive: s => ctx.conversations.getActiveConversationCount(s.id) > 0,
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
      toSess = ctx.conversations.getConversation(resolved.session.id)
    }
  } else {
    toSess = ctx.conversations.findConversationByConversationId(toTarget) || ctx.conversations.getConversation(toTarget)
  }

  const toSession = toSess?.id

  // If we resolved a project but no active conversations, queue for offline delivery
  if (targetProject && !toSess) {
    const fromProjectName =
      ctx.getProjectSettings(callerProject || '')?.label ||
      (callerProject ? extractProjectLabel(callerProject) : fromSession.slice(0, 8))
    // Resolve sender ID from receiver's address book perspective (works even when target is offline).
    // `routable` is a list_sessions-compatible ID the recipient can pass straight back as `to`;
    // `project` is the bare project slug for grouping/context.
    const { routable: fromSlug, project: fromProjectSlug } = computeSenderRoutableId(
      ctx,
      fromSess && { id: fromSess.id, project: fromSess.project, title: fromSess.title },
      targetProject,
      fromProjectName,
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
    ctx.messageQueue.enqueue(targetProject, callerProject || '', fromProjectName, delivery, sessionSlug)

    // Brief wait: if target reconnects within 1s, the queue drains automatically
    // and we can report 'delivered' instead of 'queued'
    async function checkDelivered() {
      for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 250))
        // biome-ignore lint/style/noNonNullAssertion: guaranteed non-null by enclosing if (targetProject) block
        if (ctx.messageQueue.getQueueSize(targetProject!) === 0) {
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

  const fromProjectName =
    ctx.getProjectSettings(fromSess?.project || '')?.label ||
    (fromSess?.project ? extractProjectLabel(fromSess.project) : fromSession.slice(0, 8))

  const linkStatus = ctx.conversations.checkProjectLink(fromSession, toSession)
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
    fromSess && { id: fromSess.id, project: fromSess.project, title: fromSess.title },
    toSess.project,
    fromProjectName,
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

  const targetTrust = toSess.project ? ctx.getProjectSettings(toSess.project)?.trustLevel : undefined
  const fromTrust = fromSess?.project ? ctx.getProjectSettings(fromSess.project)?.trustLevel : undefined
  // Sister sessions = same project, different session IDs (worktrees, parallel headless runs, a PTY
  // and its spawned helper). Cross-project stays on the link-approval path so unexpected A<->B
  // chatter is surfaced to the user instead of being silently auto-linked.
  const isSisterSession = !!fromSess?.project && !!toSess.project && isSameProject(fromSess.project, toSess.project)
  const isTrusted = isSisterSession || targetTrust === 'open' || fromTrust === 'benevolent'

  const effectiveLinkStatus =
    linkStatus === 'unknown' && isTrusted
      ? 'trusted'
      : linkStatus === 'unknown' &&
          fromSess?.project &&
          toSess.project &&
          ctx.links.find(fromSess.project, toSess.project)
        ? 'persisted'
        : linkStatus

  if (effectiveLinkStatus === 'linked' || effectiveLinkStatus === 'persisted' || effectiveLinkStatus === 'trusted') {
    if (effectiveLinkStatus !== 'linked') {
      ctx.conversations.linkProjects(fromSession, toSession)
      ctx.log.debug(
        `[links] Auto-linked (${effectiveLinkStatus}): ${fromSession.slice(0, 8)} <-> ${toSession.slice(0, 8)}`,
      )
    }

    const targetWs = ctx.conversations.getConversationSocket(toSession)
    if (targetWs) {
      targetWs.send(JSON.stringify(delivery))
      ctx.reply({
        type: 'channel_send_result',
        ok: true,
        conversationId,
        status: 'delivered',
        targetSessionId: toSession,
      })

      const toProjectName = ctx.getProjectSettings(toSess.project)?.label || extractProjectLabel(toSess.project)
      if (fromSess?.project && toSess.project) {
        ctx.links.touch(fromSess.project, toSess.project)
        ctx.logMessage({
          ts: Date.now(),
          from: {
            conversationId: fromSession,
            project: fromSess.project,
            name: fromProjectName,
          },
          to: { conversationId: toSession, project: toSess.project, name: toProjectName },
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
    ctx.conversations.queueProjectMessage(fromSession, toSession, delivery)
    const toProjectName = ctx.getProjectSettings(toSess.project)?.label || extractProjectLabel(toSess.project)
    ctx.broadcast({
      type: 'channel_link_request',
      fromSession,
      fromProject: fromProjectName,
      toSession,
      toProject: toProjectName,
    })
    ctx.reply({ type: 'channel_send_result', ok: true, conversationId, status: 'queued', targetSessionId: toSession })
  }
  ctx.log.debug(
    `[inter-session] ${fromSession.slice(0, 8)} -> ${toSession.slice(0, 8)}: ${data.intent} (${linkStatus})`,
  )
}

// ─── Quit session relay (dashboard -> wrapper) ─────────────────────

const quitConversation: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.sessionId) as string
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  if (conversation) ctx.requirePermission('chat', conversation.project)
  const targetWs = conversationId ? ctx.conversations.getConversationSocket(conversationId) : null
  if (targetWs) {
    targetWs.send(JSON.stringify({ type: 'terminate_conversation', sessionId: conversationId }))
    ctx.log.debug(`Conversation ${conversationId.slice(0, 8)} - SIGTERM sent to wrapper`)
  }
}

// ─── Session viewed (clear notification badge) ────────────────────

const sessionViewed: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.sessionId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) ctx.requirePermission('chat:read', conversation.project)
  if (conversation?.hasNotification) {
    conversation.hasNotification = false
    ctx.conversations.broadcastConversationUpdate(conversationId)
  }
}

// ─── Link management (dashboard actions) ───────────────────────────

const channelLinkResponse: MessageHandler = (ctx, data) => {
  const fromSession = data.fromSession as string
  const toSession = data.toSession as string
  if (!fromSession || !toSession) return

  // Link approval creates persistent project-level trust -- require settings on BOTH projects
  const fromSess = ctx.conversations.getConversation(fromSession)
  const toSess = ctx.conversations.getConversation(toSession)
  if (!fromSess || !toSess) {
    ctx.reply({ type: 'error', error: 'Both sessions must exist to approve/block a link' })
    return
  }
  ctx.requirePermission('settings', fromSess.project)
  ctx.requirePermission('settings', toSess.project)

  if (data.action === 'approve') {
    ctx.conversations.linkProjects(fromSession, toSession)
    const fromSess = ctx.conversations.getConversation(fromSession)
    const toSess = ctx.conversations.getConversation(toSession)
    if (fromSess?.project && toSess?.project) ctx.links.add(fromSess.project, toSess.project)
    const queued = ctx.conversations.drainProjectMessages(fromSession, toSession)
    const targetWs = ctx.conversations.getConversationSocket(toSession)
    if (targetWs) {
      for (const msg of queued) targetWs.send(JSON.stringify(msg))
    }
    ctx.log.debug(`Link approved + persisted: ${fromSession.slice(0, 8)} <-> ${toSession.slice(0, 8)}`)
  } else {
    ctx.conversations.blockProject(fromSession, toSession)
    const fromSess = ctx.conversations.getConversation(fromSession)
    const toSess = ctx.conversations.getConversation(toSession)
    if (fromSess?.project && toSess?.project) ctx.links.remove(fromSess.project, toSess.project)
    ctx.conversations.drainProjectMessages(fromSession, toSession) // discard
    ctx.log.debug(`Link blocked: ${fromSession.slice(0, 8)} X ${toSession.slice(0, 8)}`)
  }
}

const channelUnlink: MessageHandler = (ctx, data) => {
  // Project-based path (preferred -- projects are the linked entity)
  const projectA = (data.projectA as string | undefined) ?? (data.cwdA as string | undefined)
  const projectB = (data.projectB as string | undefined) ?? (data.cwdB as string | undefined)
  if (projectA && projectB) {
    ctx.requirePermission('settings', projectA)
    ctx.requirePermission('settings', projectB)
    ctx.conversations.unlinkProjects(projectA, projectB)
    ctx.links.remove(projectA, projectB)
    ctx.conversations.broadcastForProject(projectA)
    ctx.conversations.broadcastForProject(projectB)
    ctx.log.debug(`Link severed: ${extractProjectLabel(projectA)} X ${extractProjectLabel(projectB)}`)
    return
  }
  // Legacy session-ID path
  const sessionA = data.sessionA as string
  const sessionB = data.sessionB as string
  if (!sessionA || !sessionB) return
  const sessA = ctx.conversations.getConversation(sessionA)
  const sessB = ctx.conversations.getConversation(sessionB)
  if (!sessA || !sessB) {
    ctx.reply({ type: 'error', error: 'Both sessions must exist to sever a link' })
    return
  }
  ctx.requirePermission('settings', sessA.project)
  ctx.requirePermission('settings', sessB.project)
  ctx.conversations.unlinkProjects(sessionA, sessionB)
  if (sessA.project && sessB.project) ctx.links.remove(sessA.project, sessB.project)
  ctx.conversations.broadcastConversationUpdate(sessionA)
  ctx.conversations.broadcastConversationUpdate(sessionB)
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
    // Conversation terminate relay
    terminate_conversation: quitConversation,
    terminate_session: quitConversation, // backward compat
    quit_session: quitConversation, // backward compat
    // Notification badge
    conversation_viewed: sessionViewed,
    session_viewed: sessionViewed, // backward compat
    // Link management
    channel_link_response: channelLinkResponse,
    channel_unlink: channelUnlink,
  })
}
