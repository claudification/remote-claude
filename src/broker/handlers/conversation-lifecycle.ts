/**
 * Session lifecycle handlers: meta (connect/resume), hook events,
 * heartbeat, session clear (re-key), notify, and end.
 */

import { cwdToProjectUri, extractProjectLabel } from '../../shared/project-uri'
import { slugify } from '../address-book'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

// ─── Session meta (wrapper connecting) ─────────────────────────────

const meta: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.wrapperId || data.sessionId) as string // wrapperId: one-release backward compat
  const sessionId = data.sessionId as string
  const project = (data.project as string) ?? cwdToProjectUri(data.cwd as string)
  ctx.ws.data.sessionId = sessionId
  ctx.ws.data.conversationId = conversationId

  // Consume pending launch config (stored at spawn time, keyed by conversationId)
  const pendingLaunchConfig = ctx.conversations.consumePendingLaunchConfig(conversationId)

  const existingSession = ctx.conversations.getConversation(sessionId)
  if (existingSession) {
    ctx.conversations.resumeConversation(sessionId)
    existingSession.project = project
    if (data.capabilities) existingSession.capabilities = data.capabilities
    if (data.version) existingSession.version = data.version as string
    if (data.buildTime) existingSession.buildTime = data.buildTime as string
    if (data.claudeVersion) existingSession.claudeVersion = data.claudeVersion as string
    if (data.claudeAuth) existingSession.claudeAuth = data.claudeAuth as Record<string, unknown>
    if (data.spinnerVerbs) existingSession.spinnerVerbs = data.spinnerVerbs as string[]
    if (data.autocompactPct) existingSession.autocompactPct = data.autocompactPct as number
    if (data.maxBudgetUsd) existingSession.maxBudgetUsd = data.maxBudgetUsd as number
    if (data.adHocTaskId) existingSession.adHocTaskId = data.adHocTaskId as string
    if (data.adHocWorktree) existingSession.adHocWorktree = data.adHocWorktree as string
    // Only set launchConfig on first connect (spawn), don't overwrite on revive
    if (pendingLaunchConfig && !existingSession.launchConfig) {
      existingSession.launchConfig = pendingLaunchConfig
      if (pendingLaunchConfig.effort) existingSession.effortLevel = pendingLaunchConfig.effort
      if (pendingLaunchConfig.agent) existingSession.agentName = pendingLaunchConfig.agent
    }
    ctx.log.debug(
      `Session resumed: ${sessionId.slice(0, 8)}... conv=${conversationId.slice(0, 8)} (${data.cwd}) [${ctx.conversations.getActiveConversationCount(sessionId) + 1} conversation(s)]${data.version ? ` [${data.version}]` : ''}`,
    )
  } else {
    const newSession = ctx.conversations.createConversation(
      sessionId,
      project,
      data.model as string,
      data.args,
      data.capabilities,
    )
    if (data.version) newSession.version = data.version as string
    if (data.buildTime) newSession.buildTime = data.buildTime as string
    if (data.claudeVersion) newSession.claudeVersion = data.claudeVersion as string
    if (data.spinnerVerbs) newSession.spinnerVerbs = data.spinnerVerbs as string[]
    if (data.autocompactPct) newSession.autocompactPct = data.autocompactPct as number
    if (data.maxBudgetUsd) newSession.maxBudgetUsd = data.maxBudgetUsd as number
    if (data.adHocTaskId) newSession.adHocTaskId = data.adHocTaskId as string
    if (data.adHocWorktree) newSession.adHocWorktree = data.adHocWorktree as string
    if (pendingLaunchConfig) {
      newSession.launchConfig = pendingLaunchConfig
      if (pendingLaunchConfig.effort) newSession.effortLevel = pendingLaunchConfig.effort
      if (pendingLaunchConfig.agent) newSession.agentName = pendingLaunchConfig.agent
    }
    const isAdHoc = (data.capabilities as string[] | undefined)?.includes('ad-hoc')
    ctx.log.debug(
      `Session started: ${sessionId.slice(0, 8)}... conv=${conversationId.slice(0, 8)} (${data.cwd})${data.version ? ` [${data.version}]` : ''}`,
    )
    if (isAdHoc) {
      ctx.log.info(
        `[ad-hoc] Session connected: ${sessionId.slice(0, 8)} task=${data.adHocTaskId || 'none'} worktree=${data.adHocWorktree || 'none'} caps=[${(data.capabilities as string[])?.join(',') || ''}]`,
      )
    }
  }

  ctx.conversations.setConversationSocket(sessionId, conversationId, ctx.ws)

  // Auto-restore persisted links for this session's project
  const sessionProject = (existingSession || ctx.conversations.getConversation(sessionId))?.project
  if (sessionProject) {
    const persistedLinks = ctx.getLinksForProject(sessionProject)
    for (const pl of persistedLinks) {
      const otherProject = pl.projectA === sessionProject ? pl.projectB : pl.projectA
      for (const s of ctx.conversations.getActiveConversations()) {
        if (s.project === otherProject && s.id !== sessionId) {
          ctx.conversations.linkProjects(sessionId, s.id)
          ctx.log.debug(
            `[links] Auto-restored: ${sessionId.slice(0, 8)} (${extractProjectLabel(sessionProject)}) <-> ${s.id.slice(0, 8)} (${extractProjectLabel(otherProject)})`,
          )
        }
      }
    }
  }

  ctx.conversations.broadcastConversationUpdate(sessionId)

  // Complete launch job if this conversationId is tracked
  ctx.conversations.completeJob(conversationId, sessionId)

  // Check rendezvous: someone may be waiting for this wrapper to connect
  const rvResolved = ctx.conversations.resolveRendezvous(conversationId, sessionId)
  if (!rvResolved) {
    const rvInfo = ctx.conversations.getRendezvousInfo(conversationId)
    if (rvInfo) ctx.log.debug(`[rendezvous] conversationId matched but resolve failed: ${conversationId.slice(0, 8)}`)
  }

  ctx.reply({ type: 'ack', eventId: sessionId, origins: ctx.origins })

  // Drain queued messages for this CWD (sent while session was offline)
  // Pass session title so only messages targeted at this specific session
  // (or CWD-level messages with no target) are drained. Messages for other
  // sessions at the same CWD stay queued.
  const drainSession = existingSession || ctx.conversations.getConversation(sessionId)
  const drainProject = drainSession?.project
  if (drainProject) {
    const sessionNameSlug = drainSession?.title ? slugify(drainSession.title) : undefined
    const queued = ctx.messageQueue.drain(drainProject, sessionNameSlug)
    if (queued.length > 0) {
      const targetWs = ctx.conversations.getConversationSocket(sessionId)
      if (targetWs) {
        for (const item of queued) {
          targetWs.send(JSON.stringify(item.message))
        }
        ctx.log.info(
          `Drained ${queued.length} queued message(s) for ${extractProjectLabel(drainProject)}${sessionNameSlug ? `:${sessionNameSlug}` : ''}`,
        )
      }
    }
  }
}

