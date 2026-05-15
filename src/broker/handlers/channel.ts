/**
 * Channel handlers: inter-conversation messaging, session discovery, link management,
 * channel subscriptions, dashboard subscriptions, and conversation quit relay.
 */

import { deriveModelName } from '../../shared/models'
import { cwdToProjectUri, extractProjectLabel, isSameProject } from '../../shared/project-uri'
import type { ChannelSendResultEntry, SubscriptionChannel, TerminationSource } from '../../shared/protocol'
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

const refreshConversations: MessageHandler = ctx => {
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
  // Per-conversation share scope: a guest with a share link bound to
  // conversation A must not be able to subscribe to conversation B's
  // transcript/term/diag channels even though they share a project URI.
  const shareConvId = ctx.ws.data.shareConversationId
  if (shareConvId && conversationId !== shareConvId) {
    ctx.reply({ type: 'channel_ack', channel, conversationId, agentId, status: 'denied' })
    return
  }
  ctx.conversations.subscribeChannel(ctx.ws, channel, conversationId, agentId)
  ctx.reply({ type: 'channel_ack', channel, conversationId, agentId, status: 'subscribed' })

  // Push current tasks snapshot. Without this, the dashboard's task panel stays
  // empty after broker restart -- conv.tasks is hydrated from SQLite into memory,
  // but the UI only fills state.tasks[sid] from tasks_update messages, and the
  // agent host only emits those when CC re-runs TodoWrite.
  if (channel === 'conversation:tasks' && conversation) {
    ctx.reply({ type: 'tasks_update', conversationId, tasks: conversation.tasks })
  }

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

// ─── Conversation discovery (list_conversations) ────────────────────────

const channelListConversations: MessageHandler = (ctx, data) => {
  const status = (data.status as string) || 'live'
  const showMetadata = !!data.show_metadata
  const callerConversation = ctx.ws.data.conversationId
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
      if (!callerConversation) return false
      const linkStatus = ctx.conversations.checkProjectLink(callerConversation, s.id)
      return linkStatus === 'linked'
    })

  // Group conversations by project to detect multi-conversation projects
  const projectGroups = new Map<string, typeof filtered>()
  for (const s of filtered) {
    const group = projectGroups.get(s.project) || []
    group.push(s)
    projectGroups.set(s.project, group)
  }

  // Issues collected while enumerating. Surfaced to benevolent callers ONLY
  // (capped at MAX_ISSUES) so debug conversations can see broker-side row
  // skips / self-block failures without having to grep `docker logs broker`.
  // Non-benevolent callers get nothing -- prevents leaking internal state.
  const MAX_ISSUES = 10
  const issues: Array<{
    severity: 'error' | 'warning'
    code: string
    conversation_id?: string
    project?: string
    message: string
  }> = []
  const pushIssue = (i: (typeof issues)[number]) => {
    if (issues.length < MAX_ISSUES) issues.push(i)
    else if (issues.length === MAX_ISSUES)
      issues.push({ severity: 'warning', code: 'issues_truncated', message: 'further issues suppressed' })
  }

  // Per-row try/catch: a single malformed conversation (bad project URI,
  // corrupt settings, address-book divergence) must NEVER sink the whole list.
  // Pre-2026-05-11 a throw here was swallowed by the router, replied as
  // `channel_list_conversations_result` (a type the agent host doesn't listen
  // for), and every caller's promise timed out at 5s returning empty `[]`.
  // See parseProjectUri's incident comment for the originating case.
  const result = filtered.flatMap(s => {
    try {
      const linkStatus = callerConversation ? ctx.conversations.checkProjectLink(callerConversation, s.id) : 'unknown'
      const isLinked = linkStatus === 'linked'
      const projSettings = ctx.getProjectSettings(s.project)
      const conversationName = s.title || projSettings?.label || extractProjectLabel(s.project)
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

      const isSelf = s.id === callerConversation

      return [
        {
          id: localId, // stable local address (use for send_message, etc.)
          project: projectSlug, // project-level grouping ID
          conversation_id: s.id,
          name: conversationName,
          projectUri: s.project,
          conversationUri: `${s.project}#${s.id}`, // permanent record handle
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
          ...(projSettings?.label && projSettings.label !== conversationName ? { label: projSettings.label } : {}),
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
        },
      ]
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      ctx.log.debug(
        `[channel_list_conversations] skipped conversation ${s.id.slice(0, 8)} (project=${s.project}): ${message}`,
      )
      pushIssue({ severity: 'error', code: 'row_skipped', conversation_id: s.id, project: s.project, message })
      return []
    }
  })
  // Build self identity from caller's conversation. Same defensive wrap as
  // the per-row loop above -- a malformed caller project URI must not crash
  // the whole reply.
  let self: Record<string, unknown> | undefined
  if (callerConversation) {
    const s = ctx.conversations.getConversation(callerConversation)
    if (s) {
      try {
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
          conversationUri: `${s.project}#${s.id}`,
          model: deriveModelName(s.model, s.configuredModel),
          permissionMode: s.permissionMode,
          effortLevel: s.effortLevel,
          status: 'live' as const,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        ctx.log.debug(
          `[channel_list_conversations] self block failed for ${s.id.slice(0, 8)} (project=${s.project}): ${message}`,
        )
        pushIssue({ severity: 'error', code: 'self_block_failed', conversation_id: s.id, project: s.project, message })
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
    const conversationName = typeof cfg.name === 'string' && cfg.name ? cfg.name : `spawning-${job.jobId.slice(0, 6)}`
    const projSettings = project ? ctx.getProjectSettings(project) : null
    const projectName = projSettings?.label || (project ? extractProjectLabel(project) : 'unknown')
    const projectSlug =
      callerProject && project ? ctx.addressBook.getOrAssign(callerProject, project, projectName) : slugify(projectName)
    // Compute compound id against the live conversations at the same project
    // plus this synthetic entry, so collisions disambiguate against siblings.
    const projGroup = filtered.filter(s => isSameProject(s.project, project))
    const target = { id: job.conversationId, project, title: conversationName }
    const localId = computeLocalId(target, projectSlug, [...projGroup, target])
    result.push({
      id: localId,
      project: projectSlug,
      conversation_id: job.conversationId,
      name: conversationName,
      projectUri: project || 'pending',
      // No conversationUri on spawning rows: the conversation hasn't booted, and
      // a synthetic `pending#<id>` URI would lie about being a permanent record.
      status: 'spawning',
      capabilities: undefined,
      title: conversationName,
      summary: undefined,
      link: undefined,
      spawnJobId: job.jobId,
      spawnStep: job.lastStep ?? undefined,
    } as unknown as (typeof result)[number])
  }

  ctx.reply({
    type: 'channel_conversations_list',
    conversations: result,
    self,
    ...(isBenevolent && issues.length > 0 ? { issues } : {}),
  })
}

// ─── Inter-conversation messaging (channel_send) ────────────────────────

/**
 * Compute the sender's routable ID from the receiver's perspective.
 *
 * Must match the ID shape produced by `list_conversations` so a recipient can
 * pass `from_conversation` straight back as `to` without a round-trip through
 * list_conversations. When the sender's project hosts multiple conversations,
 * the ID is compounded `project:conversation-slug` -- bare project slugs would
 * be ambiguous and rejected by the send resolver.
 */
function computeSenderRoutableId(
  ctx: Parameters<MessageHandler>[0],
  fromConv: { id: string; project: string; title?: string } | undefined,
  toProject: string | undefined,
  fromProjectName: string,
): { routable: string; project: string } {
  if (!fromConv?.project || !toProject) {
    const fallback = fromConv?.id || slugify(fromProjectName)
    return { routable: fallback, project: fallback }
  }
  const projectSlug = ctx.addressBook.getOrAssign(toProject, fromConv.project, fromProjectName)
  const conversationsAtProject = Array.from(ctx.conversations.getAllConversations()).filter(s =>
    isSameProject(s.project, fromConv.project),
  )
  // Always compound -- list_conversations must be able to round-trip the from-id.
  const projGroup = conversationsAtProject.length > 0 ? conversationsAtProject : [fromConv]
  return { routable: computeLocalId(fromConv, projectSlug, projGroup), project: projectSlug }
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

// Max recipients in a single multicast call. Hard cap to prevent accidental
// fan-blast (e.g. an agent loops list_conversations into send_message).
const MAX_MULTICAST_TARGETS = 25

type HandlerCtx = Parameters<MessageHandler>[0]
type ConvRecord = ReturnType<HandlerCtx['conversations']['getConversation']>

/**
 * Resolve and deliver to ONE target. Returns a per-target result entry instead
 * of replying directly -- the multicast orchestrator aggregates entries and
 * sends a single `channel_send_result` envelope at the end. Synchronous so
 * single-target sends still reply within the same tick as before.
 */
function deliverToOne(
  ctx: HandlerCtx,
  data: Record<string, unknown>,
  fromConversation: string,
  fromConv: ConvRecord | undefined,
  callerProject: string | undefined,
  toTarget: string,
  conversationId: string,
): ChannelSendResultEntry {
  const colonIdx = toTarget.indexOf(':')
  const projectSlug = colonIdx >= 0 ? toTarget.slice(0, colonIdx) : toTarget
  const conversationSlug = colonIdx >= 0 ? toTarget.slice(colonIdx + 1) : undefined

  let targetProject = callerProject ? ctx.addressBook.resolve(callerProject, projectSlug) : undefined

  if (!targetProject && callerProject) {
    for (const s of ctx.conversations.getAllConversations()) {
      if (s.id === fromConversation) continue
      const projSettings = ctx.getProjectSettings(s.project)
      const projectName = projSettings?.label || extractProjectLabel(s.project)
      ctx.addressBook.getOrAssign(callerProject, s.project, projectName)
    }
    targetProject = ctx.addressBook.resolve(callerProject, projectSlug)
  }

  let toConv: ReturnType<typeof ctx.conversations.getConversation> | undefined
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
      return {
        to: toTarget,
        ok: false,
        error: formatAmbiguityError(resolved.canonicalProject, resolved.candidates),
      }
    }
    if (resolved.kind === 'resolved') {
      toConv = ctx.conversations.getConversation(resolved.conversation.id)
    }
  } else {
    toConv = ctx.conversations.findConversationByConversationId(toTarget) || ctx.conversations.getConversation(toTarget)
  }

  const toConversation = toConv?.id

  if (targetProject && !toConv) {
    const fromProjectName =
      ctx.getProjectSettings(callerProject || '')?.label ||
      (callerProject ? extractProjectLabel(callerProject) : fromConversation.slice(0, 8))
    const { routable: fromSlug, project: fromProjectSlug } = computeSenderRoutableId(
      ctx,
      fromConv && { id: fromConv.id, project: fromConv.project, title: fromConv.title },
      targetProject,
      fromProjectName,
    )
    const delivery = {
      type: 'channel_deliver',
      fromConversation: fromSlug,
      fromProject: fromProjectSlug,
      intent: data.intent,
      message: data.message,
      context: data.context,
      conversationId,
    }
    ctx.messageQueue.enqueue(targetProject, callerProject || '', fromProjectName, delivery, conversationSlug)
    ctx.log.debug(`[inter-conversation] ${fromConversation.slice(0, 8)} -> ${toTarget} (queued, target offline)`)
    return { to: toTarget, ok: true, status: 'queued' }
  }

  if (!toConv || !toConversation) {
    const pendingMatch = findPendingSpawnTarget(ctx, toTarget)
    if (pendingMatch) {
      const fromProjectName =
        ctx.getProjectSettings(callerProject || '')?.label ||
        (callerProject ? extractProjectLabel(callerProject) : fromConversation.slice(0, 8))
      const { routable: fromSlug, project: fromProjectSlug } = computeSenderRoutableId(
        ctx,
        fromConv && { id: fromConv.id, project: fromConv.project, title: fromConv.title },
        pendingMatch.project,
        fromProjectName,
      )
      const delivery = {
        type: 'channel_deliver',
        fromConversation: fromSlug,
        fromProject: fromProjectSlug,
        intent: data.intent,
        message: data.message,
        context: data.context,
        conversationId,
      }
      ctx.messageQueue.enqueue(pendingMatch.project, callerProject || '', fromProjectName, delivery, pendingMatch.name)
      ctx.log.debug(
        `[inter-conversation] ${fromConversation.slice(0, 8)} -> ${toTarget} (queued for spawning job ${pendingMatch.jobId.slice(0, 8)})`,
      )
      return { to: toTarget, ok: true, status: 'queued' }
    }
    return {
      to: toTarget,
      ok: false,
      error: 'Target not found. Use list_conversations to discover current conversations.',
    }
  }

  const fromProjectName =
    ctx.getProjectSettings(fromConv?.project || '')?.label ||
    (fromConv?.project ? extractProjectLabel(fromConv.project) : fromConversation.slice(0, 8))

  const linkStatus = ctx.conversations.checkProjectLink(fromConversation, toConversation)
  if (linkStatus === 'blocked') {
    return { to: toTarget, ok: false, error: 'Conversation has blocked your messages' }
  }

  const { routable: fromSlug, project: fromProjectSlug } = computeSenderRoutableId(
    ctx,
    fromConv && { id: fromConv.id, project: fromConv.project, title: fromConv.title },
    toConv.project,
    fromProjectName,
  )

  const delivery = {
    type: 'channel_deliver',
    fromConversation: fromSlug,
    fromProject: fromProjectSlug,
    intent: data.intent,
    message: data.message,
    context: data.context,
    conversationId,
  }

  const targetTrust = toConv.project ? ctx.getProjectSettings(toConv.project)?.trustLevel : undefined
  const fromTrust = fromConv?.project ? ctx.getProjectSettings(fromConv.project)?.trustLevel : undefined
  const isSisterConversation =
    !!fromConv?.project && !!toConv.project && isSameProject(fromConv.project, toConv.project)
  const isTrusted = isSisterConversation || targetTrust === 'open' || fromTrust === 'benevolent'

  const effectiveLinkStatus =
    linkStatus === 'unknown' && isTrusted
      ? 'trusted'
      : linkStatus === 'unknown' &&
          fromConv?.project &&
          toConv.project &&
          ctx.links.find(fromConv.project, toConv.project)
        ? 'persisted'
        : linkStatus

  if (effectiveLinkStatus === 'linked' || effectiveLinkStatus === 'persisted' || effectiveLinkStatus === 'trusted') {
    if (effectiveLinkStatus !== 'linked') {
      ctx.conversations.linkProjects(fromConversation, toConversation)
      ctx.log.debug(
        `[links] Auto-linked (${effectiveLinkStatus}): ${fromConversation.slice(0, 8)} <-> ${toConversation.slice(0, 8)}`,
      )
    }
    const targetWs = ctx.conversations.getConversationSocket(toConversation)
    if (targetWs) {
      targetWs.send(JSON.stringify(delivery))
      const toProjectName = ctx.getProjectSettings(toConv.project)?.label || extractProjectLabel(toConv.project)
      if (fromConv?.project && toConv.project) {
        ctx.links.touch(fromConv.project, toConv.project)
        ctx.logMessage({
          ts: Date.now(),
          from: { conversationId: fromConversation, project: fromConv.project, name: fromProjectName },
          to: { conversationId: toConversation, project: toConv.project, name: toProjectName },
          intent: (data.intent as string) || 'notify',
          conversationId,
          preview: ((data.message as string) || '').slice(0, 200),
          fullLength: ((data.message as string) || '').length,
        })
      }
      ctx.log.debug(
        `[inter-conversation] ${fromConversation.slice(0, 8)} -> ${toConversation.slice(0, 8)}: ${data.intent} (${linkStatus})`,
      )
      return { to: toTarget, ok: true, status: 'delivered', targetConversationId: toConversation }
    }
    return {
      to: toTarget,
      ok: false,
      error: 'Target conversation not connected. It may have restarted. Use list_conversations to resolve current IDs.',
    }
  }

  ctx.conversations.queueProjectMessage(fromConversation, toConversation, delivery)
  const toProjectName = ctx.getProjectSettings(toConv.project)?.label || extractProjectLabel(toConv.project)
  ctx.broadcast({
    type: 'channel_link_request',
    fromConversation,
    fromProject: fromProjectName,
    toConversation,
    toProject: toProjectName,
  })
  ctx.log.debug(
    `[inter-conversation] ${fromConversation.slice(0, 8)} -> ${toConversation.slice(0, 8)}: ${data.intent} (${linkStatus})`,
  )
  return { to: toTarget, ok: true, status: 'queued', targetConversationId: toConversation }
}

