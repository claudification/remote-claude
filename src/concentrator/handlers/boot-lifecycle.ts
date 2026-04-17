/**
 * Boot lifecycle handlers (wrapper_boot / boot_event / session_promote).
 *
 * The wrapper opens its WS to the concentrator BEFORE Claude Code is spawned
 * so the dashboard shows "booting" state and receives live progress events.
 * Once CC produces a session id (via stream-json `init` or SessionStart hook),
 * the wrapper sends `session_promote` to migrate the booting session into the
 * real one.
 */

import type {
  BootStep,
  TranscriptBootEntry,
  TranscriptLaunchEntry,
  WrapperCapability,
  WrapperLaunchPhase,
  WrapperLaunchStep,
} from '../../shared/protocol'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

const wrapperBoot: MessageHandler = (ctx, data) => {
  const wrapperId = data.wrapperId as string
  const cwd = data.cwd as string
  if (!wrapperId || !cwd) {
    ctx.log.debug(`[boot] wrapper_boot missing wrapperId or cwd, ignoring`)
    return
  }

  // Track the WS so subsequent messages from this wrapper are routed here.
  ctx.ws.data.sessionId = wrapperId
  ctx.ws.data.wrapperId = wrapperId

  // Merge any pending launch config stored at spawn time (keyed by wrapperId).
  const pendingLaunchConfig = ctx.sessions.consumePendingLaunchConfig(wrapperId)

  const existing = ctx.sessions.getSession(wrapperId)
  const capabilities = (data.capabilities as WrapperCapability[] | undefined) || []
  const claudeArgs = (data.claudeArgs as string[] | undefined) || []

  if (existing) {
    existing.status = 'booting'
    existing.lastActivity = Date.now()
    if (pendingLaunchConfig && !existing.launchConfig) existing.launchConfig = pendingLaunchConfig
  } else {
    // Create a placeholder session keyed by wrapperId -- the real sessionId
    // replaces this once session_promote arrives.
    const placeholder = ctx.sessions.createSession(wrapperId, cwd, undefined, claudeArgs, capabilities)
    placeholder.status = 'booting'
    if (pendingLaunchConfig) placeholder.launchConfig = pendingLaunchConfig
    if (data.claudeVersion) placeholder.claudeVersion = data.claudeVersion as string
    if (data.claudeAuth) placeholder.claudeAuth = data.claudeAuth as Record<string, unknown>
    if (data.title) placeholder.title = data.title as string
  }

  // Register the WS as this session's socket so messages (including boot
  // events) can be tagged with it.
  ctx.sessions.setSessionSocket(wrapperId, wrapperId, ctx.ws)
  ctx.sessions.broadcastSessionUpdate(wrapperId)
  ctx.log.debug(`[boot] wrapper_boot: ${wrapperId.slice(0, 8)} cwd=${cwd}`)
}

const bootEvent: MessageHandler = (ctx, data) => {
  const wrapperId = data.wrapperId as string
  const step = data.step as BootStep
  if (!wrapperId || !step) return

  const session = ctx.sessions.getSession(wrapperId) || ctx.sessions.getSessionByWrapper(wrapperId)
  if (!session) {
    ctx.log.debug(`[boot] boot_event for unknown wrapper: ${wrapperId.slice(0, 8)} step=${step}`)
    return
  }

  const entry: TranscriptBootEntry = {
    type: 'boot',
    step,
    detail: (data.detail as string | undefined) ?? undefined,
    raw: data.raw,
    timestamp: new Date().toISOString(),
  }

  // Append to the session's transcript + broadcast to dashboard subscribers.
  ctx.sessions.addTranscriptEntries(session.id, [entry], false)
  ctx.sessions.broadcastToChannel('session:transcript', session.id, {
    type: 'transcript_entries',
    sessionId: session.id,
    entries: [entry],
    isInitial: false,
  })
}

const launchEvent: MessageHandler = (ctx, data) => {
  const wrapperId = data.wrapperId as string
  const step = data.step as WrapperLaunchStep
  const launchId = data.launchId as string
  const phase = data.phase as WrapperLaunchPhase
  if (!wrapperId || !step || !launchId || !phase) return

  // Route via wrapperId (stable across rekeys) or the session id on the event.
  const sessionIdFromEvent = data.sessionId as string | null
  const session =
    (sessionIdFromEvent ? ctx.sessions.getSession(sessionIdFromEvent) : undefined) ||
    ctx.sessions.getSession(wrapperId) ||
    ctx.sessions.getSessionByWrapper(wrapperId)
  if (!session) {
    ctx.log.debug(`[launch] event for unknown wrapper: ${wrapperId.slice(0, 8)} step=${step}`)
    return
  }

  const entry: TranscriptLaunchEntry = {
    type: 'launch',
    launchId,
    phase,
    step,
    detail: (data.detail as string | undefined) ?? undefined,
    raw: (data.raw as Record<string, unknown> | undefined) ?? undefined,
    timestamp: new Date().toISOString(),
  }

  ctx.sessions.addTranscriptEntries(session.id, [entry], false)
  ctx.sessions.broadcastToChannel('session:transcript', session.id, {
    type: 'transcript_entries',
    sessionId: session.id,
    entries: [entry],
    isInitial: false,
  })
}

const sessionPromote: MessageHandler = (ctx, data) => {
  const wrapperId = data.wrapperId as string
  const newSessionId = data.sessionId as string
  if (!wrapperId || !newSessionId) return

  const bootSession = ctx.sessions.getSession(wrapperId)
  if (!bootSession) {
    ctx.log.debug(`[boot] session_promote for unknown wrapper: ${wrapperId.slice(0, 8)}`)
    return
  }

  if (wrapperId === newSessionId) {
    // Nothing to migrate -- just flip status out of booting; meta handler
    // will take over with full metadata.
    bootSession.status = 'starting'
    ctx.sessions.broadcastSessionUpdate(newSessionId)
    return
  }

  // Re-key the booting session to the real session id. This moves the
  // transcript (including boot entries), sockets, subscriptions, etc.
  const rekeyed = ctx.sessions.rekeySession(wrapperId, newSessionId, wrapperId, bootSession.cwd, undefined)
  if (!rekeyed) {
    ctx.log.debug(`[boot] rekey failed for ${wrapperId.slice(0, 8)} -> ${newSessionId.slice(0, 8)}`)
    return
  }
  rekeyed.status = 'starting'
  ctx.ws.data.sessionId = newSessionId
  ctx.log.debug(
    `[boot] promoted ${wrapperId.slice(0, 8)} -> ${newSessionId.slice(0, 8)} (source=${data.source || 'unknown'})`,
  )
}

export function registerBootLifecycleHandlers(): void {
  registerHandlers({
    wrapper_boot: wrapperBoot,
    boot_event: bootEvent,
    launch_event: launchEvent,
    session_promote: sessionPromote,
  })
}
