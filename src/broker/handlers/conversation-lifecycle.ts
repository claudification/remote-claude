/**
 * Conversation lifecycle handlers: meta (connect/resume), hook events,
 * heartbeat, conversation clear (re-key), notify, and end.
 */

import { cwdToProjectUri, extractProjectLabel } from '../../shared/project-uri'
import type { Conversation, HookEvent, TerminationDetail, TerminationSource } from '../../shared/protocol'
import { slugify } from '../address-book'
import type { MessageHandler } from '../handler-context'
import { AGENT_HOST_ONLY, ANY_ROLE, registerHandlers } from '../message-router'
import { rejectBadMessage, requireProtocolVersion, requireStrings } from './validate'

// ─── Session meta (agent host connecting) ─────────────────────────────

const meta: MessageHandler = (ctx, data) => {
  if (!requireProtocolVersion(ctx, data, 'meta')) return

  // Wire boundary: conversationId is the stable primary key. ccSessionId is CC metadata.
  const required = requireStrings(ctx, data, ['conversationId', 'ccSessionId'] as const, 'meta')
  if (!required) return
  const { conversationId } = required
  const ccSessionId = required.ccSessionId

  const projectField = data.project
  const cwdField = data.cwd
  if (typeof projectField !== 'string' && typeof cwdField !== 'string') {
    rejectBadMessage(ctx, {
      type: 'meta',
      field: 'project',
      reason: 'either project (string) or cwd (string) is required',
      received: { project: projectField, cwd: cwdField },
    })
    return
  }
  const project = (projectField as string | undefined) ?? cwdToProjectUri(cwdField as string)
  ctx.ws.data.conversationId = conversationId
  ctx.ws.data.ccSessionId = ccSessionId
  ctx.ws.data.connectionId = conversationId

  const pendingLaunchConfig = ctx.conversations.consumePendingLaunchConfig(conversationId)

  const existing = ctx.conversations.getConversation(conversationId)

  function applyMetadata(conv: Conversation) {
    if (!conv.agentHostMeta) conv.agentHostMeta = {}
    conv.agentHostMeta.ccSessionId = ccSessionId
    conv.project = project
    if (data.model) conv.model = data.model as string
    if (data.capabilities) conv.capabilities = data.capabilities
    if (data.version) conv.version = data.version as string
    if (data.buildTime) conv.buildTime = data.buildTime as string
    if (data.claudeVersion) conv.claudeVersion = data.claudeVersion as string
    if (data.claudeAuth) conv.claudeAuth = data.claudeAuth as Record<string, unknown>
    if (data.spinnerVerbs) conv.spinnerVerbs = data.spinnerVerbs as string[]
    if (data.autocompactPct) conv.autocompactPct = data.autocompactPct as number
    if (data.maxBudgetUsd) conv.maxBudgetUsd = data.maxBudgetUsd as number
    if (data.adHocTaskId) conv.adHocTaskId = data.adHocTaskId as string
    if (data.adHocWorktree) conv.adHocWorktree = data.adHocWorktree as string
  }

  if (existing) {
    const prevStatus = existing.status
    if (prevStatus === 'ended') {
      // FLAP SIGNAL: meta is reviving an ended conversation. resumeConversation
      // emits the structured transition + NDJSON unend record; we log the
      // entry-point too so a future grep of [un-end-meta] points at this code.
      ctx.log.info(
        `[un-end-meta] ${conversationId.slice(0, 8)} cc=${ccSessionId.slice(0, 8)} prev-end=${existing.endedBy?.source ?? 'unknown'}/${existing.endedBy?.initiator ?? 'none'} version=${data.version ?? 'unknown'} -- meta arrived on an ENDED conversation; un-ending`,
      )
    }
    ctx.conversations.resumeConversation(conversationId)
    applyMetadata(existing)
    if (pendingLaunchConfig && !existing.launchConfig) {
      existing.launchConfig = pendingLaunchConfig
      if (pendingLaunchConfig.effort) existing.effortLevel = pendingLaunchConfig.effort
      if (pendingLaunchConfig.agent) existing.agentName = pendingLaunchConfig.agent
    }
    ctx.log.debug(
      `Conversation resumed: ${conversationId.slice(0, 8)} cc=${ccSessionId.slice(0, 8)} (${project}) prevStatus=${prevStatus} [${ctx.conversations.getActiveConversationCount(conversationId) + 1} connection(s)]${data.version ? ` [${data.version}]` : ''}`,
    )
  } else {
    const newConversation = ctx.conversations.createConversation(
      conversationId,
      project,
      data.model as string,
      data.args,
      data.capabilities,
    )
    applyMetadata(newConversation)
    if (pendingLaunchConfig) {
      newConversation.launchConfig = pendingLaunchConfig
      if (pendingLaunchConfig.effort) newConversation.effortLevel = pendingLaunchConfig.effort
      if (pendingLaunchConfig.agent) newConversation.agentName = pendingLaunchConfig.agent
    }
    const isAdHoc = (data.capabilities as string[] | undefined)?.includes('ad-hoc')
    ctx.log.debug(
      `Conversation started: ${conversationId.slice(0, 8)} cc=${ccSessionId.slice(0, 8)} (${project})${data.version ? ` [${data.version}]` : ''}`,
    )
    if (isAdHoc) {
      ctx.log.info(
        `[ad-hoc] Conversation connected: ${conversationId.slice(0, 8)} cc=${ccSessionId.slice(0, 8)} task=${data.adHocTaskId || 'none'} worktree=${data.adHocWorktree || 'none'} caps=[${(data.capabilities as string[])?.join(',') || ''}]`,
      )
    }
  }

  ctx.conversations.setConversationSocket(conversationId, conversationId, ctx.ws, 'meta')

  const convProject = (existing || ctx.conversations.getConversation(conversationId))?.project
  if (convProject) {
    const persistedLinks = ctx.getLinksForProject(convProject)
    for (const pl of persistedLinks) {
      const otherProject = pl.projectA === convProject ? pl.projectB : pl.projectA
      for (const s of ctx.conversations.getActiveConversations()) {
        if (s.project === otherProject && s.id !== conversationId) {
          ctx.conversations.linkProjects(conversationId, s.id)
          ctx.log.debug(
            `[links] Auto-restored: ${conversationId.slice(0, 8)} (${extractProjectLabel(convProject)}) <-> ${s.id.slice(0, 8)} (${extractProjectLabel(otherProject)})`,
          )
        }
      }
    }
  }

  ctx.conversations.persistConversationById(conversationId)
  ctx.conversations.broadcastConversationUpdate(conversationId)

  ctx.conversations.completeJob(conversationId, conversationId)

  const rvResolved = ctx.conversations.resolveRendezvous(conversationId, conversationId)
  if (!rvResolved) {
    const rvInfo = ctx.conversations.getRendezvousInfo(conversationId)
    if (rvInfo) ctx.log.debug(`[rendezvous] conversationId matched but resolve failed: ${conversationId.slice(0, 8)}`)
  }

  ctx.reply({ type: 'ack', eventId: conversationId, origins: ctx.origins })

  const drainConversation = existing || ctx.conversations.getConversation(conversationId)
  const drainProject = drainConversation?.project
  if (drainProject) {
    const nameSlug = drainConversation?.title ? slugify(drainConversation.title) : undefined
    const queued = ctx.messageQueue.drain(drainProject, nameSlug)
    if (queued.length > 0) {
      const targetWs = ctx.conversations.getConversationSocket(conversationId)
      if (targetWs) {
        for (const item of queued) {
          targetWs.send(JSON.stringify(item.message))
        }
        ctx.log.info(
          `Drained ${queued.length} queued message(s) for ${extractProjectLabel(drainProject)}${nameSlug ? `:${nameSlug}` : ''}`,
        )
      }
    }
  }
}