// ─── Hook events ───────────────────────────────────────────────────

const hook: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return
  ctx.conversations.addEvent(sessionId, data as import('../../shared/protocol').HookEvent)
  const toolName = (data.data as Record<string, unknown>)?.tool_name
  ctx.log.debug(`${(data.hookEvent as string) || 'hook'}${toolName ? ` (${toolName})` : ''}`)
}

// ─── Heartbeat (keep-alive, no activity tracking) ──────────────────

const heartbeat: MessageHandler = () => {
  // Heartbeats keep the WS alive but do NOT count as activity.
}

// ─── Session clear (re-key on /clear) ──────────────────────────────

const sessionClear: MessageHandler = (ctx, data) => {
  const oldId = (data.oldSessionId as string) || ctx.ws.data.sessionId
  const newId = data.newSessionId as string
  const clearWrapperId = (data.conversationId as string) || ctx.ws.data.conversationId
  if (!oldId || !newId || !clearWrapperId) return

  const clearProject = (data.project as string) ?? cwdToProjectUri(data.cwd as string)

  const session = ctx.conversations.rekeyConversation(oldId, newId, clearWrapperId, clearProject, data.model as string)
  if (session) {
    ctx.ws.data.sessionId = newId
    ctx.log.debug(
      `Session re-keyed: ${oldId.slice(0, 8)} -> ${newId.slice(0, 8)} conv=${clearWrapperId.slice(0, 8)} (${extractProjectLabel(clearProject)})`,
    )
  } else {
    ctx.log.debug(`session_clear: old session ${oldId.slice(0, 8)} not found, creating new`)
    ctx.conversations.createConversation(newId, clearProject, data.model as string)
    ctx.ws.data.sessionId = newId
    ctx.conversations.setConversationSocket(newId, clearWrapperId, ctx.ws)
  }
}

