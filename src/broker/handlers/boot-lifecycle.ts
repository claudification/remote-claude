/**
 * Boot lifecycle handlers (wrapper_boot / boot_event / conversation_promote).
 *
 * The agent host opens its WS to the broker BEFORE Claude Code is spawned
 * so the dashboard shows "booting" state and receives live progress events.
 * Once CC produces a session id (via stream-json `init` or SessionStart hook),
 * the agent host sends `conversation_promote` to store the ccSessionId as metadata
 * on the conversation (the conversationId store key stays the same).
 */

import { createHash } from 'node:crypto'
import { cwdToProjectUri } from '../../shared/project-uri'
import type {
  AgentHostCapability,
  AgentHostLaunchPhase,
  AgentHostLaunchStep,
  BootStep,
  TranscriptBootEntry,
  TranscriptLaunchEntry,
} from '../../shared/protocol'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'
import { requireProtocolVersion } from './validate'

function deterministicUuid(key: string): string {
  const h = createHash('sha1').update(key).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const agentHostBoot: MessageHandler = (ctx, data) => {
  // Gate: protocol version. wrapper_boot is the very first frame from a
  // newly-spawned agent host -- if it speaks an older protocol, reject
  // before creating any placeholder conversation.
  if (!requireProtocolVersion(ctx, data, 'agent_host_boot')) return

  const conversationId = data.conversationId as string
  const project = data.project as string | undefined
  const bootPath = data.cwd as string | undefined
  if (!conversationId || (!project && !bootPath)) {
    ctx.log.debug(`[boot] wrapper_boot missing conversationId or project/cwd, ignoring`)
    return
  }

  const resolvedProject = project ?? cwdToProjectUri(bootPath!)

  // Track the WS so subsequent messages from this agent host are routed here.
  ctx.ws.data.conversationId = conversationId

  // Merge any pending launch config stored at spawn time (keyed by conversationId).
  const pendingLaunchConfig = ctx.conversations.consumePendingLaunchConfig(conversationId)

  const existing = ctx.conversations.getConversation(conversationId)
  const capabilities = (data.capabilities as AgentHostCapability[] | undefined) || []
  const claudeArgs = (data.claudeArgs as string[] | undefined) || []

  const bootConfiguredModel = data.configuredModel as string | undefined
  const agentHostVersion = data.version as string | undefined
  const agentHostBuildTime = data.buildTime as string | undefined
  const agentHostType = (data.agentHostType as string | undefined) || 'claude'

  if (existing) {
    existing.status = 'booting'
    existing.lastActivity = Date.now()
    existing.project = resolvedProject
    if (agentHostVersion) existing.version = agentHostVersion
    if (agentHostBuildTime) existing.buildTime = agentHostBuildTime
    existing.agentHostType = agentHostType
    if (pendingLaunchConfig && !existing.launchConfig) {
      existing.launchConfig = pendingLaunchConfig
      if (pendingLaunchConfig.effort) existing.effortLevel = pendingLaunchConfig.effort
    }
    if (bootConfiguredModel) existing.configuredModel = bootConfiguredModel
  } else {
    // Create a placeholder conversation keyed by conversationId -- the real conversationId
    // replaces this once conversation_promote arrives.
    const placeholder = ctx.conversations.createConversation(
      conversationId,
      resolvedProject,
      undefined,
      claudeArgs,
      capabilities,
    )
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
    if (agentHostVersion) placeholder.version = agentHostVersion
    if (agentHostBuildTime) placeholder.buildTime = agentHostBuildTime
    placeholder.agentHostType = agentHostType
  }

  // Register the WS as this conversation's socket so messages (including boot
  // events) can be tagged with it.
  ctx.conversations.setConversationSocket(conversationId, conversationId, ctx.ws)
  ctx.conversations.broadcastConversationUpdate(conversationId)
  const versionInfo = agentHostVersion ? ` version=${agentHostVersion}` : ''
  ctx.log.info(`[boot] ${conversationId.slice(0, 8)} type=${agentHostType}${versionInfo} project=${resolvedProject}`)
}

const bootEvent: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const step = data.step as BootStep
  if (!conversationId || !step) return

  const conv =
    ctx.conversations.getConversation(conversationId) ||
    ctx.conversations.findConversationByConversationId(conversationId)
  if (!conv) {
    ctx.log.debug(`[boot] boot_event for unknown wrapper: ${conversationId.slice(0, 8)} step=${step}`)
    return
  }

  const entry: TranscriptBootEntry = {
    type: 'boot',
    step,
    detail: (data.detail as string | undefined) ?? undefined,
    raw: data.raw,
    timestamp: new Date().toISOString(),
    uuid: deterministicUuid(`${conv.id}:boot:${step}:${data.t || ''}`),
  }

  // Append to the conversation's transcript + broadcast to dashboard subscribers.
  ctx.conversations.addTranscriptEntries(conv.id, [entry], false)
  ctx.conversations.broadcastToChannel('conversation:transcript', conv.id, {
    type: 'transcript_entries',
    conversationId: conv.id,
    entries: [entry],
    isInitial: false,
  })
}