// ─── Hook events ───────────────────────────────────────────────────

const hook: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  ctx.conversations.addEvent(conversationId, data as HookEvent)
  const toolName = (data.data as Record<string, unknown>)?.tool_name
  ctx.log.debug(`${(data.hookEvent as string) || 'hook'}${toolName ? ` (${toolName})` : ''}`)
}

// ─── Heartbeat (keep-alive, no activity tracking) ──────────────────

const heartbeat: MessageHandler = ctx => {
  if (ctx.ws.data.isSentinel) {
    ctx.conversations.recordSentinelHeartbeat(ctx.ws)
  }
}

// ─── Conversation reset (/clear wipes ephemeral state) ──

const conversationReset: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId as string) || ctx.ws.data.conversationId
  if (!conversationId) return

  const resetProject = (data.project as string) ?? cwdToProjectUri(data.cwd as string)

  const conversation = ctx.conversations.clearConversation(conversationId, resetProject, data.model as string)
  if (conversation) {
    ctx.log.info(`Conversation reset: ${conversationId.slice(0, 8)} (${extractProjectLabel(resetProject)})`)
  } else {
    ctx.log.debug(`conversation_reset: conversation ${conversationId.slice(0, 8)} not found, creating new`)
    ctx.conversations.createConversation(conversationId, resetProject, data.model as string)
    ctx.conversations.setConversationSocket(conversationId, conversationId, ctx.ws, 'conversation_reset')
  }
}