// ─── Notify (push notification from wrapper) ───────────────────────

const notify: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  const session = sessionId ? ctx.conversations.getConversation(sessionId) : undefined
  const label = (session?.project ? extractProjectLabel(session.project) : null) || sessionId?.slice(0, 8) || 'rclaude'
  const message = (data.message as string) || 'Notification'
  const title = (data.title as string) || label
  console.log(`[notify] ${title}: ${message}`)

  if (ctx.push.configured) {
    ctx.push.sendToAll({ title, body: message, sessionId, tag: `notify-${sessionId}` })
  }

  const toastMsg = { type: 'toast', title, message, sessionId }
  if (session?.project) ctx.broadcastScoped(toastMsg, session.project)
  else ctx.broadcast(toastMsg)
}

// ─── Session end ───────────────────────────────────────────────────

const end: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  const endWrapperId = ctx.ws.data.conversationId as string
  if (!sessionId || !endWrapperId) return

  // Capture session before ending (for ad-hoc notification)
  const session = ctx.conversations.getConversation(sessionId)

  ctx.conversations.removeConversationSocket(sessionId, endWrapperId)
  const remaining = ctx.conversations.getActiveConversationCount(sessionId)
  if (remaining === 0) {
    ctx.conversations.endConversation(sessionId, (data.reason as string) || '')
    ctx.log.debug(`Session ended: ${sessionId.slice(0, 8)}... (${data.reason})`)

    // Ad-hoc session completion notification
    if (session?.capabilities?.includes('ad-hoc') && session.adHocTaskId) {
      const elapsed = Math.round((Date.now() - session.startedAt) / 1000)
      const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`
      const title = session.title || session.adHocTaskId
      const costStr = session.stats?.totalCostUsd ? ` ($${session.stats.totalCostUsd.toFixed(2)})` : ''

      const toastMsg = {
        type: 'toast' as const,
        title: 'Task completed',
        message: `${title} (${elapsedStr}${costStr})`,
        variant: 'success' as const,
        taskId: session.adHocTaskId,
        sessionId,
      }
      if (session.project) ctx.broadcastScoped(toastMsg, session.project)
      else ctx.broadcast(toastMsg)

      ctx.push.sendToAll({
        title: 'Task completed',
        body: `${title} - completed in ${elapsedStr}${costStr}`,
        data: { taskId: session.adHocTaskId, url: `/#task/${session.adHocTaskId}` },
        tag: `adhoc-${sessionId}`,
      })

      ctx.log.info(`[ad-hoc] Task completed: ${session.adHocTaskId} (${elapsedStr}${costStr})`)
    }
  } else {
    ctx.log.debug(
      `Wrapper ${endWrapperId.slice(0, 8)} ended for session ${sessionId.slice(0, 8)}... (${remaining} conversation(s) remaining)`,
    )
  }
}

// ─── Session status signal (backend-agnostic active/idle) ──────────

const sessionStatus: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return
  const session = ctx.conversations.getConversation(sessionId)
  if (!session || session.status === 'ended') return

  const status = data.status as 'active' | 'idle'
  if (status !== 'active' && status !== 'idle') return
  if (session.status === status) return // no-op

  session.status = status
  session.lastActivity = Date.now()
  if (status === 'active') {
    // Clear stale error/rate-limit on resume
    if (session.lastError) session.lastError = undefined
    if (session.rateLimit) session.rateLimit = undefined
  }
  ctx.conversations.broadcastConversationUpdate(sessionId)
  ctx.log.debug(`session_status: ${sessionId.slice(0, 8)} -> ${status}`)
}

export function registerSessionLifecycleHandlers(): void {
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