const launchEvent: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const step = data.step as AgentHostLaunchStep
  const launchId = data.launchId as string
  const phase = data.phase as AgentHostLaunchPhase
  if (!conversationId || !step || !launchId || !phase) return

  // Route via conversationId (stable across rekeys) or the conversation id on the event.
  const conversationIdFromEvent = data.conversationId as string | null
  const conv =
    (conversationIdFromEvent ? ctx.conversations.getConversation(conversationIdFromEvent) : undefined) ||
    ctx.conversations.getConversation(conversationId) ||
    ctx.conversations.findConversationByConversationId(conversationId)
  if (!conv) {
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
    uuid: deterministicUuid(`${conv.id}:launch:${launchId}:${step}`),
  }

  ctx.conversations.addTranscriptEntries(conv.id, [entry], false)
  ctx.conversations.broadcastToChannel('conversation:transcript', conv.id, {
    type: 'transcript_entries',
    conversationId: conv.id,
    entries: [entry],
    isInitial: false,
  })
}

const conversationPromote: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const ccSessionId = data.ccSessionId as string
  if (!conversationId || !ccSessionId) return

  const bootConversation = ctx.conversations.getConversation(conversationId)
  if (!bootConversation) {
    ctx.log.debug(`[boot] conversation_promote for unknown conversation: ${conversationId.slice(0, 8)}`)
    return
  }

  // Store ccSessionId in opaque agent host meta -- broker never reads it back.
  if (!bootConversation.agentHostMeta) bootConversation.agentHostMeta = {}
  bootConversation.agentHostMeta.ccSessionId = ccSessionId
  bootConversation.status = 'starting'
  ctx.ws.data.ccSessionId = ccSessionId
  ctx.conversations.broadcastConversationUpdate(conversationId)
  ctx.log.debug(
    `[boot] promoted ${conversationId.slice(0, 8)} cc=${ccSessionId.slice(0, 8)} (source=${data.source || 'unknown'})`,
  )

  // Pull model: request transcript from agent host if broker has none.
  // The agent host reads its CC JSONL file and sends entries back.
  // UUID-based dedup in SQLite handles overlap with stream replay buffer.
  // Pull model: request transcript from agent host if broker has none.
  // Usually the stream replay buffer sends entries before promote fires,
  // so this acts as a fallback (e.g., broker restart mid-session).
  if (!ctx.conversations.hasTranscriptCache(conversationId)) {
    const socket = ctx.conversations.getConversationSocket(conversationId)
    if (socket) {
      socket.send(JSON.stringify({ type: 'transcript_request', conversationId }))
      console.log(`[${conversationId.slice(0, 8)}] [boot] requested transcript from agent host`)
    }
  }
}

export function registerBootLifecycleHandlers(): void {
  registerHandlers({
    agent_host_boot: agentHostBoot,
    boot_event: bootEvent,
    launch_event: launchEvent,
    conversation_promote: conversationPromote,
  })
}