// ─── Metadata upsert (opaque bag, broker never reads it) ──────────────

const updateMetadata: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId as string) || ctx.ws.data.conversationId
  const metadata = data.metadata as Record<string, unknown> | undefined
  if (!conversationId || !metadata) return

  const conv = ctx.conversations.getConversation(conversationId)
  if (!conv) {
    ctx.log.debug(`update_conversation_metadata: ${conversationId.slice(0, 8)} not found`)
    return
  }

  if (!conv.agentHostMeta) conv.agentHostMeta = {}
  Object.assign(conv.agentHostMeta, metadata)
  ctx.log.debug(`Metadata updated: ${conversationId.slice(0, 8)} keys=[${Object.keys(metadata).join(',')}]`)
}

// ─── Notify (push notification from agent host) ───────────────────────

const notify: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  // Reject notify for unknown conversations -- a global push + broadcast would
  // leak notification content to users who lack access. (Audit C2)
  if (!conversation?.project) {
    ctx.log.debug(`[notify] dropping: no conversation/project for ${conversationId?.slice(0, 8) || 'unknown'}`)
    return
  }
  const label = extractProjectLabel(conversation.project) || conversationId.slice(0, 8)
  const message = (data.message as string) || 'Notification'
  const title = (data.title as string) || label
  console.log(`[notify] ${title}: ${message}`)

  if (ctx.push.configured) {
    // `project` is required so sendToAll can scope delivery to users with the
    // `notifications` permission for this project -- omitting it pushes to
    // every subscriber regardless of access.
    ctx.push.sendToAll({
      title,
      body: message,
      conversationId,
      project: conversation.project,
      tag: `notify-${conversationId}`,
    })
  }

  const toastMsg = { type: 'toast', title, message, conversationId: conversationId }
  ctx.broadcastScoped(toastMsg, conversation.project)
}

// ─── Session end ───────────────────────────────────────────────────

const end: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  const connectionId = ctx.ws.data.connectionId || (ctx.ws.data.conversationId as string)
  if (!conversationId || !connectionId) return

  // Capture conversation before ending (for ad-hoc notification)
  const conversation = ctx.conversations.getConversation(conversationId)

  ctx.conversations.removeConversationSocket(conversationId, connectionId)
  const remaining = ctx.conversations.getActiveConversationCount(conversationId)
  if (remaining === 0) {
    // The agent host's `end` message carries either a typed source (new
    // wire) OR a free-form reason string (cc-exit-N, legacy). Map legacy
    // reason -> typed source so the NDJSON log is uniform.
    const wireSource = data.source as TerminationSource | undefined
    const reason = ((data.reason as string) || '').toLowerCase()
    let source: TerminationSource
    if (wireSource) source = wireSource
    else if (reason === 'normal') source = 'cc-exit-normal'
    else if (reason.startsWith('exit_code_')) source = 'cc-exit-crash'
    else if (reason.startsWith('dashboard-')) source = 'dashboard-other'
    else if (reason === 'mcp-exit-session') source = 'mcp-exit-session'
    else source = 'unknown'
    const detail = (data.detail as TerminationDetail | undefined) || {
      note: data.reason ? `legacy reason=${data.reason}` : undefined,
    }
    ctx.conversations.endConversation(conversationId, {
      source,
      initiator: data.initiator as string | undefined,
      detail,
    })
    ctx.log.debug(`Conversation ended: ${conversationId.slice(0, 8)}... (source=${source}, reason=${data.reason})`)

    // Ad-hoc conversation completion notification
    if (conversation?.capabilities?.includes('ad-hoc') && conversation.adHocTaskId) {
      const elapsed = Math.round((Date.now() - conversation.startedAt) / 1000)
      const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`
      const title = conversation.title || conversation.adHocTaskId
      const costStr = conversation.stats?.totalCostUsd ? ` ($${conversation.stats.totalCostUsd.toFixed(2)})` : ''

      const toastMsg = {
        type: 'toast' as const,
        title: 'Task completed',
        message: `${title} (${elapsedStr}${costStr})`,
        variant: 'success' as const,
        taskId: conversation.adHocTaskId,
        conversationId: conversationId,
      }
      if (conversation.project) {
        ctx.broadcastScoped(toastMsg, conversation.project)
        ctx.push.sendToAll({
          title: 'Task completed',
          body: `${title} - completed in ${elapsedStr}${costStr}`,
          conversationId,
          project: conversation.project,
          data: { taskId: conversation.adHocTaskId, url: `/#task/${conversation.adHocTaskId}` },
          tag: `adhoc-${conversationId}`,
        })
      } else {
        ctx.log.debug(`[ad-hoc] dropping completion toast: no project on ${conversationId.slice(0, 8)}`)
      }

      ctx.log.info(`[ad-hoc] Task completed: ${conversation.adHocTaskId} (${elapsedStr}${costStr})`)
    }
  } else {
    ctx.log.debug(
      `Connection ${connectionId.slice(0, 8)} ended for conversation ${conversationId.slice(0, 8)}... (${remaining} connection(s) remaining)`,
    )
  }
}

