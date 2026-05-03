/**
 * Conversation lifecycle handlers: meta (connect/resume), hook events,
 * heartbeat, session clear (re-key), notify, and end.
 */

import { cwdToProjectUri, extractProjectLabel } from '../../shared/project-uri'
import { slugify } from '../address-book'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

// ─── Session meta (wrapper connecting) ─────────────────────────────

const meta: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const ccSessionId = data.ccSessionId as string
  const project = (data.project as string) ?? cwdToProjectUri(data.cwd as string)
  ctx.ws.data.conversationId = conversationId

  // Consume pending launch config (stored at spawn time, keyed by conversationId)
  const pendingLaunchConfig = ctx.conversations.consumePendingLaunchConfig(conversationId)

  const existing = ctx.conversations.getConversation(ccSessionId)
  if (existing) {
    ctx.conversations.resumeConversation(ccSessionId)
    existing.project = project
    if (data.capabilities) existing.capabilities = data.capabilities
    if (data.version) existing.version = data.version as string
    if (data.buildTime) existing.buildTime = data.buildTime as string
    if (data.claudeVersion) existing.claudeVersion = data.claudeVersion as string
    if (data.claudeAuth) existing.claudeAuth = data.claudeAuth as Record<string, unknown>
    if (data.spinnerVerbs) existing.spinnerVerbs = data.spinnerVerbs as string[]
    if (data.autocompactPct) existing.autocompactPct = data.autocompactPct as number
    if (data.maxBudgetUsd) existing.maxBudgetUsd = data.maxBudgetUsd as number
    if (data.adHocTaskId) existing.adHocTaskId = data.adHocTaskId as string
    if (data.adHocWorktree) existing.adHocWorktree = data.adHocWorktree as string
    // Only set launchConfig on first connect (spawn), don't overwrite on revive
    if (pendingLaunchConfig && !existing.launchConfig) {
      existing.launchConfig = pendingLaunchConfig
      if (pendingLaunchConfig.effort) existing.effortLevel = pendingLaunchConfig.effort
      if (pendingLaunchConfig.agent) existing.agentName = pendingLaunchConfig.agent
    }
    ctx.log.debug(
      `Conversation resumed: ${ccSessionId.slice(0, 8)}... conv=${conversationId.slice(0, 8)} (${data.cwd}) [${ctx.conversations.getActiveConversationCount(ccSessionId) + 1} conversation(s)]${data.version ? ` [${data.version}]` : ''}`,
    )
  } else {
    const newConversation = ctx.conversations.createConversation(
      ccSessionId,
      project,
      data.model as string,
      data.args,
      data.capabilities,
    )
    if (data.version) newConversation.version = data.version as string
    if (data.buildTime) newConversation.buildTime = data.buildTime as string
    if (data.claudeVersion) newConversation.claudeVersion = data.claudeVersion as string
    if (data.spinnerVerbs) newConversation.spinnerVerbs = data.spinnerVerbs as string[]
    if (data.autocompactPct) newConversation.autocompactPct = data.autocompactPct as number
    if (data.maxBudgetUsd) newConversation.maxBudgetUsd = data.maxBudgetUsd as number
    if (data.adHocTaskId) newConversation.adHocTaskId = data.adHocTaskId as string
    if (data.adHocWorktree) newConversation.adHocWorktree = data.adHocWorktree as string
    if (pendingLaunchConfig) {
      newConversation.launchConfig = pendingLaunchConfig
      if (pendingLaunchConfig.effort) newConversation.effortLevel = pendingLaunchConfig.effort
      if (pendingLaunchConfig.agent) newConversation.agentName = pendingLaunchConfig.agent
    }
    const isAdHoc = (data.capabilities as string[] | undefined)?.includes('ad-hoc')
    ctx.log.debug(
      `Conversation started: ${ccSessionId.slice(0, 8)}... conv=${conversationId.slice(0, 8)} (${data.cwd})${data.version ? ` [${data.version}]` : ''}`,
    )
    if (isAdHoc) {
      ctx.log.info(
        `[ad-hoc] Conversation connected: ${ccSessionId.slice(0, 8)} task=${data.adHocTaskId || 'none'} worktree=${data.adHocWorktree || 'none'} caps=[${(data.capabilities as string[])?.join(',') || ''}]`,
      )
    }
  }

  ctx.conversations.setConversationSocket(ccSessionId, conversationId, ctx.ws)

  // Auto-restore persisted links for this conversation's project
  const convProject = (existing || ctx.conversations.getConversation(ccSessionId))?.project
  if (convProject) {
    const persistedLinks = ctx.getLinksForProject(convProject)
    for (const pl of persistedLinks) {
      const otherProject = pl.projectA === convProject ? pl.projectB : pl.projectA
      for (const s of ctx.conversations.getActiveConversations()) {
        if (s.project === otherProject && s.id !== ccSessionId) {
          ctx.conversations.linkProjects(ccSessionId, s.id)
          ctx.log.debug(
            `[links] Auto-restored: ${ccSessionId.slice(0, 8)} (${extractProjectLabel(convProject)}) <-> ${s.id.slice(0, 8)} (${extractProjectLabel(otherProject)})`,
          )
        }
      }
    }
  }

  ctx.conversations.broadcastConversationUpdate(ccSessionId)

  // Complete launch job if this conversationId is tracked
  ctx.conversations.completeJob(conversationId, ccSessionId)

  // Check rendezvous: someone may be waiting for this wrapper to connect
  const rvResolved = ctx.conversations.resolveRendezvous(conversationId, ccSessionId)
  if (!rvResolved) {
    const rvInfo = ctx.conversations.getRendezvousInfo(conversationId)
    if (rvInfo) ctx.log.debug(`[rendezvous] conversationId matched but resolve failed: ${conversationId.slice(0, 8)}`)
  }

  ctx.reply({ type: 'ack', eventId: ccSessionId, origins: ctx.origins })

  // Drain queued messages for this project (sent while conversation was offline)
  // Pass conversation title so only messages targeted at this specific conversation
  // (or project-level messages with no target) are drained. Messages for other
  // conversations at the same project stay queued.
  const drainConversation = existing || ctx.conversations.getConversation(ccSessionId)
  const drainProject = drainConversation?.project
  if (drainProject) {
    const nameSlug = drainConversation?.title ? slugify(drainConversation.title) : undefined
    const queued = ctx.messageQueue.drain(drainProject, nameSlug)
    if (queued.length > 0) {
      const targetWs = ctx.conversations.getConversationSocket(ccSessionId)
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
  ctx.conversations.addEvent(conversationId, data as import('../../shared/protocol').HookEvent)
  const toolName = (data.data as Record<string, unknown>)?.tool_name
  ctx.log.debug(`${(data.hookEvent as string) || 'hook'}${toolName ? ` (${toolName})` : ''}`)
}

// ─── Heartbeat (keep-alive, no activity tracking) ──────────────────

const heartbeat: MessageHandler = () => {
  // Heartbeats keep the WS alive but do NOT count as activity.
}

// ─── Session clear (re-key on /clear) ──────────────────────────────

const sessionClear: MessageHandler = (ctx, data) => {
  const oldId = (data.oldSessionId as string) || ctx.ws.data.conversationId
  const newId = data.newSessionId as string
  const clearConversationId = (data.conversationId as string) || ctx.ws.data.conversationId
  if (!oldId || !newId || !clearConversationId) return

  const clearProject = (data.project as string) ?? cwdToProjectUri(data.cwd as string)

  const conversation = ctx.conversations.rekeyConversation(
    oldId,
    newId,
    clearConversationId,
    clearProject,
    data.model as string,
  )
  if (conversation) {
    ctx.ws.data.conversationId = newId
    ctx.log.debug(
      `Conversation re-keyed: ${oldId.slice(0, 8)} -> ${newId.slice(0, 8)} conv=${clearConversationId.slice(0, 8)} (${extractProjectLabel(clearProject)})`,
    )
  } else {
    ctx.log.debug(`session_clear: old conversation ${oldId.slice(0, 8)} not found, creating new`)
    ctx.conversations.createConversation(newId, clearProject, data.model as string)
    ctx.ws.data.conversationId = newId
    ctx.conversations.setConversationSocket(newId, clearConversationId, ctx.ws)
  }
}

// ─── Notify (push notification from wrapper) ───────────────────────

const notify: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  const label =
    (conversation?.project ? extractProjectLabel(conversation.project) : null) ||
    conversationId?.slice(0, 8) ||
    'rclaude'
  const message = (data.message as string) || 'Notification'
  const title = (data.title as string) || label
  console.log(`[notify] ${title}: ${message}`)

  if (ctx.push.configured) {
    ctx.push.sendToAll({ title, body: message, conversationId, tag: `notify-${conversationId}` })
  }

  const toastMsg = { type: 'toast', title, message, conversationId: conversationId }
  if (conversation?.project) ctx.broadcastScoped(toastMsg, conversation.project)
  else ctx.broadcast(toastMsg)
}

