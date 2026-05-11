/**
 * Channel handlers: inter-conversation messaging, session discovery, link management,
 * channel subscriptions, dashboard subscriptions, and conversation quit relay.
 */

import { deriveModelName } from '../../shared/models'
import { cwdToProjectUri, extractProjectLabel, isSameProject, parseProjectUri } from '../../shared/project-uri'
import type { SubscriptionChannel } from '../../shared/protocol'
import { slugify } from '../address-book'
import { getUser } from '../auth'
import type { MessageHandler } from '../handler-context'
import { AGENT_HOST_ONLY, DASHBOARD_ROLES, registerHandlers } from '../message-router'
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

  // Push external status data if available (clanker.watch + usage.report)
  const health = ctx.conversations.getClaudeHealth()
  if (health) ctx.reply(health as unknown as Record<string, unknown>)
  const efficiency = ctx.conversations.getClaudeEfficiency()
  if (efficiency) ctx.reply(efficiency as unknown as Record<string, unknown>)

  // Push resolved permissions to client (server owns grant resolution)
  const grants = ctx.ws.data.grants
  if (grants) {
    const user = ctx.ws.data.userName ? getUser(ctx.ws.data.userName) : undefined
    const serverRoles = user?.serverRoles
    // Global permissions (project='*')
    const global = resolvePermissionFlags(grants, '*', serverRoles)
    // Per-conversation permissions (resolved against each conversation's project)
    const perConversation: Record<string, ReturnType<typeof resolvePermissionFlags>> = {}
    for (const s of ctx.conversations.getActiveConversations()) {
      perConversation[s.id] = resolvePermissionFlags(grants, s.project, serverRoles)
    }
    ctx.reply({ type: 'permissions', global, conversations: perConversation })
  }

  // Push initial shares state to admin subscribers
  ctx.conversations.broadcastSharesUpdate()

  // Push any pending dialogs + plan approvals (reconnect recovery)
  for (const s of ctx.conversations.getActiveConversations()) {
    if (s.pendingDialog) {
      ctx.reply({
        type: 'dialog_show',
        conversationId: s.id,
        dialogId: s.pendingDialog.dialogId,
        layout: s.pendingDialog.layout,
      })
    }
    if (s.pendingPlanApproval) {
      ctx.reply({
        type: 'plan_approval',
        conversationId: s.id,
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
        conversationId: s.id,
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
        conversationId: s.id,
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
  const conversationId = data.conversationId as string
  const agentId = data.agentId as string | undefined
  if (!channel || !conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) ctx.requirePermission('chat:read', conversation.project)
  ctx.conversations.subscribeChannel(ctx.ws, channel, conversationId, agentId)
  ctx.reply({ type: 'channel_ack', channel, conversationId, agentId, status: 'subscribed' })
  ctx.log.debug(`[channel] ${channel}:${conversationId.slice(0, 8)}${agentId ? `:${agentId.slice(0, 8)}` : ''} +sub`)
}

const channelUnsubscribe: MessageHandler = (ctx, data) => {
  const channel = data.channel as SubscriptionChannel
  const conversationId = data.conversationId as string
  const agentId = data.agentId as string | undefined
  if (!channel || !conversationId) return
  ctx.conversations.unsubscribeChannel(ctx.ws, channel, conversationId, agentId)
  ctx.reply({ type: 'channel_ack', channel, conversationId, agentId, status: 'unsubscribed' })
  ctx.log.debug(`[channel] ${channel}:${conversationId.slice(0, 8)}${agentId ? `:${agentId.slice(0, 8)}` : ''} -sub`)
}

const channelUnsubscribeAll: MessageHandler = ctx => {
  ctx.conversations.unsubscribeAllChannels(ctx.ws)
  ctx.log.debug('[channel] unsubscribed all')
}

// ─── Session discovery (list_conversations) ─────────────────────────────

const channelListSessions: MessageHandler = (ctx, data) => {
  const status = (data.status as string) || 'live'
  const showMetadata = !!data.show_metadata
  const callerSession = ctx.ws.data.conversationId
  const callerProject = ctx.caller?.project
  const isBenevolent = ctx.callerSettings?.trustLevel === 'benevolent'
  const all = Array.from(ctx.conversations.getAllConversations())

  // Filter by status (include self, annotated later)
  const filtered = all
    .filter(s => {
      if (status === 'all') return true
      const isLive = ctx.conversations.getActiveConversationCount(s.id) > 0
      return status === 'live' ? isLive : !isLive
    })
    .filter(s => {
      // Hide ad-hoc conversations unless they have an established link with the caller
      const isAdHoc = s.capabilities?.includes('ad-hoc')
      if (!isAdHoc) return true
      if (!callerSession) return false
      const linkStatus = ctx.conversations.checkProjectLink(callerSession, s.id)
      return linkStatus === 'linked'
    })

  // Group conversations by project to detect multi-conversation projects
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
    // multiple conversations can share a project; the project identity must not depend on
    // whichever conversation happened to register first.
    const projectName = projSettings?.label || extractProjectLabel(s.project)
    const projectSlug = callerProject
      ? ctx.addressBook.getOrAssign(callerProject, s.project, projectName)
      : slugify(projectName)

    // ALWAYS compound `project:conversation-slug` -- bare ids would silently flip
    // shape when a second conversation spawns at the same project. See channel-id.ts.
    const projGroup = projectGroups.get(s.project) || [s]
    const localId = computeLocalId(s, projectSlug, projGroup)

    const isSelf = s.id === callerSession

    return {
      id: localId, // stable local address (use for send_message, etc.)
      project: projectSlug, // project-level grouping ID
      conversation_id: s.id,
      name: sessionName,
      projectUri: s.project,
      cwd: showFull || isSelf ? parseProjectUri(s.project).path : shortProject, // backward compat for MCP consumers
      status: (isLive ? 'live' : 'inactive') as 'live' | 'inactive',
      capabilities: s.capabilities,
      ...(isSelf
        ? {
            self: true,
            model: deriveModelName(s.model, s.configuredModel),
            permissionMode: s.permissionMode,
            effortLevel: s.effortLevel,
          }
        : {}),
      ...(projSettings?.label && projSettings.label !== sessionName ? { label: projSettings.label } : {}),
      ...(s.description ? { description: s.description } : {}),
      link: isSelf ? undefined : isLinked ? 'connected' : linkStatus === 'blocked' ? 'blocked' : undefined,
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
  // Build self identity from caller's conversation
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
        conversation_id: s.id,
        name: s.title || projSettings?.label || extractProjectLabel(s.project),
        projectUri: s.project,
        cwd: parseProjectUri(s.project).path, // backward compat for MCP consumers
        model: deriveModelName(s.model, s.configuredModel),
        permissionMode: s.permissionMode,
        effortLevel: s.effortLevel,
        status: 'live' as const,
      }
    }
  }

  // Surface in-flight spawn jobs as `status: "spawning"` rows so callers don't
  // hit a discovery gap between spawn dispatch and agent host boot. The full
  // Conversation row only exists once `agent_host_boot` lands; this synthetic
  // entry fills the window. Spawning entries appear under `live` and `all`
  // status filters; the `inactive` filter excludes them.
  const activeJobs = status === 'inactive' ? [] : ctx.conversations.listActiveSpawnJobs()
  const knownIds = new Set(all.map(s => s.id))
  for (const job of activeJobs) {
    if (knownIds.has(job.conversationId)) continue // already a real row
    const cfg = (job.config ?? {}) as { cwd?: string; name?: string }
    const rawCwd = typeof cfg.cwd === 'string' ? cfg.cwd : ''
    const project = rawCwd.includes('://') ? rawCwd : rawCwd.startsWith('/') ? cwdToProjectUri(rawCwd) : ''
    const sessionName = typeof cfg.name === 'string' && cfg.name ? cfg.name : `spawning-${job.jobId.slice(0, 6)}`
    const projSettings = project ? ctx.getProjectSettings(project) : null
    const projectName = projSettings?.label || (project ? extractProjectLabel(project) : 'unknown')
    const projectSlug =
      callerProject && project ? ctx.addressBook.getOrAssign(callerProject, project, projectName) : slugify(projectName)
    // Compute compound id against the live conversations at the same project
    // plus this synthetic entry, so collisions disambiguate against siblings.
    const projGroup = filtered.filter(s => isSameProject(s.project, project))
    const target = { id: job.conversationId, project, title: sessionName }
    const localId = computeLocalId(target, projectSlug, [...projGroup, target])
    result.push({
      id: localId,
      project: projectSlug,
      conversation_id: job.conversationId,
      name: sessionName,
      projectUri: project || 'pending',
      cwd: project ? parseProjectUri(project).path : '(pending)',
      status: 'spawning',
      capabilities: undefined,
      title: sessionName,
      summary: undefined,
      link: undefined,
      spawnJobId: job.jobId,
      spawnStep: job.lastStep ?? undefined,
    } as unknown as (typeof result)[number])
  }

  ctx.reply({ type: 'channel_conversations_list', conversations: result, self })
}

// ─── Inter-conversation messaging (channel_send) ────────────────────────

/**
 * Compute the sender's routable ID from the receiver's perspective.
 *
 * Must match the ID shape produced by `list_conversations` so a recipient can
 * pass `from_session` straight back as `to` without a round-trip through
 * list_conversations. When the sender's project hosts multiple sessions, the ID
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
  const conversationsAtProject = Array.from(ctx.conversations.getAllConversations()).filter(s =>
    isSameProject(s.project, fromSess.project),
  )
  // Always compound -- list_conversations must be able to round-trip the from-id.
  const projGroup = conversationsAtProject.length > 0 ? conversationsAtProject : [fromSess]
  return { routable: computeLocalId(fromSess, projectSlug, projGroup), project: projectSlug }
}

/**
 * Match a `to` target (raw conversationId, compound `project:name`, or bare
 * `project`) against any in-flight spawn job. Used by send_message to QUEUE
 * messages for not-yet-booted workers instead of hard-erroring with
 * "Target not found". The matched job's `cwd` becomes the queue key.
 */
function findPendingSpawnTarget(
  ctx: Parameters<MessageHandler>[0],
  toTarget: string,
): { jobId: string; project: string; name: string } | null {
  const colonIdx = toTarget.indexOf(':')
  const projSlug = colonIdx >= 0 ? toTarget.slice(0, colonIdx) : toTarget
  const nameSlug = colonIdx >= 0 ? toTarget.slice(colonIdx + 1) : undefined

  const jobs = ctx.conversations.listActiveSpawnJobs()
  for (const job of jobs) {
    if (job.conversationId === toTarget) {
      const cfg = (job.config ?? {}) as { cwd?: string; name?: string }
      const cwd = typeof cfg.cwd === 'string' ? cfg.cwd : ''
      const project = cwd.includes('://') ? cwd : cwd.startsWith('/') ? cwdToProjectUri(cwd) : ''
      if (!project) continue
      return { jobId: job.jobId, project, name: cfg.name || `spawning-${job.jobId.slice(0, 6)}` }
    }
  }
  // Compound-id matching: project slug + name slug must both resolve to the job.
  for (const job of jobs) {
    const cfg = (job.config ?? {}) as { cwd?: string; name?: string }
    const cwd = typeof cfg.cwd === 'string' ? cfg.cwd : ''
    const project = cwd.includes('://') ? cwd : cwd.startsWith('/') ? cwdToProjectUri(cwd) : ''
    if (!project) continue
    const projSettings = ctx.getProjectSettings(project)
    const projectName = projSettings?.label || extractProjectLabel(project)
    const canonicalProject = slugify(projectName)
    const matchesProject = canonicalProject === projSlug
    if (!matchesProject) continue
    if (nameSlug) {
      const jobName = cfg.name || `spawning-${job.jobId.slice(0, 6)}`
      if (slugify(jobName) !== nameSlug && !slugify(jobName).startsWith(nameSlug)) continue
    }
    return { jobId: job.jobId, project, name: cfg.name || `spawning-${job.jobId.slice(0, 6)}` }
  }
  return null
}

const channelSend: MessageHandler = (ctx, data) => {
  const fromSession = ctx.ws.data.conversationId || (data.fromSession as string)
  const toTarget = data.toSession as string
  if (!fromSession || !toTarget) return

  const fromSess = ctx.conversations.getConversation(fromSession)
  const callerProject = fromSess?.project || ctx.caller?.project

  // Parse compound target: "project:conversation-name" or bare "project"
  const colonIdx = toTarget.indexOf(':')
  const projectSlug = colonIdx >= 0 ? toTarget.slice(0, colonIdx) : toTarget
  const conversationSlug = colonIdx >= 0 ? toTarget.slice(colonIdx + 1) : undefined

  // Resolve target: address book first, auto-populate on miss, then raw ID fallback
  let targetProject = callerProject ? ctx.addressBook.resolve(callerProject, projectSlug) : undefined

  // Address book miss -- populate from all known conversations (same as list_conversations),
  // then retry. This makes send_message work on first call without a prior list_conversations.
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
    const conversationsAtProject = Array.from(ctx.conversations.getAllConversations()).filter(s =>
      isSameProject(s.project, targetProject),
    )
    const projSettings = ctx.getProjectSettings(targetProject)
    const canonicalProject = slugify(projSettings?.label || extractProjectLabel(targetProject))
    const resolved = resolveSendTarget({
      projectSlug,
      conversationSlug,
      conversationsAtProject,
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
      toSess = ctx.conversations.getConversation(resolved.conversation.id)
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
    // `routable` is a list_conversations-compatible ID the recipient can pass straight back as `to`;
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
    ctx.messageQueue.enqueue(targetProject, callerProject || '', fromProjectName, delivery, conversationSlug)

    // Brief wait: if target reconnects within 1s, the queue drains automatically
    // and we can report 'delivered' instead of 'queued'
    async function checkDelivered() {
      for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 250))
        // biome-ignore lint/style/noNonNullAssertion: guaranteed non-null by enclosing if (targetProject) block
        if (ctx.messageQueue.getQueueSize(targetProject!) === 0) {
          ctx.reply({ type: 'channel_send_result', ok: true, conversationId, status: 'delivered' })
          ctx.log.debug(`[inter-conversation] ${fromSession.slice(0, 8)} -> ${toTarget} (queued then delivered)`)
          return
        }
      }
      ctx.reply({ type: 'channel_send_result', ok: true, conversationId, status: 'queued' })
      ctx.log.debug(`[inter-conversation] ${fromSession.slice(0, 8)} -> ${toTarget} (queued, target offline)`)
    }
    checkDelivered().catch(() => {
      ctx.reply({ type: 'channel_send_result', ok: true, conversationId, status: 'queued' })
    })
    return
  }

  if (!toSess || !toSession) {
    // Pre-boot fallback: if the target ID (raw or compound) matches an active
    // spawn job, queue the message against the future conversation's project.
    // The agent host will drain the queue on first connect via the normal
    // offline-delivery path.
    const pendingMatch = findPendingSpawnTarget(ctx, toTarget)
    if (pendingMatch) {
      const fromProjectName =
        ctx.getProjectSettings(callerProject || '')?.label ||
        (callerProject ? extractProjectLabel(callerProject) : fromSession.slice(0, 8))
      const { routable: fromSlug, project: fromProjectSlug } = computeSenderRoutableId(
        ctx,
        fromSess && { id: fromSess.id, project: fromSess.project, title: fromSess.title },
        pendingMatch.project,
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
      ctx.messageQueue.enqueue(pendingMatch.project, callerProject || '', fromProjectName, delivery, pendingMatch.name)
      ctx.reply({ type: 'channel_send_result', ok: true, conversationId, status: 'queued' })
      ctx.log.debug(
        `[inter-conversation] ${fromSession.slice(0, 8)} -> ${toTarget} (queued for spawning job ${pendingMatch.jobId.slice(0, 8)})`,
      )
      return
    }

    ctx.reply({
      type: 'channel_send_result',
      ok: false,
      error: 'Target not found. Use list_conversations to discover current sessions.',
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
  // `routable` matches what list_conversations would return for this sender,
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
  // Sister conversations = same project, different conversation IDs (worktrees, parallel headless runs, a PTY
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
        error:
          'Target conversation not connected. It may have restarted. Use list_conversations to resolve current IDs.',
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
    `[inter-conversation] ${fromSession.slice(0, 8)} -> ${toSession.slice(0, 8)}: ${data.intent} (${linkStatus})`,
  )
}

// ─── Quit conversation relay (dashboard -> agent host) ─────────────────────

const quitConversation: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  if (!conversation) return
  ctx.requirePermission('chat', conversation.project)

  const targetWs = ctx.conversations.getConversationSocket(conversationId)
  if (targetWs) {
    targetWs.send(JSON.stringify({ type: 'terminate_conversation', conversationId }))
    ctx.log.debug(`Conversation ${conversationId.slice(0, 8)} - SIGTERM sent to wrapper`)
    return
  }

  // Gateway-backed conversations (hermes, chat-api) have no per-conversation
  // socket. Notify the gateway adapter if connected, then end directly.
  const hostType = conversation.agentHostType
  if (hostType && hostType !== 'claude') {
    const gatewayWs = ctx.conversations.getGatewaySocket(hostType)
    if (gatewayWs) {
      gatewayWs.send(JSON.stringify({ type: 'terminate_conversation', conversationId }))
    }
    ctx.conversations.endConversation(conversationId, 'user_terminate')
    ctx.conversations.broadcastConversationUpdate(conversationId)
    ctx.log.debug(`Conversation ${conversationId.slice(0, 8)} - ended (${hostType} backend)`)
  }
}

// ─── Session viewed (clear notification badge) ────────────────────

const sessionViewed: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
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
  // Legacy conversation-ID path
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
  // `subscribe` is the self-elevation entry point for bearer-secret WS
  // upgrades that don't carry a passkey/userName at upgrade time (admin
  // tooling, CLI, the staging test harness). The handler sets
  // ws.data.isControlPanel = true; subsequent messages then route as
  // 'control-panel' under detectRole(). Without this opt-out, bearer-
  // secret connections default to 'agent-host' and the gate blocks the
  // very message that would promote them. Real production dashboards
  // arrive with userName already set (passkey auth), so this exception
  // does not soften the audit's intent.
  registerHandlers({ subscribe })
  // Dashboard / share viewer control surface (post-subscribe).
  registerHandlers(
    {
      refresh_sessions: refreshSessions,
      sync_check: syncCheck,
      channel_subscribe: channelSubscribe,
      channel_unsubscribe: channelUnsubscribe,
      channel_unsubscribe_all: channelUnsubscribeAll,
      terminate_conversation: quitConversation,
      conversation_viewed: sessionViewed,
      channel_link_response: channelLinkResponse,
      channel_unlink: channelUnlink,
    },
    DASHBOARD_ROLES,
  )
  // Inter-conversation messaging: agent hosts list peers + send messages.
  // Agents read ctx.ws.data.conversationId (set by their own boot/meta).
  registerHandlers(
    {
      channel_list_conversations: channelListSessions,
      channel_send: channelSend,
    },
    AGENT_HOST_ONLY,
  )
}