const channelSend: MessageHandler = (ctx, data) => {
  const fromConversation = ctx.ws.data.conversationId || (data.fromConversation as string)
  const rawTo = data.toConversation
  if (!fromConversation || rawTo === undefined || rawTo === null) return

  const wasArray = Array.isArray(rawTo)
  const targets = (wasArray ? (rawTo as unknown[]) : [rawTo]).filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  )
  const dedupedTargets = Array.from(new Set(targets))

  if (dedupedTargets.length === 0) {
    ctx.reply({
      type: 'channel_send_result',
      ok: false,
      error: 'toConversation must be a non-empty string or non-empty array of strings.',
    })
    return
  }

  if (dedupedTargets.length > MAX_MULTICAST_TARGETS) {
    ctx.reply({
      type: 'channel_send_result',
      ok: false,
      error: `Too many recipients: ${dedupedTargets.length} > ${MAX_MULTICAST_TARGETS}. Split the send into smaller batches.`,
    })
    return
  }

  const fromConv = ctx.conversations.getConversation(fromConversation)
  const callerProject = fromConv?.project || ctx.caller?.project

  const conversationId = (data.conversationId as string) || `conv_${Date.now().toString(36)}`

  const results: ChannelSendResultEntry[] = dedupedTargets.map(toTarget => {
    try {
      return deliverToOne(
        ctx,
        data as Record<string, unknown>,
        fromConversation,
        fromConv,
        callerProject,
        toTarget,
        conversationId,
      )
    } catch (err) {
      return { to: toTarget, ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  const allOk = results.every(r => r.ok)
  if (wasArray) {
    ctx.reply({ type: 'channel_send_result', ok: allOk, conversationId, results })
    return
  }
  const r = results[0]
  ctx.reply({
    type: 'channel_send_result',
    ok: r.ok,
    conversationId,
    ...(r.status ? { status: r.status } : {}),
    ...(r.targetConversationId ? { targetConversationId: r.targetConversationId } : {}),
    ...(r.error ? { error: r.error } : {}),
  })
}

// ─── Quit conversation relay (dashboard -> agent host) ─────────────────────

const quitConversation: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  if (!conversation) return
  ctx.requirePermission('chat', conversation.project)

  // Source tag travels from the web client; fall back to dashboard-other
  // for legacy callers that haven't been updated yet.
  const source: TerminationSource = (data.source as TerminationSource) || 'dashboard-other'
  const initiator =
    (data.initiator as string | undefined) || (ctx.ws.data.userName ? `user:${ctx.ws.data.userName}` : undefined)

  const targetWs = ctx.conversations.getConversationSocket(conversationId)
  if (targetWs) {
    targetWs.send(JSON.stringify({ type: 'terminate_conversation', conversationId, source, initiator }))
    ctx.log.debug(`Conversation ${conversationId.slice(0, 8)} - terminate forwarded (source=${source})`)
    return
  }

  // Gateway-backed conversations (hermes, chat-api) have no per-conversation
  // socket. Notify the gateway adapter if connected, then end directly.
  const hostType = conversation.agentHostType
  if (hostType && hostType !== 'claude') {
    const gatewayWs = ctx.conversations.getGatewaySocket(hostType)
    if (gatewayWs) {
      gatewayWs.send(JSON.stringify({ type: 'terminate_conversation', conversationId, source, initiator }))
    }
    ctx.conversations.endConversation(conversationId, {
      source,
      initiator,
      detail: { note: `Gateway-backed (${hostType}) -- ended directly` },
    })
    ctx.conversations.broadcastConversationUpdate(conversationId)
    ctx.log.debug(`Conversation ${conversationId.slice(0, 8)} - ended (${hostType} backend, source=${source})`)
  }
}

// ─── Conversation viewed (clear notification badge) ────────────────────

const conversationViewed: MessageHandler = (ctx, data) => {
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
  const fromConversation = data.fromConversation as string
  const toConversation = data.toConversation as string
  if (!fromConversation || !toConversation) return

  // Link approval creates persistent project-level trust -- require settings on BOTH projects
  const fromConv = ctx.conversations.getConversation(fromConversation)
  const toConv = ctx.conversations.getConversation(toConversation)
  if (!fromConv || !toConv) {
    ctx.reply({ type: 'error', error: 'Both sessions must exist to approve/block a link' })
    return
  }
  ctx.requirePermission('settings', fromConv.project)
  ctx.requirePermission('settings', toConv.project)

  if (data.action === 'approve') {
    ctx.conversations.linkProjects(fromConversation, toConversation)
    const fromConv = ctx.conversations.getConversation(fromConversation)
    const toConv = ctx.conversations.getConversation(toConversation)
    if (fromConv?.project && toConv?.project) ctx.links.add(fromConv.project, toConv.project)
    const queued = ctx.conversations.drainProjectMessages(fromConversation, toConversation)
    const targetWs = ctx.conversations.getConversationSocket(toConversation)
    if (targetWs) {
      for (const msg of queued) targetWs.send(JSON.stringify(msg))
    }
    ctx.log.debug(`Link approved + persisted: ${fromConversation.slice(0, 8)} <-> ${toConversation.slice(0, 8)}`)
  } else {
    ctx.conversations.blockProject(fromConversation, toConversation)
    const fromConv = ctx.conversations.getConversation(fromConversation)
    const toConv = ctx.conversations.getConversation(toConversation)
    if (fromConv?.project && toConv?.project) ctx.links.remove(fromConv.project, toConv.project)
    ctx.conversations.drainProjectMessages(fromConversation, toConversation) // discard
    ctx.log.debug(`Link blocked: ${fromConversation.slice(0, 8)} X ${toConversation.slice(0, 8)}`)
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
  // Conversation-ID path (kept for callers that have IDs handy)
  const conversationA = data.conversationA as string
  const conversationB = data.conversationB as string
  if (!conversationA || !conversationB) return
  const convA = ctx.conversations.getConversation(conversationA)
  const convB = ctx.conversations.getConversation(conversationB)
  if (!convA || !convB) {
    ctx.reply({ type: 'error', error: 'Both conversations must exist to sever a link' })
    return
  }
  ctx.requirePermission('settings', convA.project)
  ctx.requirePermission('settings', convB.project)
  ctx.conversations.unlinkProjects(conversationA, conversationB)
  if (convA.project && convB.project) ctx.links.remove(convA.project, convB.project)
  ctx.conversations.broadcastConversationUpdate(conversationA)
  ctx.conversations.broadcastConversationUpdate(conversationB)
  ctx.log.debug(`Link severed: ${conversationA.slice(0, 8)} X ${conversationB.slice(0, 8)}`)
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
      refresh_conversations: refreshConversations,
      sync_check: syncCheck,
      channel_subscribe: channelSubscribe,
      channel_unsubscribe: channelUnsubscribe,
      channel_unsubscribe_all: channelUnsubscribeAll,
      terminate_conversation: quitConversation,
      conversation_viewed: conversationViewed,
      channel_link_response: channelLinkResponse,
      channel_unlink: channelUnlink,
    },
    DASHBOARD_ROLES,
  )
  // Inter-conversation messaging: agent hosts list peers + send messages.
  // Agents read ctx.ws.data.conversationId (set by their own boot/meta).
  registerHandlers(
    {
      channel_list_conversations: channelListConversations,
      channel_send: channelSend,
    },
    AGENT_HOST_ONLY,
  )
}