// ─── Session end ───────────────────────────────────────────────────

const end: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  const endConversationId = ctx.ws.data.conversationId as string
  if (!conversationId || !endConversationId) return

  // Capture conversation before ending (for ad-hoc notification)
  const conversation = ctx.conversations.getConversation(conversationId)

  ctx.conversations.removeConversationSocket(conversationId, endConversationId)
  const remaining = ctx.conversations.getActiveConversationCount(conversationId)
  if (remaining === 0) {
    ctx.conversations.endConversation(conversationId, (data.reason as string) || '')
    ctx.log.debug(`Conversation ended: ${conversationId.slice(0, 8)}... (${data.reason})`)

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
      if (conversation.project) ctx.broadcastScoped(toastMsg, conversation.project)
      else ctx.broadcast(toastMsg)

      ctx.push.sendToAll({
        title: 'Task completed',
        body: `${title} - completed in ${elapsedStr}${costStr}`,
        data: { taskId: conversation.adHocTaskId, url: `/#task/${conversation.adHocTaskId}` },
        tag: `adhoc-${conversationId}`,
      })

      ctx.log.info(`[ad-hoc] Task completed: ${conversation.adHocTaskId} (${elapsedStr}${costStr})`)
    }
  } else {
    ctx.log.debug(
      `ConversationId ${endConversationId.slice(0, 8)} ended for conversation ${conversationId.slice(0, 8)}... (${remaining} conversation(s) remaining)`,
    )
  }
}

// ─── Session status signal (backend-agnostic active/idle) ──────────

const sessionStatus: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation || conversation.status === 'ended') return

  const status = data.status as 'active' | 'idle'
  if (status !== 'active' && status !== 'idle') return
  if (conversation.status === status) return // no-op

  conversation.status = status
  conversation.lastActivity = Date.now()
  if (status === 'active') {
    // Clear stale error/rate-limit on resume
    if (conversation.lastError) conversation.lastError = undefined
    if (conversation.rateLimit) conversation.rateLimit = undefined
  }
  ctx.conversations.broadcastConversationUpdate(conversationId)
  ctx.log.debug(`session_status: ${conversationId.slice(0, 8)} -> ${status}`)
}

export function registerConversationLifecycleHandlers(): void {
  registerHandlers({
    meta,
    hook,
    heartbeat,
    session_clear: sessionClear,
    session_status: sessionStatus,
    notify,
    end,
  })
}
