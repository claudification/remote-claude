/**
 * Session lifecycle handlers: meta (connect/resume), hook events,
 * heartbeat, session clear (re-key), notify, and end.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

// ─── Session meta (wrapper connecting) ─────────────────────────────

const meta: MessageHandler = (ctx, data) => {
  const wrapperId = (data.wrapperId as string) || (data.sessionId as string) // backwards compat
  const sessionId = data.sessionId as string
  ctx.ws.data.sessionId = sessionId
  ctx.ws.data.wrapperId = wrapperId

  const existingSession = ctx.sessions.getSession(sessionId)
  if (existingSession) {
    ctx.sessions.resumeSession(sessionId)
    if (data.capabilities) existingSession.capabilities = data.capabilities
    if (data.version) existingSession.version = data.version as string
    if (data.buildTime) existingSession.buildTime = data.buildTime as string
    if (data.claudeVersion) existingSession.claudeVersion = data.claudeVersion as string
    if (data.claudeAuth) existingSession.claudeAuth = data.claudeAuth as Record<string, unknown>
    if (data.spinnerVerbs) existingSession.spinnerVerbs = data.spinnerVerbs as string[]
    ctx.log.debug(
      `Session resumed: ${sessionId.slice(0, 8)}... wrapper=${wrapperId.slice(0, 8)} (${data.cwd}) [${ctx.sessions.getActiveWrapperCount(sessionId) + 1} wrapper(s)]${data.version ? ` [${data.version}]` : ''}`,
    )
  } else {
    const newSession = ctx.sessions.createSession(
      sessionId,
      data.cwd as string,
      data.model as string,
      data.args,
      data.capabilities,
    )
    if (data.version) newSession.version = data.version as string
    if (data.buildTime) newSession.buildTime = data.buildTime as string
    if (data.claudeVersion) newSession.claudeVersion = data.claudeVersion as string
    if (data.spinnerVerbs) newSession.spinnerVerbs = data.spinnerVerbs as string[]
    ctx.log.debug(
      `Session started: ${sessionId.slice(0, 8)}... wrapper=${wrapperId.slice(0, 8)} (${data.cwd})${data.version ? ` [${data.version}]` : ''}`,
    )
  }

  ctx.sessions.setSessionSocket(sessionId, wrapperId, ctx.ws)

  // Auto-restore persisted links for this session's CWD
  const sessionCwd = (existingSession || ctx.sessions.getSession(sessionId))?.cwd
  if (sessionCwd) {
    const persistedLinks = ctx.getLinksForCwd(sessionCwd)
    for (const pl of persistedLinks) {
      const otherCwd = pl.cwdA === sessionCwd ? pl.cwdB : pl.cwdA
      for (const s of ctx.sessions.getActiveSessions()) {
        if (s.cwd === otherCwd && s.id !== sessionId) {
          ctx.sessions.linkSessions(sessionId, s.id)
          ctx.log.debug(
            `[links] Auto-restored: ${sessionId.slice(0, 8)} (${sessionCwd.split('/').pop()}) <-> ${s.id.slice(0, 8)} (${otherCwd.split('/').pop()})`,
          )
        }
      }
    }
  }

  ctx.sessions.broadcastSessionUpdate(sessionId)

  // Check rendezvous: someone may be waiting for this wrapper to connect
  const rvResolved = ctx.sessions.resolveRendezvous(wrapperId, sessionId)
  if (!rvResolved) {
    const rvInfo = ctx.sessions.getRendezvousInfo(wrapperId)
    if (rvInfo) ctx.log.debug(`[rendezvous] wrapperId matched but resolve failed: ${wrapperId.slice(0, 8)}`)
  }

  ctx.reply({ type: 'ack', eventId: sessionId, origins: ctx.origins })

  // Drain queued messages for this CWD (sent while session was offline)
  const drainCwd = (existingSession || ctx.sessions.getSession(sessionId))?.cwd
  if (drainCwd) {
    const queued = ctx.messageQueue.drain(drainCwd)
    if (queued.length > 0) {
      const targetWs = ctx.sessions.getSessionSocket(sessionId)
      if (targetWs) {
        for (const item of queued) {
          targetWs.send(JSON.stringify(item.message))
        }
        ctx.log.info(`Drained ${queued.length} queued message(s) for ${drainCwd.split('/').pop()}`)
      }
    }
  }
}

// ─── Hook events ───────────────────────────────────────────────────

const hook: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return
  ctx.sessions.addEvent(sessionId, data as import('../../shared/protocol').HookEvent)
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
  const clearWrapperId = (data.wrapperId as string) || ctx.ws.data.wrapperId
  if (!oldId || !newId || !clearWrapperId) return

  const session = ctx.sessions.rekeySession(oldId, newId, clearWrapperId, data.cwd as string, data.model as string)
  if (session) {
    ctx.ws.data.sessionId = newId
    ctx.log.debug(
      `Session re-keyed: ${oldId.slice(0, 8)} -> ${newId.slice(0, 8)} wrapper=${clearWrapperId.slice(0, 8)} (${data.cwd})`,
    )
  } else {
    ctx.log.debug(`session_clear: old session ${oldId.slice(0, 8)} not found, creating new`)
    ctx.sessions.createSession(newId, data.cwd as string, data.model as string)
    ctx.ws.data.sessionId = newId
    ctx.sessions.setSessionSocket(newId, clearWrapperId, ctx.ws)
  }
}

// ─── Notify (push notification from wrapper) ───────────────────────

const notify: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  const session = sessionId ? ctx.sessions.getSession(sessionId) : undefined
  const cwd = session?.cwd?.split('/').slice(-2).join('/') || sessionId?.slice(0, 8) || 'rclaude'
  const message = (data.message as string) || 'Notification'
  const title = (data.title as string) || cwd
  console.log(`[notify] ${title}: ${message}`)

  if (ctx.push.configured) {
    ctx.push.sendToAll({ title, body: message, sessionId, tag: `notify-${sessionId}` })
  }

  const toastMsg = { type: 'toast', title, message, sessionId }
  if (session?.cwd) ctx.broadcastScoped(toastMsg, session.cwd)
  else ctx.broadcast(toastMsg)
}

// ─── Session end ───────────────────────────────────────────────────

const end: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  const endWrapperId = ctx.ws.data.wrapperId as string
  if (!sessionId || !endWrapperId) return

  ctx.sessions.removeSessionSocket(sessionId, endWrapperId)
  const remaining = ctx.sessions.getActiveWrapperCount(sessionId)
  if (remaining === 0) {
    ctx.sessions.endSession(sessionId, (data.reason as string) || '')
    ctx.log.debug(`Session ended: ${sessionId.slice(0, 8)}... (${data.reason})`)
  } else {
    ctx.log.debug(
      `Wrapper ${endWrapperId.slice(0, 8)} ended for session ${sessionId.slice(0, 8)}... (${remaining} wrapper(s) remaining)`,
    )
  }
}

export function registerSessionLifecycleHandlers(): void {
  registerHandlers({
    meta,
    hook,
    heartbeat,
    session_clear: sessionClear,
    notify,
    end,
  })
}
