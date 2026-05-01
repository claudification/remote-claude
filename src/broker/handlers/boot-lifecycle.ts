/**
 * Boot lifecycle handlers (wrapper_boot / boot_event / session_promote).
 *
 * The wrapper opens its WS to the broker BEFORE Claude Code is spawned
 * so the dashboard shows "booting" state and receives live progress events.
 * Once CC produces a session id (via stream-json `init` or SessionStart hook),
 * the wrapper sends `session_promote` to migrate the booting session into the
 * real one.
 */

import { cwdToProjectUri, parseProjectUri } from '../../shared/project-uri'
import type {
  AgentHostCapability,
  BootStep,
  TranscriptBootEntry,
  TranscriptLaunchEntry,
  WrapperLaunchPhase,
  WrapperLaunchStep,
} from '../../shared/protocol'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

const wrapperBoot: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.wrapperId) as string
  const project = data.project as string | undefined
  const bootPath = data.cwd as string | undefined
  if (!conversationId || (!project && !bootPath)) {
    ctx.log.debug(`[boot] wrapper_boot missing conversationId or project/cwd, ignoring`)
    return
  }

  const resolvedProject = project ?? cwdToProjectUri(bootPath!)

  // Track the WS so subsequent messages from this wrapper are routed here.
  ctx.ws.data.sessionId = conversationId
  ctx.ws.data.conversationId = conversationId

  // Merge any pending launch config stored at spawn time (keyed by conversationId).
  const pendingLaunchConfig = ctx.sessions.consumePendingLaunchConfig(conversationId)

  const existing = ctx.sessions.getSession(conversationId)
  const capabilities = (data.capabilities as AgentHostCapability[] | undefined) || []
  const claudeArgs = (data.claudeArgs as string[] | undefined) || []

  const bootConfiguredModel = data.configuredModel as string | undefined

  if (existing) {
    existing.status = 'booting'
    existing.lastActivity = Date.now()
    existing.project = resolvedProject
    if (pendingLaunchConfig && !existing.launchConfig) {
      existing.launchConfig = pendingLaunchConfig
      if (pendingLaunchConfig.effort) existing.effortLevel = pendingLaunchConfig.effort
    }
    if (bootConfiguredModel) existing.configuredModel = bootConfiguredModel
  } else {
    // Create a placeholder session keyed by conversationId -- the real sessionId
    // replaces this once session_promote arrives.
    const placeholder = ctx.sessions.createSession(conversationId, resolvedProject, undefined, claudeArgs, capabilities)
    placeholder.status = 'booting'
    if (pendingLaunchConfig) {
      placeholder.launchConfig = pendingLaunchConfig
      if (pendingLaunchConfig.effort) placeholder.effortLevel = pendingLaunchConfig.effort
    }
    if (data.claudeVersion) placeholder.claudeVersion = data.claudeVersion as string
    if (data.claudeAuth) placeholder.claudeAuth = data.claudeAuth as Record<string, unknown>
    if (data.title) placeholder.title = data.title as string
    if (data.description) placeholder.description = data.description as string
    if (bootConfiguredModel) placeholder.configuredModel = bootConfiguredModel
  }

  // Register the WS as this session's socket so messages (including boot
  // events) can be tagged with it.
  ctx.sessions.setSessionSocket(conversationId, conversationId, ctx.ws)
  ctx.sessions.broadcastSessionUpdate(conversationId)
  ctx.log.debug(`[boot] wrapper_boot: ${conversationId.slice(0, 8)} project=${resolvedProject}`)
}

const bootEvent: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.wrapperId) as string
  const step = data.step as BootStep
  if (!conversationId || !step) return

  const session = ctx.sessions.getSession(conversationId) || ctx.sessions.getSessionByConversation(conversationId)
  if (!session) {
    ctx.log.debug(`[boot] boot_event for unknown wrapper: ${conversationId.slice(0, 8)} step=${step}`)
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
  ctx.sessions.broadcastToChannel('conversation:transcript', session.id, {
    type: 'transcript_entries',
    sessionId: session.id,
    entries: [entry],
    isInitial: false,
  })
}

const launchEvent: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.wrapperId) as string
  const step = data.step as WrapperLaunchStep
  const launchId = data.launchId as string
  const phase = data.phase as WrapperLaunchPhase
  if (!conversationId || !step || !launchId || !phase) return

  // Route via conversationId (stable across rekeys) or the session id on the event.
  const sessionIdFromEvent = data.sessionId as string | null
  const session =
    (sessionIdFromEvent ? ctx.sessions.getSession(sessionIdFromEvent) : undefined) ||
    ctx.sessions.getSession(conversationId) ||
    ctx.sessions.getSessionByConversation(conversationId)
  if (!session) {
    ctx.log.debug(`[launch] event for unknown wrapper: ${conversationId.slice(0, 8)} step=${step}`)
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
  ctx.sessions.broadcastToChannel('conversation:transcript', session.id, {
    type: 'transcript_entries',
    sessionId: session.id,
    entries: [entry],
    isInitial: false,
  })
}

const sessionPromote: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.wrapperId) as string
  const newSessionId = data.sessionId as string
  if (!conversationId || !newSessionId) return

  const bootSession = ctx.sessions.getSession(conversationId)
  if (!bootSession) {
    ctx.log.debug(`[boot] session_promote for unknown wrapper: ${conversationId.slice(0, 8)}`)
    return
  }

  if (conversationId === newSessionId) {
    // Nothing to migrate -- just flip status out of booting; meta handler
    // will take over with full metadata.
    bootSession.status = 'starting'
    ctx.sessions.broadcastSessionUpdate(newSessionId)
    return
  }

  // Re-key the booting session to the real session id. This moves the
  // transcript (including boot entries), sockets, subscriptions, etc.
  const bootProject = bootSession.project
  const rekeyed = ctx.sessions.rekeySession(
    conversationId,
    newSessionId,
    conversationId,
    parseProjectUri(bootSession.project).path,
    undefined,
  )
  if (!rekeyed) {
    ctx.log.debug(`[boot] rekey failed for ${conversationId.slice(0, 8)} -> ${newSessionId.slice(0, 8)}`)
    return
  }
  rekeyed.status = 'starting'
  rekeyed.project = bootProject
  ctx.ws.data.sessionId = newSessionId
  ctx.log.debug(
    `[boot] promoted ${conversationId.slice(0, 8)} -> ${newSessionId.slice(0, 8)} (source=${data.source || 'unknown'})`,
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