// ─── Host transport reconnect telemetry ─────────────────────────────────
// Fires from src/shared/host-transport on every (re)connect AFTER the
// initial message. Lets us correlate broker-side close events with what
// the host saw on its side (close code, attempt #, queue/ring depth, the
// initial-message type the host chose). Log only -- no broadcast yet.
// Per the LOG EVERYTHING covenant: surface every field, every time.

// Intentional complexity: 12 cyclomatic comes from unpacking every wire field
// into a typed local + a single structured log line per the LOG EVERYTHING
// covenant. Splitting would scatter the telemetry across helpers and hide
// what's being logged.
// fallow-ignore-next-line complexity
const hostTransportReconnect: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId as string | undefined) || ctx.ws.data.conversationId
  if (!conversationId) {
    ctx.log.debug(`[transport-reconnect] missing conversationId, ignoring`)
    return
  }
  const attempt = (data.attempt as number | undefined) ?? -1
  const prevCloseCode = data.prevCloseCode as number | undefined
  const prevCloseReason = data.prevCloseReason as string | undefined
  const msSinceLastConnect = data.msSinceLastConnect as number | undefined
  const queuedMessages = (data.queuedMessages as number | undefined) ?? 0
  const ringBufferDepth = (data.ringBufferDepth as number | undefined) ?? 0
  const initialMessageType = (data.initialMessageType as string | undefined) ?? 'unknown'
  const hasSessionId = (data.hasSessionId as boolean | undefined) ?? false
  const hostVersion = data.hostVersion as string | undefined

  // Single line, structured, all fields -- this is the missing half of the
  // flap diagnostic that started this whole pass.
  ctx.log.info(
    `[transport-reconnect] ${conversationId.slice(0, 8)} attempt=${attempt} initialMsg=${initialMessageType} hasSessionId=${hasSessionId} prevCloseCode=${prevCloseCode ?? 'none'} prevCloseReason=${prevCloseReason || 'none'} msSinceLastConnect=${msSinceLastConnect ?? 'none'} queued=${queuedMessages} ringDepth=${ringBufferDepth} hostVersion=${hostVersion ?? 'unknown'}`,
  )
}

// ─── Conversation status signal (backend-agnostic active/idle) ──────────

const conversationStatus: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation || conversation.status === 'ended') return

  const status = data.status as 'active' | 'idle'
  if (status !== 'active' && status !== 'idle') return
  if (conversation.status === status) return // no-op

  conversation.status = status
  conversation.lastActivity = Date.now()
  if (status === 'idle') {
    ctx.conversations.scheduleRecap(conversationId)
  } else {
    ctx.conversations.cancelRecap(conversationId)
    if (conversation.lastError) conversation.lastError = undefined
    if (conversation.rateLimit) conversation.rateLimit = undefined
  }
  ctx.conversations.broadcastConversationUpdate(conversationId)
  ctx.log.debug(`conversation_status: ${conversationId.slice(0, 8)} -> ${status}`)
}

export function registerConversationLifecycleHandlers(): void {
  // Agent-host-only -- dashboards / sentinels / shares should never send these.
  // (Audit C3, H4, H5, H7)
  registerHandlers(
    {
      meta,
      hook,
      conversation_reset: conversationReset,
      update_conversation_metadata: updateMetadata,
      conversation_status: conversationStatus,
      host_transport_reconnect: hostTransportReconnect,
      notify,
      end,
    },
    AGENT_HOST_ONLY,
  )
  // Heartbeat is sent by sentinels (and harmlessly by other roles for keepalive).
  registerHandlers({ heartbeat }, ANY_ROLE)
}
