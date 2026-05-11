/**
 * Session Store
 * In-memory conversation registry with event storage, backed by StoreDriver for persistence
 */

import type { ServerWebSocket } from 'bun'
import { resolveContextWindow } from '../shared/context-window'
import { deriveModelName } from '../shared/models'
import { buildProjectUri, cwdToProjectUri, DEFAULT_SENTINEL_NAME, parseProjectUri } from '../shared/project-uri'
import type {
  AgentHostCapability,
  Conversation,
  ConversationSummary,
  HookEvent,
  LaunchConfig,
  SubscriptionChannel,
  SubscriptionsDiag,
  TaskInfo,
  TranscriptAssistantEntry,
  TranscriptEntry,
} from '../shared/protocol'
import { BUILD_VERSION } from '../shared/version'
import { clearSession as clearAnalyticsSession } from './analytics-store'
import { resolveBackend } from './backends'
import { addEvent as addEventImpl } from './conversation-store/add-event'
import { addTranscriptEntries as addTranscriptEntriesImpl } from './conversation-store/add-transcript-entries'
import { createChannelRegistry } from './conversation-store/channel-registry'
import { MAX_TRANSCRIPT_ENTRIES } from './conversation-store/constants'
import { assignTranscriptSeqs, type ConversationStoreContext } from './conversation-store/event-context'
import { createListenerRegistry } from './conversation-store/listeners'
import { createProjectLinkRegistry } from './conversation-store/project-links'
import {
  createSentinelState,
  isSentinelAlive as isSentinelAliveImpl,
  pushSentinelDiag as pushSentinelDiagImpl,
  recordSentinelHeartbeat as recordSentinelHeartbeatImpl,
  removeSentinel as removeSentinelImpl,
  type SentinelIdentifyInfo,
  setClaudeEfficiency as setClaudeEfficiencyImpl,
  setClaudeHealth as setClaudeHealthImpl,
  setSentinel as setSentinelImpl,
  setUsage as setUsageImpl,
} from './conversation-store/sentinel'
import {
  createRendezvousRegistry,
  createSpawnJobRegistry,
  type PendingRestartInfo,
  type RendezvousInfo,
} from './conversation-store/spawn-jobs'
import {
  createSyncState,
  handleSyncCheck as handleSyncCheckImpl,
  type SyncState,
  stampAndBuffer as stampAndBufferImpl,
  syncStamp as syncStampImpl,
} from './conversation-store/sync-protocol'
import { createTerminalRegistry } from './conversation-store/terminal-registry'
import { createTrafficTracker } from './conversation-store/traffic'
import type { ControlPanelMessage } from './conversation-store/types'
import { createViewerRegistry } from './conversation-store/viewer-registry'
import type { UserGrant } from './permissions'
import { resolvePermissionFlags, resolvePermissions } from './permissions'
import { cancelRecap, generateRecapOnEnd, scheduleRecap } from './recap-generator'
import type { SentinelRegistry } from './sentinel-registry'
import { listShares } from './shares'
import type { StoreDriver, TaskRecord } from './store/types'

export type { ControlPanelMessage, ConversationSummary }

export interface ConversationStoreOptions {
  cacheDir?: string
  enablePersistence?: boolean
  store?: StoreDriver
  sentinelRegistry?: SentinelRegistry
}

export interface ConversationStore {
  createConversation: (
    id: string,
    project: string,
    model?: string,
    args?: string[],
    capabilities?: AgentHostCapability[],
  ) => Conversation
  resumeConversation: (id: string) => void
  clearConversation: (conversationId: string, newProject: string, model?: string) => Conversation | undefined
  getConversation: (id: string) => Conversation | undefined
  getAllConversations: () => Conversation[]
  getActiveConversations: () => Conversation[]
  addEvent: (conversationId: string, event: HookEvent) => void
  updateActivity: (conversationId: string) => void
  endConversation: (conversationId: string, reason: string) => void
  removeConversation: (conversationId: string) => void
  getConversationEvents: (conversationId: string, limit?: number, since?: number) => HookEvent[]
  updateTasks: (conversationId: string, tasks: TaskInfo[]) => void
  markAllTasksDone: (conversationId: string) => TaskInfo[]
  setConversationSocket: (conversationId: string, connectionId: string, ws: ServerWebSocket<unknown>) => void
  getConversationSocket: (conversationId: string) => ServerWebSocket<unknown> | undefined
  findSocketByConversationId: (connectionId: string) => ServerWebSocket<unknown> | undefined
  findConversationByConversationId: (connectionId: string) => Conversation | undefined
  removeConversationSocket: (conversationId: string, connectionId: string) => void
  removeConversationSocketsByRef: (ws: ServerWebSocket<unknown>) => string[]
  getActiveConversationCount: (conversationId: string) => number
  getConnectionIds: (conversationId: string) => string[]
  reapPhantomConversations: () => string[]
  // Transcript cache methods
  addTranscriptEntries: (conversationId: string, entries: TranscriptEntry[], isInitial: boolean) => void
  getTranscriptEntries: (conversationId: string, limit?: number) => TranscriptEntry[]
  hasTranscriptCache: (conversationId: string) => boolean
  loadTranscriptFromStore: (conversationId: string, limit: number) => TranscriptEntry[] | null
  addSubagentTranscriptEntries: (
    conversationId: string,
    agentId: string,
    entries: TranscriptEntry[],
    isInitial: boolean,
  ) => void
  getSubagentTranscriptEntries: (conversationId: string, agentId: string, limit?: number) => TranscriptEntry[]
  hasSubagentTranscriptCache: (conversationId: string, agentId: string) => boolean
  // Background task output methods
  addBgTaskOutput: (conversationId: string, taskId: string, data: string, done: boolean) => void
  getBgTaskOutput: (taskId: string) => string | undefined
  broadcastConversationUpdate: (conversationId: string) => void
  scheduleRecap: (conversationId: string) => void
  cancelRecap: (conversationId: string) => void
  // Terminal viewer methods (multiple viewers per conversation)
  // Terminal viewers keyed by conversationId (each PTY is on a specific rclaude instance)
  addTerminalViewer: (conversationId: string, ws: ServerWebSocket<unknown>) => void
  getTerminalViewers: (conversationId: string) => Set<ServerWebSocket<unknown>>
  removeTerminalViewer: (conversationId: string, ws: ServerWebSocket<unknown>) => void
  removeTerminalViewerBySocket: (ws: ServerWebSocket<unknown>) => void
  hasTerminalViewers: (conversationId: string) => boolean
  // JSON stream viewer methods (raw NDJSON tail for headless conversations)
  addJsonStreamViewer: (conversationId: string, ws: ServerWebSocket<unknown>) => void
  getJsonStreamViewers: (conversationId: string) => Set<ServerWebSocket<unknown>>
  removeJsonStreamViewer: (conversationId: string, ws: ServerWebSocket<unknown>) => void
  removeJsonStreamViewerBySocket: (ws: ServerWebSocket<unknown>) => void
  hasJsonStreamViewers: (conversationId: string) => boolean
  // Dashboard subscriber methods
  addSubscriber: (ws: ServerWebSocket<unknown>, protocolVersion?: number) => void
  sendConversationsList: (ws: ServerWebSocket<unknown>) => void
  handleSyncCheck: (
    ws: ServerWebSocket<unknown>,
    clientEpoch: string,
    clientSeq: number,
    clientTranscripts?: Record<string, number>,
  ) => void
  getSyncState: () => { epoch: string; seq: number }
  removeSubscriber: (ws: ServerWebSocket<unknown>) => void
  getSubscriberCount: () => number
  getSubscribers: () => Set<ServerWebSocket<unknown>>
  getShareViewerCount: (shareToken: string) => number
  // Channel subscription methods (v2 pub/sub)
  subscribeChannel: (
    ws: ServerWebSocket<unknown>,
    channel: SubscriptionChannel,
    conversationId: string,
    agentId?: string,
  ) => void
  unsubscribeChannel: (
    ws: ServerWebSocket<unknown>,
    channel: SubscriptionChannel,
    conversationId: string,
    agentId?: string,
  ) => void
  unsubscribeAllChannels: (ws: ServerWebSocket<unknown>) => void
  getChannelSubscribers: (
    channel: SubscriptionChannel,
    conversationId: string,
    agentId?: string,
  ) => Set<ServerWebSocket<unknown>>
  broadcastToChannel: (channel: SubscriptionChannel, conversationId: string, message: unknown, agentId?: string) => void
  isV2Subscriber: (ws: ServerWebSocket<unknown>) => boolean
  getSubscriptionsDiag: () => SubscriptionsDiag
  // Sentinel methods (sentinels Map internally)
  setSentinel: (ws: ServerWebSocket<unknown>, info?: SentinelIdentifyInfo) => boolean
  getSentinel: () => ServerWebSocket<unknown> | undefined
  getSentinelByAlias: (alias: string) => ServerWebSocket<unknown> | undefined
  getSentinelConnection: (sentinelId: string) => import('./conversation-store/sentinel').SentinelConnection | undefined
  getSentinelInfo: () => { machineId?: string; hostname?: string } | undefined
  getDefaultSentinelId: () => string | undefined
  getDefaultSentinelAlias: () => string | undefined
  getConnectedSentinels: () => Array<{ sentinelId: string; alias: string; hostname?: string; connectedAt: number }>
  removeSentinel: (ws: ServerWebSocket<unknown>) => void
  recordSentinelHeartbeat: (ws: ServerWebSocket<unknown>) => void
  isSentinelAlive: (sentinelId: string) => boolean
  hasSentinel: () => boolean
  // Sentinel diagnostics (structured log entries from sentinel)
  pushSentinelDiag: (entry: { t: number; type: string; msg: string; args?: unknown }) => void
  getSentinelDiag: () => Array<{ t: number; type: string; msg: string; args?: unknown }>
  // Plan usage data (from sentinel OAuth usage API polling)
  setUsage: (usage: import('../shared/protocol').UsageUpdate) => void
  getUsage: () => import('../shared/protocol').UsageUpdate | undefined
  // External status data (broker polls clanker.watch + usage.report)
  setClaudeHealth: (health: import('../shared/protocol').ClaudeHealthUpdate) => void
  getClaudeHealth: () => import('../shared/protocol').ClaudeHealthUpdate | undefined
  setClaudeEfficiency: (efficiency: import('../shared/protocol').ClaudeEfficiencyUpdate) => void
  getClaudeEfficiency: () => import('../shared/protocol').ClaudeEfficiencyUpdate | undefined
  // Request-response listeners for sentinel relay (spawn, dir listing)
  addSpawnListener: (requestId: string, cb: (result: unknown) => void) => void
  removeSpawnListener: (requestId: string) => void
  resolveSpawn: (requestId: string, result: unknown) => void
  addDirListener: (requestId: string, cb: (result: unknown) => void) => void
  removeDirListener: (requestId: string) => void
  resolveDir: (requestId: string, result: unknown) => void
  addCcSessionsListener: (requestId: string, cb: (result: unknown) => void) => void
  removeCcSessionsListener: (requestId: string) => void
  resolveCcSessions: (requestId: string, result: unknown) => void
  broadcastToConversationsForProject: (project: string, message: Record<string, unknown>) => number
  broadcastToConversationsAtCwd: (project: string, message: Record<string, unknown>) => number
  addFileListener: (requestId: string, cb: (result: unknown) => void) => void
  removeFileListener: (requestId: string) => void
  resolveFile: (requestId: string, result: unknown) => boolean
  // Launch jobs (request-scoped event channels for spawn/revive progress)
  createJob: (jobId: string, conversationId: string) => void
  recordJobConfig: (jobId: string, config: Record<string, unknown>) => void
  subscribeJob: (jobId: string, ws: ServerWebSocket<unknown>) => boolean
  unsubscribeJob: (jobId: string, ws: ServerWebSocket<unknown>) => void
  forwardJobEvent: (jobId: string, msg: Record<string, unknown>) => void
  completeJob: (connectionId: string, conversationId: string) => void
  failJob: (jobId: string, error: string) => void
  getJobByConversation: (connectionId: string) => string | undefined
  getJobDiagnostics: (jobId: string) => {
    jobId: string
    connectionId: string
    conversationId: string | null
    completed: boolean
    failed: boolean
    error: string | null
    createdAt: number
    endedAt: number | null
    elapsedMs: number
    config: Record<string, unknown> | null
    events: {
      type: string
      step?: string
      status?: string
      detail?: string | null
      t: number
    }[]
  } | null
  listActiveSpawnJobs: () => Array<{
    jobId: string
    conversationId: string
    createdAt: number
    completed: boolean
    failed: boolean
    error: string | null
    config: Record<string, unknown> | null
    lastStep: string | null
    lastStatus: string | null
  }>
  cleanupJobSubscriber: (ws: ServerWebSocket<unknown>) => void
  // Session rendezvous (spawn/revive callback)
  addRendezvous: (
    conversationId: string,
    callerConversationId: string,
    project: string,
    action: 'spawn' | 'revive' | 'restart',
  ) => Promise<Conversation>
  // Pending restart (terminate + auto-revive on disconnect)
  addPendingRestart: (conversationId: string, info: PendingRestartInfo) => void
  consumePendingRestart: (conversationId: string) => PendingRestartInfo | undefined
  resolveRendezvous: (conversationId: string, connectionId: string) => boolean
  getRendezvousInfo: (conversationId: string) => RendezvousInfo | undefined
  // Pending launch configs (set at spawn, consumed on connect to restore on revive)
  setPendingLaunchConfig: (conversationId: string, config: LaunchConfig) => void
  consumePendingLaunchConfig: (conversationId: string) => LaunchConfig | undefined
  // Pending conversation names (set at spawn, consumed on connect)
  setPendingConversationName: (conversationId: string, name: string) => void
  consumePendingConversationName: (conversationId: string) => string | undefined
  // Inter-project link management
  checkProjectLink: (from: string, to: string) => 'linked' | 'blocked' | 'unknown'
  getLinkedProjects: (conversationId: string) => Array<{ project: string; name: string }>
  linkProjects: (a: string, b: string) => void
  unlinkProjects: (a: string, b: string) => void
  blockProject: (blocker: string, blocked: string) => void
  queueProjectMessage: (from: string, to: string, message: Record<string, unknown>) => void
  drainProjectMessages: (from: string, to: string) => Array<Record<string, unknown>>
  broadcastForProject: (project: string) => void
  broadcastConversationScoped: (message: Record<string, unknown>, project: string) => void
  broadcastSharesUpdate: () => void
  recordTraffic: (direction: 'in' | 'out', bytes: number) => void
  getTrafficStats: () => {
    in: { messagesPerSec: number; bytesPerSec: number }
    out: { messagesPerSec: number; bytesPerSec: number }
  }
  saveState: () => Promise<void>
  clearState: () => Promise<void>
  flushTranscripts: () => Promise<void>
  persistConversationById: (id: string) => void
  // Gateway sockets (adapters like Hermes that serve multiple conversations on one WS).
  // Keyed per gatewayId so multiple Hermes gateways can be connected at once.
  setGatewaySocket: (gatewayId: string, gatewayType: string, alias: string, ws: ServerWebSocket<unknown>) => void
  getGatewaySocketById: (gatewayId: string) => ServerWebSocket<unknown> | undefined
  getGatewaysByType: (gatewayType: string) => Array<{ gatewayId: string; alias: string; ws: ServerWebSocket<unknown> }>
  /** Legacy: returns any open socket of the type. Prefer getGatewaySocketById. */
  getGatewaySocket: (gatewayType: string) => ServerWebSocket<unknown> | undefined
  removeGatewaySocketByRef: (ws: ServerWebSocket<unknown>) => string | undefined
}

/**
 * Create a conversation store with optional persistence
 */
export function createConversationStore(options: ConversationStoreOptions = {}): ConversationStore {
  const { store, sentinelRegistry } = options

  const conversations = new Map<string, Conversation>()
  // conversationId -> (connectionId -> socket): multiple rclaude instances can serve a conversation
  const conversationSockets = new Map<string, Map<string, ServerWebSocket<unknown>>>()
  // Terminal viewers keyed by conversationId (each PTY is on a specific conversation)
  const terminalRegistry = createTerminalRegistry()
  // JSON stream viewers keyed by conversationId (raw NDJSON tail for headless conversations)
  const jsonStreamRegistry = createViewerRegistry()
  // Gateway sockets: gatewayId -> { type, alias, ws }. Each connected gateway
  // adapter (e.g. a Hermes plugin) keeps its own entry so multi-gateway routing
  // can target a specific gateway by id. `alias` is the human-readable label
  // surfaced in URIs (hermes://{alias}/{name}). `type` lets callers fan out by
  // kind ("hermes", "custom", ...) when an id isn't supplied.
  const gatewaySockets = new Map<string, { type: string; alias: string; ws: ServerWebSocket<unknown> }>()
  const controlPanelSubscribers = new Set<ServerWebSocket<unknown>>()
  let subscriberIdCounter = 0

  // Sync protocol: extracted to sync-protocol.ts
  const sync: SyncState = createSyncState()
  function stampAndBuffer(message: unknown): string {
    return stampAndBufferImpl(sync, message)
  }
  function syncStamp(message: unknown): string {
    return syncStampImpl(sync, message)
  }

  // Traffic tracking: extracted to traffic.ts (must be before channel registry)
  const trafficTracker = createTrafficTracker()
  const { recordTraffic, getTrafficStats } = trafficTracker

  // Channel pub/sub registry -- created here so it can close over syncStamp + recordTraffic
  // which are defined in this factory. controlPanelSubscribers is a shared mutable ref.
  const channelRegistry = createChannelRegistry({
    controlPanelSubscribers,
    syncStamp,
    recordTraffic,
  })
  const {
    subscribeChannel,
    unsubscribeChannel,
    unsubscribeAllChannels,
    getChannelSubscribers,
    broadcastToChannel,
    isV2Subscriber,
    getSubscriptionsDiag,
    clearSubagentChannels,
  } = channelRegistry

  function handleSyncCheck(
    ws: ServerWebSocket<unknown>,
    clientEpoch: string,
    clientSeq: number,
    clientTranscripts?: Record<string, number>,
  ): void {
    handleSyncCheckImpl(sync, ws, clientEpoch, clientSeq, clientTranscripts, transcriptSeqCounters)
  }

  // Pending agent descriptions: PreToolUse(Agent) pushes, SubagentStart pops
  const pendingAgentDescriptions = new Map<string, string[]>()

  // Transcript cache: conversationId -> entries (ring buffer, max 1000 per conversation)
  const transcriptCache = new Map<string, TranscriptEntry[]>()
  // Dirty tracking for transcript persistence: conversations modified since last flush
  const dirtyTranscripts = new Set<string>()
  // Deduplicate clipboard captures by tool_use_id (prevents re-processing on transcript re-reads)
  const processedClipboardIds = new Set<string>()

  /** Per-conversation monotonic transcript sequence counter. Stamps `entry.seq` on
   *  every cache insert so the sync protocol can detect drift by last-seq-seen
   *  rather than by entry count (which is unreliable when caps differ between
   *  server and client, or when entries are edited in place).
   *
   *  In-memory only; not persisted. Rationale:
   *    - sync.epoch regenerates on broker restart, forcing clients to
   *      drop lastAppliedSeq and full-resync (see sync_stale path below).
   *    - Hydration from JSONL re-stamps 1..N on boot (see loadTranscripts), so
   *      seqs match cache state exactly without round-tripping through disk.
   *    - No migration burden when the counter logic changes.
   *
   *  Reset semantics:
   *    - `addTranscriptEntries(..., isInitial=true)` resets counter to 0 and
   *      re-stamps the batch from 1. Mirror the cache replace.
   *    - rekey (line 1167 area) deletes the counter alongside the cache entry.
   *    - Session delete (line 1772 area) likewise.
   */
  const transcriptSeqCounters = new Map<string, number>()

  // Subagent transcript cache: `${conversationId}:${agentId}` -> entries
  const subagentTranscriptCache = new Map<string, TranscriptEntry[]>()
  /** Per-subagent transcript seq counter. Same semantics as
   *  `transcriptSeqCounters` above, but keyed by `${conversationId}:${agentId}`. */
  const subagentTranscriptSeqCounters = new Map<string, number>()
  // Transcript kick tracking: conversationId -> last kick timestamp (debounce 60s)
  const lastTranscriptKick = new Map<string, number>()
  /** Hashes of fired mention-notifications (`${conversationId}:${uuid}:${userName}`).
   *  Memory-only: a stale binary or restart re-firing a few notifications is
   *  cheaper than persisting per-entry dedup state to disk. */
  const notifiedMentions = new Set<string>()
  // Background task output cache: taskId -> accumulated output string
  const bgTaskOutputCache = new Map<string, string>()

  /** Shared context passed to extracted addEvent / addTranscriptEntries.
   *  Function refs (scheduleConversationUpdate, broadcastConversationScoped,
   *  addTranscriptEntries, addSubagentTranscriptEntries) are forward-declared
   *  via `function` declarations below -- safe to reference here because
   *  function declarations are hoisted within the enclosing factory body. */
  const ctx: ConversationStoreContext = {
    conversations,
    conversationSockets,
    transcriptCache,
    transcriptSeqCounters,
    subagentTranscriptCache,
    subagentTranscriptSeqCounters,
    dirtyTranscripts,
    processedClipboardIds,
    pendingAgentDescriptions,
    lastTranscriptKick,
    notifiedMentions,
    store,
    scheduleConversationUpdate,
    broadcastToChannel,
    broadcastConversationScoped,
    addTranscriptEntries,
    addSubagentTranscriptEntries,
  }

  // Helper to create conversation summary for broadcasting
  function toConversationSummary(conv: Conversation): ConversationSummary {
    const wrappers = conversationSockets.get(conv.id)
    return {
      id: conv.id,
      project: conv.project,
      model: deriveModelName(conv.model, conv.configuredModel),
      capabilities: conv.capabilities,
      version: conv.version,
      buildTime: conv.buildTime,
      claudeVersion: conv.claudeVersion,
      claudeAuth: conv.claudeAuth,
      spinnerVerbs: conv.spinnerVerbs,
      autocompactPct: conv.autocompactPct,
      maxBudgetUsd: conv.maxBudgetUsd,
      connectionIds: wrappers ? Array.from(wrappers.keys()) : [],
      startedAt: conv.startedAt,
      lastActivity: conv.lastActivity,
      status: conv.status,
      compacting: conv.compacting || undefined,
      compactedAt: conv.compactedAt,
      eventCount: conv.events.length,
      activeSubagentCount: conv.subagents.filter(a => a.status === 'running').length,
      totalSubagentCount: conv.subagents.length,
      subagents: conv.subagents.map(a => ({
        agentId: a.agentId,
        agentType: a.agentType,
        description: a.description,
        status: a.status,
        startedAt: a.startedAt,
        stoppedAt: a.stoppedAt,
        eventCount: a.events.length,
        ...(a.tokenUsage && { tokenUsage: a.tokenUsage }),
      })),
      taskCount: conv.tasks.length,
      pendingTaskCount: conv.tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length,
      activeTasks: conv.tasks.filter(t => t.status === 'in_progress').map(t => ({ id: t.id, subject: t.subject })),
      pendingTasks: conv.tasks
        .filter(t => t.status === 'pending')
        .slice(0, 4)
        .map(t => ({ id: t.id, subject: t.subject })),
      archivedTaskCount: conv.archivedTasks.reduce((sum, g) => sum + g.tasks.length, 0),
      archivedTasks: conv.archivedTasks
        .flatMap(g => g.tasks)
        .slice(-50)
        .map(t => ({ id: t.id, subject: t.subject })),
      runningBgTaskCount: conv.bgTasks.filter(t => t.status === 'running').length,
      bgTasks: conv.bgTasks.map(t => ({
        taskId: t.taskId,
        command: t.command,
        description: t.description,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        status: t.status,
      })),
      monitors: conv.monitors,
      runningMonitorCount: conv.monitors.filter(m => m.status === 'running').length,
      teammates: conv.teammates.map(t => ({
        name: t.name,
        status: t.status,
        currentTaskSubject: t.currentTaskSubject,
        completedTaskCount: t.completedTaskCount,
      })),
      team: conv.team,
      effortLevel: conv.effortLevel,
      permissionMode: conv.permissionMode || undefined,
      lastError: conv.lastError,
      rateLimit: conv.rateLimit,
      planMode: conv.planMode || undefined,
      pendingAttention: conv.pendingAttention,
      hasNotification: conv.hasNotification,
      summary: conv.summary,
      title: conv.title,
      description: conv.description,
      agentName: conv.agentName,
      prLinks: conv.prLinks,
      linkedProjects: getLinkedProjects(conv.id),
      tokenUsage: conv.tokenUsage,
      contextWindow: resolveContextWindow(deriveModelName(conv.model, conv.configuredModel), conv.contextMode),
      cacheTtl: conv.cacheTtl,
      lastTurnEndedAt: conv.lastTurnEndedAt,
      stats: conv.stats,
      costTimeline: conv.costTimeline,
      gitBranch: conv.gitBranch,
      adHocTaskId: conv.adHocTaskId,
      adHocWorktree: conv.adHocWorktree,
      modelMismatch: conv.modelMismatch,
      resultText: conv.resultText,
      recap: conv.recap,
      recapFresh: conv.recapFresh,
      hostSentinelId: conv.hostSentinelId,
      hostSentinelAlias: conv.hostSentinelAlias,
      backend: conv.agentHostType || 'claude',
    }
  }

  // Broadcast to all dashboard subscribers (sequenced + buffered for sync catchup)
  function broadcast(message: ControlPanelMessage): void {
    const json = stampAndBuffer(message)
    for (const ws of controlPanelSubscribers) {
      try {
        ws.send(json)
        recordTraffic('out', json.length)
      } catch (err) {
        const subInfo = channelRegistry.getSubscriberEntry(ws)
        console.error(
          `[broadcast] Send failed to ${subInfo?.id || 'unknown'}: ${err instanceof Error ? err.message : err}`,
        )
        controlPanelSubscribers.delete(ws)
      }
    }
  }

  /** Broadcast a conversation message only to subscribers who have chat:read for that project */
  function broadcastConversationScoped(message: ControlPanelMessage, project: string): void {
    const json = stampAndBuffer(message)
    for (const ws of controlPanelSubscribers) {
      try {
        const grants = (ws.data as { grants?: UserGrant[] }).grants
        if (grants) {
          const { permissions } = resolvePermissions(grants, project)
          if (!permissions.has('chat:read')) continue
        }
        ws.send(json)
        recordTraffic('out', json.length)
      } catch (err) {
        const subInfo = channelRegistry.getSubscriberEntry(ws)
        console.error(
          `[broadcast] Send failed to ${subInfo?.id || 'unknown'}: ${err instanceof Error ? err.message : err}`,
        )
        controlPanelSubscribers.delete(ws)
      }
    }
  }

  // Coalesced session_update broadcasts: only the last update per conversation per tick is sent
  const pendingConversationUpdates = new Set<string>()
  let sessionUpdateScheduled = false

  function scheduleConversationUpdate(conversationId: string): void {
    pendingConversationUpdates.add(conversationId)
    if (!sessionUpdateScheduled) {
      sessionUpdateScheduled = true
      queueMicrotask(flushConversationUpdates)
    }
  }

  function flushConversationUpdates(): void {
    sessionUpdateScheduled = false
    for (const id of pendingConversationUpdates) {
      const conv = conversations.get(id)
      if (conv) {
        broadcastConversationScoped(
          {
            type: 'conversation_update',
            conversationId: id,
            conversation: toConversationSummary(conv),
          },
          conv.project,
        )
      }
    }
    pendingConversationUpdates.clear()
  }

  // Load persisted state from StoreDriver on startup
  if (store) {
    loadFromStore()
  }

  // Periodically mark idle conversations, clean stale agents, evict old conversations, and save state
  const ENDED_EVICTION_TTL_MS = 28 * 24 * 60 * 60 * 1000 // 28 days after ending (user can manually dismiss)
  const ZOMBIE_EVICTION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days for stale STARTING conversations
  const MAX_ENDED_SESSIONS = 200 // hard cap on ended conversations in memory

  setInterval(() => {
    const now = Date.now()
    const STALE_AGENT_MS = 10 * 60 * 1000 // 10 minutes
    const LIVENESS_MS = 5 * 60_000 // 5m without hooks = not "actively receiving"
    const toEvict: string[] = []

    for (const conv of conversations.values()) {
      let changed = false

      // Liveness check: no hooks for 30s means conversation isn't actively receiving
      if (conv.status === 'active' && now - conv.lastActivity > LIVENESS_MS) {
        conv.status = 'idle'
        changed = true
      }

      // Starting liveness: agent host connected but CC is idle (e.g. broker restart
      // while CC was waiting for input -- no events arrive to advance the status)
      if (conv.status === 'starting' && now - conv.lastActivity > 60_000) {
        if (conversationSockets.has(conv.id)) {
          conv.status = 'idle'
          changed = true
        }
      }

      // Clean up stale "running" agents (SubagentStop may have been missed)
      for (const agent of conv.subagents) {
        if (
          agent.status === 'running' &&
          now - agent.startedAt > STALE_AGENT_MS &&
          now - conv.lastActivity > STALE_AGENT_MS
        ) {
          agent.status = 'stopped'
          agent.stoppedAt = now
          changed = true
        }
      }

      // Mark ended conversations for eviction after TTL
      if (conv.status === 'ended' && now - conv.lastActivity > ENDED_EVICTION_TTL_MS) {
        toEvict.push(conv.id)
      }

      // Evict zombie conversations: STARTING with 0 events, idle > 24h, no active agent host
      if (conv.status === 'starting' && conv.events.length === 0) {
        const idleMs = now - conv.lastActivity
        if (idleMs > ZOMBIE_EVICTION_TTL_MS && !conversationSockets.has(conv.id)) {
          const hours = Math.round(idleMs / 3600000)
          console.log(`[evict] Zombie conversation ${conv.id.slice(0, 8)} (STARTING, 0 events, idle ${hours}h)`)
          toEvict.push(conv.id)
        }
      }

      if (changed) {
        scheduleConversationUpdate(conv.id)
      }
    }

    // Evict TTL-expired ended conversations
    for (const id of toEvict) {
      removeConversation(id)
    }

    // Hard cap: if too many ended conversations, evict oldest first
    const ended = Array.from(conversations.values())
      .filter(s => s.status === 'ended')
      .sort((a, b) => a.lastActivity - b.lastActivity)
    if (ended.length > MAX_ENDED_SESSIONS) {
      for (let i = 0; i < ended.length - MAX_ENDED_SESSIONS; i++) {
        removeConversation(ended[i].id)
      }
    }

    if (toEvict.length > 0 || ended.length > MAX_ENDED_SESSIONS) {
      const evictedCount = toEvict.length + Math.max(0, ended.length - MAX_ENDED_SESSIONS)
      console.log(`[eviction] Removed ${evictedCount} ended sessions (${conversations.size} remaining)`)
    }
  }, 10000)

  // StoreDriver writes are immediate -- no debounced save needed

  // Prune archived tasks older than 90 days, hourly.
  const ARCHIVED_TASK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
  setInterval(
    () => {
      if (!store) return
      try {
        const cutoff = Date.now() - ARCHIVED_TASK_RETENTION_MS
        const removed = store.tasks.pruneArchivedBefore(cutoff)
        if (removed > 0) {
          console.log(`[tasks] Pruned ${removed} archived task(s) older than 90 days`)
        }
      } catch (err) {
        console.error(`[tasks] Prune failed: ${err}`)
      }
    },
    60 * 60 * 1000,
  )

  function loadFromStore(): void {
    if (!store) return
    try {
      const records = store.conversations.list()
      let droppedBadIds = 0
      for (const rec of records) {
        // Defense in depth: SQLite TEXT PRIMARY KEY does not enforce NOT NULL,
        // so a pre-fix broker that wrote conversations with id=undefined could
        // leave NULL-id rows behind. Drop them on load -- the rest of the
        // codebase assumes conversation.id is a usable string and crashes otherwise.
        if (typeof rec.id !== 'string' || rec.id.length === 0) {
          droppedBadIds++
          continue
        }
        const meta = (rec as unknown as { meta?: Record<string, unknown> }).meta || {}
        // Full record for meta fields
        const full = store.conversations.get(rec.id)
        const fullMeta = full?.meta || meta
        const conv: Conversation = {
          id: rec.id,
          project: rec.scope || cwdToProjectUri('/'),
          model: rec.model,
          startedAt: rec.createdAt,
          lastActivity: rec.lastActivity || rec.createdAt,
          status: 'ended',
          events: [],
          subagents: ((fullMeta.subagents as Conversation['subagents']) || []).map(a => ({
            ...a,
            events: a.events || [],
            status: 'stopped' as const,
            stoppedAt: a.stoppedAt || a.startedAt,
          })),
          // Tasks live in the dedicated `tasks` SQLite table now (see Phase 1
          // task-table migration). The legacy meta.tasks/archivedTasks fields
          // are migrated into the table by `migrateTasksFromMeta` -- once
          // migrated, the meta values are stripped. Hydrate from the table.
          tasks: store
            ? store.tasks.getForConversation(rec.id, { kind: 'todo', archived: false }).map(taskRecordToInfo)
            : (fullMeta.tasks as Conversation['tasks']) || [],
          archivedTasks: store
            ? hydrateArchivedTaskGroups(rec.id)
            : (fullMeta.archivedTasks as Conversation['archivedTasks']) || [],
          bgTasks: ((fullMeta.bgTasks as Conversation['bgTasks']) || []).map(t => ({
            ...t,
            status: t.status === 'running' ? ('completed' as const) : t.status,
            completedAt: t.completedAt || t.startedAt,
          })),
          monitors: ((fullMeta.monitors as Conversation['monitors']) || []).map(m => ({
            ...m,
            status: m.status === 'running' ? ('completed' as const) : m.status,
            stoppedAt: m.stoppedAt || m.startedAt,
          })),
          teammates: (fullMeta.teammates as Conversation['teammates']) || [],
          team: fullMeta.team as Conversation['team'],
          diagLog: [],
          configuredModel: fullMeta.configuredModel as string | undefined,
          permissionMode: fullMeta.permissionMode as string | undefined,
          effortLevel: fullMeta.effortLevel as string | undefined,
          contextMode: fullMeta.contextMode as Conversation['contextMode'],
          args: fullMeta.args as string[] | undefined,
          capabilities: fullMeta.capabilities as AgentHostCapability[] | undefined,
          version: fullMeta.version as string | undefined,
          buildTime: fullMeta.buildTime as string | undefined,
          claudeVersion: fullMeta.claudeVersion as string | undefined,
          claudeAuth: fullMeta.claudeAuth as Conversation['claudeAuth'],
          transcriptPath: fullMeta.transcriptPath as string | undefined,
          compactedAt: fullMeta.compactedAt as number | undefined,
          stats: (full?.stats as unknown as Conversation['stats']) || {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheCreation: 0,
            totalCacheWrite5m: 0,
            totalCacheWrite1h: 0,
            totalCacheRead: 0,
            turnCount: 0,
            toolCallCount: 0,
            compactionCount: 0,
            linesAdded: 0,
            linesRemoved: 0,
            totalApiDurationMs: 0,
          },
          costTimeline: (fullMeta.costTimeline as Conversation['costTimeline']) || [],
          gitBranch: fullMeta.gitBranch as string | undefined,
          adHocTaskId: fullMeta.adHocTaskId as string | undefined,
          adHocWorktree: fullMeta.adHocWorktree as string | undefined,
          launchConfig: fullMeta.launchConfig as LaunchConfig | undefined,
          resultText: fullMeta.resultText as string | undefined,
          recap: fullMeta.recap as Conversation['recap'],
          recapFresh: fullMeta.recapFresh as boolean | undefined,
          title: rec.title || (fullMeta.title as string | undefined),
          titleUserSet: fullMeta.titleUserSet as boolean | undefined,
          description: fullMeta.description as string | undefined,
          summary: (full as unknown as { summary?: string })?.summary || (fullMeta.summary as string | undefined),
          agentName: fullMeta.agentName as string | undefined,
          prLinks: fullMeta.prLinks as Conversation['prLinks'],
          hostSentinelId: fullMeta.hostSentinelId as string | undefined,
          hostSentinelAlias: fullMeta.hostSentinelAlias as string | undefined,
          conversationInfo: fullMeta.conversationInfo as Conversation['conversationInfo'],
          agentHostMeta: fullMeta.agentHostMeta as Record<string, unknown> | undefined,
          agentHostType: fullMeta.agentHostType as string | undefined,
          tokenUsage: fullMeta.tokenUsage as Conversation['tokenUsage'],
          cacheTtl: fullMeta.cacheTtl as Conversation['cacheTtl'],
          lastTurnEndedAt: fullMeta.lastTurnEndedAt as number | undefined,
        }
        if (!resolveBackend(conv).requiresAgentSocket) {
          // Respect deliberate termination: if the conversation was ended with
          // an endedAt timestamp, it was user-terminated -- don't resurrect it.
          const wasTerminated = rec.status === 'ended' && rec.endedAt
          if (!wasTerminated) {
            conv.status = 'idle'
          }
        }
        conversations.set(conv.id, conv)
      }
      if (records.length > 0) {
        const loaded = records.length - droppedBadIds
        console.log(`[store] Loaded ${loaded} sessions from SQLite`)
        if (droppedBadIds > 0) {
          console.warn(
            `[store] BAD DATA: dropped ${droppedBadIds} conversation record(s) with null/empty id from SQLite. These are leftover from a pre-validation broker that accepted malformed meta. The broker self-cleans these on next persistConversation cycle.`,
          )
        }
      }
    } catch (err) {
      console.error(`[store] Failed to load sessions: ${err}`)
    }
  }

  function persistConversationById(id: string): void {
    const conv = conversations.get(id)
    if (conv) persistConversation(conv)
  }

  function persistConversation(conv: Conversation): void {
    if (!store) return
    try {
      const existing = store.conversations.get(conv.id)
      const meta: Record<string, unknown> = {
        subagents: conv.subagents,
        // tasks/archivedTasks live in the dedicated `tasks` SQLite table now;
        // do not duplicate them in meta. Hydration reads from the table.
        bgTasks: conv.bgTasks,
        monitors: conv.monitors,
        teammates: conv.teammates,
        team: conv.team,
        configuredModel: conv.configuredModel,
        permissionMode: conv.permissionMode,
        effortLevel: conv.effortLevel,
        contextMode: conv.contextMode,
        args: conv.args,
        capabilities: conv.capabilities,
        version: conv.version,
        buildTime: conv.buildTime,
        claudeVersion: conv.claudeVersion,
        claudeAuth: conv.claudeAuth,
        transcriptPath: conv.transcriptPath,
        compactedAt: conv.compactedAt,
        costTimeline: conv.costTimeline,
        gitBranch: conv.gitBranch,
        adHocTaskId: conv.adHocTaskId,
        adHocWorktree: conv.adHocWorktree,
        launchConfig: conv.launchConfig,
        resultText: conv.resultText,
        recap: conv.recap,
        recapFresh: conv.recapFresh,
        titleUserSet: conv.titleUserSet,
        description: conv.description,
        agentName: conv.agentName,
        prLinks: conv.prLinks?.length ? conv.prLinks : undefined,
        hostSentinelId: conv.hostSentinelId,
        hostSentinelAlias: conv.hostSentinelAlias,
        conversationInfo: conv.conversationInfo,
        agentHostMeta: conv.agentHostMeta,
        agentHostType: conv.agentHostType,
        tokenUsage: conv.tokenUsage,
        summary: conv.summary,
        cacheTtl: conv.cacheTtl,
        lastTurnEndedAt: conv.lastTurnEndedAt,
      }
      if (!existing) {
        store.conversations.create({
          id: conv.id,
          scope: conv.project,
          agentType: 'rclaude',
          agentVersion: conv.version,
          title: conv.title,
          model: conv.model,
          meta,
          createdAt: conv.startedAt,
        })
      } else {
        store.conversations.update(conv.id, {
          status: conv.status,
          model: conv.model,
          title: conv.title,
          summary: conv.summary,
          lastActivity: conv.lastActivity,
          endedAt: conv.status === 'ended' ? conv.lastActivity : undefined,
          meta,
          stats: conv.stats as unknown as import('./store/types').ConversationStats,
        })
      }
    } catch (err) {
      console.error(`[store] Failed to persist conversation ${conv.id.slice(0, 8)}: ${err}`)
    }
  }

  async function saveState(): Promise<void> {
    // StoreDriver writes are immediate -- this is now a no-op
  }

  async function clearState(): Promise<void> {
    conversations.clear()
    if (store) {
      const all = store.conversations.list()
      for (const s of all) {
        store.conversations.delete(s.id)
      }
    }
  }

  // Transcript persistence is handled by StoreDriver -- no JSONL files

  async function flushTranscripts(): Promise<void> {
    // StoreDriver writes are immediate -- this is now a no-op
  }

  /** Build/rewrite a project URI using the sentinel alias as authority.
   *  - Raw CWD string: builds `claude://{alias}/path` directly
   *  - Existing URI with 'default' or empty authority: rewrites to sentinel alias
   *  - Existing URI with non-default authority: left as-is (other sentinel, Phase 2+) */
  function resolveProjectUri(projectOrCwd: string, sentinelAlias?: string): string {
    if (!projectOrCwd.includes('://')) {
      return cwdToProjectUri(projectOrCwd, 'claude', sentinelAlias)
    }
    if (!sentinelAlias || sentinelAlias === DEFAULT_SENTINEL_NAME) {
      return projectOrCwd
    }
    const parsed = parseProjectUri(projectOrCwd)
    if (parsed.scheme === 'claude' && (!parsed.authority || parsed.authority === DEFAULT_SENTINEL_NAME)) {
      return buildProjectUri({
        scheme: parsed.scheme,
        authority: sentinelAlias,
        path: parsed.path,
        fragment: parsed.fragment,
      })
    }
    return projectOrCwd
  }

  function createConversation(
    id: string,
    projectOrCwd: string,
    model?: string,
    args?: string[],
    capabilities?: AgentHostCapability[],
  ): Conversation {
    // Gate: refuse to create a conversation with an invalid id. Without this,
    // a buggy caller would key the conversations Map with `undefined`, and
    // every subsequent `.id.slice(0, 8)` against that entry would crash the
    // broker. Handlers should validate their wire input BEFORE calling this
    // (see src/broker/handlers/validate.ts), but this is defense in depth.
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `createConversation: invalid id (${typeof id} ${JSON.stringify(id)}). The handler must validate wire input before calling createConversation.`,
      )
    }
    const sentinelAlias = getDefaultSentinelAlias()
    const project = resolveProjectUri(projectOrCwd, sentinelAlias)
    const conv: Conversation = {
      id,
      project,
      model,
      args,
      capabilities,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      status: 'starting',
      events: [],
      subagents: [],
      tasks: [],
      archivedTasks: [],
      bgTasks: [],
      monitors: [],
      diagLog: [],
      teammates: [],
      stats: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreation: 0,
        totalCacheWrite5m: 0,
        totalCacheWrite1h: 0,
        totalCacheRead: 0,
        turnCount: 0,
        toolCallCount: 0,
        compactionCount: 0,
        linesAdded: 0,
        linesRemoved: 0,
        totalApiDurationMs: 0,
      },
      costTimeline: [],
      hostSentinelId: getDefaultSentinelId(),
      hostSentinelAlias: getDefaultSentinelAlias(),
    }
    conversations.set(id, conv)
    persistConversation(conv)

    // Broadcast to dashboard subscribers (scoped by grants)
    broadcastConversationScoped(
      {
        type: 'conversation_created',
        conversationId: id,
        conversation: toConversationSummary(conv),
      },
      conv.project,
    )

    // Push per-conversation permissions to scoped subscribers so the client can
    // immediately include the new conversation in its filtered list.
    for (const ws of controlPanelSubscribers) {
      try {
        const grants = (ws.data as { grants?: UserGrant[] }).grants
        if (!grants) continue // admins don't use conversationPermissions
        const { permissions } = resolvePermissions(grants, conv.project)
        if (!permissions.has('chat:read')) continue
        ws.send(
          JSON.stringify({
            type: 'permissions',
            sessions: { [id]: resolvePermissionFlags(grants, conv.project) },
          }),
        )
      } catch {}
    }

    return conv
  }

  function resumeConversation(id: string): void {
    const conv = conversations.get(id)
    if (conv) {
      conv.status = 'idle'
      conv.lastActivity = Date.now()
      // Reset stale state from previous run
      conv.subagents = []
      conv.teammates = []
      conv.team = undefined
      conv.compacting = false
      conv.lastError = undefined
      conv.rateLimit = undefined
      // Mark stale bg tasks as killed
      for (const bgTask of conv.bgTasks) {
        if (bgTask.status === 'running') {
          bgTask.status = 'killed'
          bgTask.completedAt = Date.now()
        }
      }
      // Notify dashboards that this conversation resumed - triggers transcript re-fetch
      broadcastConversationScoped(
        {
          type: 'conversation_update',
          conversationId: id,
          conversation: toConversationSummary(conv),
        },
        conv.project,
      )
    }
  }

  // Handle /clear: reset ephemeral state, store new ccSessionId in opaque meta.
  // The conversation key (conversationId) does NOT change.
  function clearConversation(
    conversationId: string,
    newProjectOrCwd: string,
    newModel?: string,
  ): Conversation | undefined {
    const newProject = newProjectOrCwd.includes('://') ? newProjectOrCwd : cwdToProjectUri(newProjectOrCwd)
    const conv = conversations.get(conversationId)
    if (!conv) return undefined

    conv.project = newProject
    if (newModel) conv.model = newModel
    conv.status = 'idle'
    conv.lastActivity = Date.now()
    persistConversation(conv)

    // Reset ephemeral state (preserve compacting flag - processEvent handles the transition)
    const wasCompacting = conv.compacting
    conv.events = []
    conv.subagents = []
    conv.teammates = []
    conv.team = undefined
    conv.tasks = []
    conv.archivedTasks = []
    conv.diagLog = []
    conv.tokenUsage = undefined
    conv.summary = undefined
    conv.recap = undefined
    conv.recapFresh = undefined
    for (const bgTask of conv.bgTasks) {
      if (bgTask.status === 'running') {
        bgTask.status = 'killed'
        bgTask.completedAt = Date.now()
      }
    }

    // Clear transcript caches + seq counters. Key is stable (conversationId), but
    // the transcript content is stale after /clear -- wipe it so the fresh conversation
    // starts with a clean slate.
    transcriptCache.delete(conversationId)
    transcriptSeqCounters.delete(conversationId)
    dirtyTranscripts.delete(conversationId)
    for (const key of subagentTranscriptCache.keys()) {
      if (key.startsWith(`${conversationId}:`)) {
        subagentTranscriptCache.delete(key)
        subagentTranscriptSeqCounters.delete(key)
      }
    }

    // No socket or channel migration needed -- conversationId didn't change.
    // Clear subagent channel subscriptions (subagents are gone after /clear).
    clearSubagentChannels(conversationId)

    // Tell dashboard subscribers to wipe their local transcript cache.
    // Without this, the dashboard keeps showing stale entries from before /clear.
    broadcastToChannel('conversation:transcript', conversationId, {
      type: 'transcript_entries',
      conversationId,
      entries: [],
      isInitial: true,
    })

    broadcastConversationScoped(
      {
        type: 'conversation_update',
        conversationId,
        conversation: toConversationSummary(conv),
      },
      conv.project,
    )

    if (wasCompacting) {
      const marker = { type: 'compacting' as const, timestamp: new Date().toISOString() }
      addTranscriptEntries(conversationId, [marker], false)
      broadcastToChannel('conversation:transcript', conversationId, {
        type: 'transcript_entries',
        conversationId,
        entries: [marker],
        isInitial: false,
      })
    }

    return conv
  }

  function getConversation(id: string): Conversation | undefined {
    return conversations.get(id)
  }

  function getAllConversations(): Conversation[] {
    return Array.from(conversations.values())
  }

  function getActiveConversations(): Conversation[] {
    return Array.from(conversations.values()).filter(s => s.status !== 'ended')
  }

  // Late-bound reference so addEvent can pass it to scheduleRecap before the return object exists.
  // Assigned immediately after the return statement via Object.assign trick below.
  let self: ConversationStore

  function addEvent(conversationId: string, event: HookEvent): void {
    cancelRecap(conversationId)
    const prevStatus = conversations.get(conversationId)?.status
    addEventImpl(ctx, conversationId, event)
    const conv = conversations.get(conversationId)
    if (conv?.status === 'idle' && prevStatus !== 'idle') {
      scheduleRecap(self, conversationId)
    }
  }

  function updateActivity(conversationId: string): void {
    const conv = conversations.get(conversationId)
    if (conv) {
      conv.lastActivity = Date.now()
      if (conv.recapFresh && (!conv.recap || Date.now() - conv.recap.timestamp > 10_000)) {
        conv.recapFresh = false
      }
      if (conv.status === 'idle') {
        conv.status = 'active'
      }
    }
  }

  function endConversation(conversationId: string, _reason: string): void {
    const conv = conversations.get(conversationId)
    if (conv) {
      conv.status = 'ended'
      conv.planMode = false
      clearAnalyticsSession(conversationId)

      // Mark all running subagents as stopped (SubagentStop hook may not fire)
      for (const agent of conv.subagents) {
        if (agent.status === 'running') {
          agent.status = 'stopped'
          agent.stoppedAt = Date.now()
        }
      }

      // Mark all teammates as stopped
      for (const teammate of conv.teammates) {
        if (teammate.status !== 'stopped') {
          teammate.status = 'stopped'
          teammate.stoppedAt = Date.now()
        }
      }

      // Mark all running bg tasks as killed
      for (const bgTask of conv.bgTasks) {
        if (bgTask.status === 'running') {
          bgTask.status = 'killed'
          bgTask.completedAt = Date.now()
        }
      }

      // Broadcast to dashboard subscribers (scoped by grants)
      broadcastConversationScoped(
        {
          type: 'conversation_ended',
          conversationId,
          conversation: toConversationSummary(conv),
        },
        conv.project,
      )

      // Persist to store immediately
      persistConversation(conv)

      // Generate recap if none exists (async, re-persists on completion)
      generateRecapOnEnd(self, conversationId)
    }
  }

  function removeConversation(conversationId: string): void {
    const conv = conversations.get(conversationId)
    if (conv) {
      for (const bg of conv.bgTasks) {
        bgTaskOutputCache.delete(bg.taskId)
      }
    }
    conversations.delete(conversationId)
    conversationSockets.delete(conversationId)
    transcriptCache.delete(conversationId)
    transcriptSeqCounters.delete(conversationId)
    dirtyTranscripts.delete(conversationId)
    pendingAgentDescriptions.delete(conversationId)
    lastTranscriptKick.delete(conversationId)
    for (const key of subagentTranscriptCache.keys()) {
      if (key.startsWith(`${conversationId}:`)) {
        subagentTranscriptCache.delete(key)
        subagentTranscriptSeqCounters.delete(key)
      }
    }
    if (store) {
      try {
        store.conversations.delete(conversationId)
      } catch {}
      try {
        store.tasks.deleteForConversation(conversationId)
      } catch {}
    }
  }

  function getConversationEvents(conversationId: string, limit?: number, since?: number): HookEvent[] {
    const conv = conversations.get(conversationId)
    if (!conv) return []

    let events = conv.events

    // Filter by timestamp if since is provided
    if (since) {
      events = events.filter(e => e.timestamp > since)
    }

    // Apply limit (from the end)
    if (limit && events.length > limit) {
      return events.slice(-limit)
    }
    return events
  }

  function setConversationSocket(conversationId: string, connectionId: string, ws: ServerWebSocket<unknown>): void {
    // Remove connectionId from any OTHER conversation first (agent host reconnected to different conversation)
    for (const [convId, wrappers] of conversationSockets.entries()) {
      if (convId !== conversationId && wrappers.has(connectionId)) {
        wrappers.delete(connectionId)
        if (wrappers.size === 0) conversationSockets.delete(convId)
        // Broadcast so dashboard drops the stale connectionId from the old conversation
        broadcastConversationUpdate(convId)
      }
    }
    let wrappers = conversationSockets.get(conversationId)
    if (!wrappers) {
      wrappers = new Map()
      conversationSockets.set(conversationId, wrappers)
    }
    wrappers.set(connectionId, ws)
  }

  /** Drop sockets that are not OPEN. Returns the post-prune size. */
  function pruneDeadSockets(conversationId: string): number {
    const wrappers = conversationSockets.get(conversationId)
    if (!wrappers) return 0
    for (const [connId, ws] of wrappers.entries()) {
      if ((ws as { readyState?: number }).readyState !== WebSocket.OPEN) {
        wrappers.delete(connId)
      }
    }
    if (wrappers.size === 0) {
      conversationSockets.delete(conversationId)
      return 0
    }
    return wrappers.size
  }

  function getConversationSocket(conversationId: string): ServerWebSocket<unknown> | undefined {
    pruneDeadSockets(conversationId)
    const wrappers = conversationSockets.get(conversationId)
    if (!wrappers || wrappers.size === 0) return undefined
    // Return the most recently added agent host socket
    let last: ServerWebSocket<unknown> | undefined
    for (const ws of wrappers.values()) last = ws
    return last
  }

  function findSocketByConversationId(connectionId: string): ServerWebSocket<unknown> | undefined {
    for (const wrappers of conversationSockets.values()) {
      const ws = wrappers.get(connectionId)
      if (ws && (ws as { readyState?: number }).readyState === WebSocket.OPEN) return ws
    }
    return undefined
  }

  function findConversationByConversationId(connectionId: string): Conversation | undefined {
    for (const [convId, wrappers] of conversationSockets.entries()) {
      if (wrappers.has(connectionId)) return conversations.get(convId)
    }
    return undefined
  }

  function removeConversationSocket(conversationId: string, connectionId: string): void {
    const wrappers = conversationSockets.get(conversationId)
    if (wrappers) {
      wrappers.delete(connectionId)
      if (wrappers.size === 0) conversationSockets.delete(conversationId)
    }
  }

  /**
   * Remove every entry in the socket map whose value === ws (identity).
   * Authoritative cleanup that doesn't rely on ws.data fields. Returns the
   * conversation IDs that lost a socket so the caller can end empty ones.
   */
  function removeConversationSocketsByRef(ws: ServerWebSocket<unknown>): string[] {
    const touched: string[] = []
    for (const [convId, wrappers] of conversationSockets.entries()) {
      let removedHere = false
      for (const [connId, candidate] of wrappers.entries()) {
        if (candidate === ws) {
          wrappers.delete(connId)
          removedHere = true
        }
      }
      if (removedHere) {
        touched.push(convId)
        if (wrappers.size === 0) conversationSockets.delete(convId)
      }
    }
    return touched
  }

  function getActiveConversationCount(conversationId: string): number {
    return pruneDeadSockets(conversationId)
  }

  function getConnectionIds(conversationId: string): string[] {
    pruneDeadSockets(conversationId)
    const wrappers = conversationSockets.get(conversationId)
    return wrappers ? Array.from(wrappers.keys()) : []
  }

  function setGatewaySocket(gatewayId: string, gatewayType: string, alias: string, ws: ServerWebSocket<unknown>): void {
    gatewaySockets.set(gatewayId, { type: gatewayType, alias, ws })
  }

  function getGatewaySocketById(gatewayId: string): ServerWebSocket<unknown> | undefined {
    const entry = gatewaySockets.get(gatewayId)
    if (!entry) return undefined
    if ((entry.ws as { readyState?: number }).readyState !== WebSocket.OPEN) {
      gatewaySockets.delete(gatewayId)
      return undefined
    }
    return entry.ws
  }

  /**
   * Return all currently-connected gateway sockets of a given type.
   * Caller can pick one (e.g. when only one is connected) or fail when
   * a gatewayId is required but missing.
   */
  function getGatewaysByType(
    gatewayType: string,
  ): Array<{ gatewayId: string; alias: string; ws: ServerWebSocket<unknown> }> {
    const result: Array<{ gatewayId: string; alias: string; ws: ServerWebSocket<unknown> }> = []
    for (const [gatewayId, entry] of gatewaySockets) {
      if (entry.type !== gatewayType) continue
      if ((entry.ws as { readyState?: number }).readyState !== WebSocket.OPEN) {
        gatewaySockets.delete(gatewayId)
        continue
      }
      result.push({ gatewayId, alias: entry.alias, ws: entry.ws })
    }
    return result
  }

  /** Legacy: pick any open socket of the given type. Prefer getGatewaySocketById. */
  function getGatewaySocket(gatewayType: string): ServerWebSocket<unknown> | undefined {
    return getGatewaysByType(gatewayType)[0]?.ws
  }

  function removeGatewaySocketByRef(ws: ServerWebSocket<unknown>): string | undefined {
    for (const [gatewayId, entry] of gatewaySockets) {
      if (entry.ws === ws) {
        gatewaySockets.delete(gatewayId)
        return entry.type
      }
    }
    return undefined
  }

  /**
   * Reap conversations whose sockets have all closed without firing the WS
   * close handler (network blip, OS sleep, half-open TCP). Returns the list
   * of conversation IDs that were ended so the caller can broadcast / log.
   */
  function reapPhantomConversations(): string[] {
    const ended: string[] = []
    for (const [convId, conversation] of conversations.entries()) {
      if (conversation.status === 'ended') continue
      if (!resolveBackend(conversation).requiresAgentSocket) continue
      const live = pruneDeadSockets(convId)
      if (live === 0) {
        endConversation(convId, 'connection_closed')
        ended.push(convId)
      }
    }
    return ended
  }

  // Terminal viewer management (multiple viewers per conversation) -- delegated to terminal-registry
  const {
    addTerminalViewer,
    getTerminalViewers,
    removeTerminalViewer,
    removeTerminalViewerBySocket,
    hasTerminalViewers,
  } = terminalRegistry

  const addJsonStreamViewer = jsonStreamRegistry.add
  const getJsonStreamViewers = jsonStreamRegistry.get
  const removeJsonStreamViewer = jsonStreamRegistry.remove
  const removeJsonStreamViewerBySocket = jsonStreamRegistry.removeBySocket
  const hasJsonStreamViewers = jsonStreamRegistry.has

  // Dashboard subscriber management
  function addSubscriber(ws: ServerWebSocket<unknown>, protocolVersion = 1): void {
    controlPanelSubscribers.add(ws)

    // Track v2 subscribers and create registry entry (delegated to channel registry)
    channelRegistry.registerSubscriber(ws, protocolVersion, () => ++subscriberIdCounter)

    sendConversationsList(ws)

    // If this is a share viewer, notify admins about updated viewer counts
    if ((ws.data as { shareToken?: string }).shareToken) {
      broadcastSharesUpdate()
    }
  }

  /** Filter sessions by user's grants - only show sessions they have chat:read for */
  function filterConversationsByGrants(
    allConversations: ConversationSummary[],
    grants?: UserGrant[],
  ): ConversationSummary[] {
    if (!grants) return allConversations // no grants = admin/secret auth = see everything
    return allConversations.filter(s => {
      const { permissions } = resolvePermissions(grants, s.project)
      return permissions.has('chat:read')
    })
  }

  function buildConversationsListMessage(grants?: UserGrant[]): string {
    const allSummaries = Array.from(conversations.values()).map(toConversationSummary)
    return JSON.stringify({
      type: 'conversations_list',
      conversations: filterConversationsByGrants(allSummaries, grants),
      serverVersion: BUILD_VERSION.gitHashShort,
      _epoch: sync.epoch,
      _seq: sync.seq,
    })
  }

  function sendConversationsList(ws: ServerWebSocket<unknown>): void {
    try {
      const grants = (ws.data as { grants?: UserGrant[] }).grants
      ws.send(buildConversationsListMessage(grants))
    } catch {}
  }

  function removeSubscriber(ws: ServerWebSocket<unknown>): void {
    const wasShareViewer = !!(ws.data as { shareToken?: string }).shareToken
    controlPanelSubscribers.delete(ws)
    // Unregister from channel registry (removes v2, unsubscribes all channels, deletes registry entry)
    channelRegistry.unregisterSubscriber(ws)

    // If a share viewer disconnected, notify admins about updated viewer counts
    if (wasShareViewer) {
      broadcastSharesUpdate()
    }
  }

  function taskInfoToRecord(conversationId: string, task: TaskInfo, opts?: { archivedAt?: number }): TaskRecord {
    const now = Date.now()
    const ts = task.updatedAt || now
    const isDone = task.status === 'completed' || task.status === 'done'
    const completedAt = task.completedAt ?? (isDone ? now : undefined)
    return {
      id: task.id,
      conversationId,
      kind: task.kind || 'todo',
      status: task.status,
      name: task.subject,
      description: task.description,
      priority: task.priority,
      blockedBy: task.blockedBy,
      blocks: task.blocks,
      owner: task.owner,
      data: task.data,
      createdAt: ts,
      updatedAt: ts,
      completedAt,
      archivedAt: opts?.archivedAt,
    }
  }

  /**
   * Group archived tasks back into ArchivedTaskGroup buckets keyed by archived_at.
   * The original wire shape was a list of groups (each group = one batch of tasks
   * that disappeared together). The SQLite shape is flat with archived_at on each
   * row -- regroup by exact archived_at timestamp on hydrate.
   */
  function hydrateArchivedTaskGroups(conversationId: string): Conversation['archivedTasks'] {
    if (!store) return []
    const records = store.tasks.getForConversation(conversationId, { archived: true })
    const groups = new Map<number, TaskInfo[]>()
    for (const r of records) {
      const at = r.archivedAt ?? r.updatedAt ?? r.createdAt
      const list = groups.get(at) || []
      list.push(taskRecordToInfo(r))
      groups.set(at, list)
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([archivedAt, tasks]) => ({ archivedAt, tasks }))
  }

  function taskRecordToInfo(rec: TaskRecord): TaskInfo {
    return {
      id: rec.id,
      subject: rec.name || '',
      description: rec.description,
      status: rec.status as TaskInfo['status'],
      kind: (rec.kind as TaskInfo['kind']) || 'todo',
      priority: rec.priority,
      blockedBy: rec.blockedBy,
      blocks: rec.blocks,
      owner: rec.owner,
      updatedAt: rec.updatedAt || rec.createdAt,
      completedAt: rec.completedAt,
      data: rec.data,
    }
  }

  function updateTasks(conversationId: string, tasks: TaskInfo[]): void {
    const conv = conversations.get(conversationId)
    if (!conv) return

    const now = Date.now()
    // Diff: find tasks that disappeared (deleted by Claude after completion).
    // Persist the archived snapshot so history survives broker restart.
    const incomingIds = new Set(tasks.map(t => t.id))
    const disappeared = conv.tasks.filter(t => !incomingIds.has(t.id))
    if (disappeared.length > 0) {
      conv.archivedTasks.push({ archivedAt: now, tasks: disappeared })
      if (store) {
        for (const t of disappeared) {
          try {
            store.tasks.upsert(conversationId, taskInfoToRecord(conversationId, t, { archivedAt: now }))
          } catch (err) {
            console.error(`[store] tasks.upsert (archive) failed: ${err}`)
          }
        }
      }
    }

    conv.tasks = tasks
    if (store) {
      for (const t of tasks) {
        try {
          store.tasks.upsert(conversationId, taskInfoToRecord(conversationId, t))
        } catch (err) {
          console.error(`[store] tasks.upsert failed: ${err}`)
        }
      }
    }
    scheduleConversationUpdate(conversationId)
  }

  /**
   * Mark every active todo task as completed. Used by the dashboard's right-click
   * "Mark all tasks as done" action. Operates on broker-side state only -- the
   * agent host (if connected) is authoritative on next reconnect/refresh and may
   * reintroduce tasks. Returns the new task list.
   */
  function markAllTasksDone(conversationId: string): TaskInfo[] {
    const conv = conversations.get(conversationId)
    if (!conv) return []
    const now = Date.now()
    let changed = 0
    conv.tasks = conv.tasks.map(t => {
      if (t.kind && t.kind !== 'todo') return t
      if (t.status === 'completed' || t.status === 'done') return t
      changed++
      return { ...t, status: 'completed' as const, completedAt: now, updatedAt: now }
    })
    if (changed === 0) return conv.tasks
    if (store) {
      for (const t of conv.tasks) {
        try {
          store.tasks.upsert(conversationId, taskInfoToRecord(conversationId, t))
        } catch (err) {
          console.error(`[store] tasks.upsert (mark all done) failed: ${err}`)
        }
      }
    }
    scheduleConversationUpdate(conversationId)
    return conv.tasks
  }

  function getSubscriberCount(): number {
    return controlPanelSubscribers.size
  }

  function getSubscribers(): Set<ServerWebSocket<unknown>> {
    return controlPanelSubscribers
  }

  function getShareViewerCount(shareToken: string): number {
    let count = 0
    for (const ws of controlPanelSubscribers) {
      if ((ws.data as { shareToken?: string }).shareToken === shareToken) count++
    }
    return count
  }

  /** Broadcast shares_updated to admin subscribers (admin role or no grants = bearer auth) */
  function broadcastSharesUpdate(): void {
    const active = listShares()
    const shares = active.map(s => ({
      token: s.token,
      project: s.project,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      createdBy: s.createdBy,
      label: s.label,
      permissions: s.permissions,
      hideUserInput: s.hideUserInput || false,
      viewerCount: getShareViewerCount(s.token),
    }))
    const json = JSON.stringify({ type: 'shares_updated', shares })
    for (const ws of controlPanelSubscribers) {
      const data = ws.data as { grants?: UserGrant[]; isShare?: boolean }
      // Skip share viewers - they don't manage shares
      if (data.isShare) continue
      // Skip restricted users (have grants but no admin role)
      if (data.grants && data.grants.length > 0) {
        const isAdmin = data.grants.some(g => g.roles?.includes('admin'))
        if (!isAdmin) continue
      }
      try {
        ws.send(json)
        recordTraffic('out', json.length)
      } catch {}
    }
  }

  // Sentinel management: extracted to sentinel.ts (sentinels Map internally)
  const sentinelState = createSentinelState()

  function setSentinel(ws: ServerWebSocket<unknown>, info?: SentinelIdentifyInfo): boolean {
    let sentinelId = info?.sentinelId
    let alias = info?.alias
    if (!sentinelId && sentinelRegistry) {
      // No per-sentinel secret -- map to default sentinel (legacy/admin auth)
      const defaultId = sentinelRegistry.getDefaultId()
      if (!defaultId) {
        const record = sentinelRegistry.create({ alias: alias || 'default', isDefault: true })
        sentinelId = record.sentinelId
        alias = record.aliases[0]
      } else {
        sentinelId = defaultId
        const record = sentinelRegistry.get(defaultId)
        if (record) alias = record.aliases[0]
      }
    }
    return setSentinelImpl(sentinelState, ws, broadcast, { ...info, sentinelId, alias })
  }

  function getSentinel(): ServerWebSocket<unknown> | undefined {
    const defaultId = sentinelRegistry?.getDefaultId()
    if (defaultId) return sentinelState.sentinels.get(defaultId)?.ws
    const first = sentinelState.sentinels.values().next()
    return first.done ? undefined : first.value.ws
  }

  function getSentinelByAlias(alias: string): ServerWebSocket<unknown> | undefined {
    const id = sentinelState.sentinelsByAlias.get(alias)
    if (!id) return undefined
    return sentinelState.sentinels.get(id)?.ws
  }

  function getSentinelConnection(sentinelId: string) {
    return sentinelState.sentinels.get(sentinelId)
  }

  function getSentinelInfo(): { machineId?: string; hostname?: string } | undefined {
    const defaultId = sentinelRegistry?.getDefaultId()
    const conn = defaultId ? sentinelState.sentinels.get(defaultId) : sentinelState.sentinels.values().next().value
    return conn ? { machineId: conn.machineId, hostname: conn.hostname } : undefined
  }

  function getDefaultSentinelId(): string | undefined {
    if (sentinelRegistry) return sentinelRegistry.getDefaultId()
    const first = sentinelState.sentinels.values().next()
    return first.done ? undefined : first.value.sentinelId
  }

  function getDefaultSentinelAlias(): string | undefined {
    if (sentinelRegistry) {
      const def = sentinelRegistry.getDefault()
      return def?.aliases[0]
    }
    const first = sentinelState.sentinels.values().next()
    return first.done ? undefined : first.value.alias
  }

  function getConnectedSentinels() {
    const result: Array<{ sentinelId: string; alias: string; hostname?: string; connectedAt: number }> = []
    for (const conn of sentinelState.sentinels.values()) {
      result.push({
        sentinelId: conn.sentinelId,
        alias: conn.alias,
        hostname: conn.hostname,
        connectedAt: conn.connectedAt,
      })
    }
    return result
  }

  function removeSentinel(ws: ServerWebSocket<unknown>): void {
    removeSentinelImpl(sentinelState, ws, broadcast)
  }

  function recordSentinelHeartbeat(ws: ServerWebSocket<unknown>): void {
    recordSentinelHeartbeatImpl(sentinelState, ws)
  }

  function isSentinelAlive(sentinelId: string): boolean {
    return isSentinelAliveImpl(sentinelState, sentinelId)
  }

  function hasSentinel(): boolean {
    return sentinelState.sentinels.size > 0
  }

  function pushSentinelDiag(entry: { t: number; type: string; msg: string; args?: unknown }): void {
    pushSentinelDiagImpl(sentinelState, entry)
  }
  function getSentinelDiag(): Array<{ t: number; type: string; msg: string; args?: unknown }> {
    return [...sentinelState.diagLog]
  }
  function setUsage(usage: import('../shared/protocol').UsageUpdate): void {
    setUsageImpl(sentinelState, usage, broadcast)
  }
  function getUsage(): import('../shared/protocol').UsageUpdate | undefined {
    return sentinelState.usage
  }
  function setClaudeHealth(health: import('../shared/protocol').ClaudeHealthUpdate): void {
    setClaudeHealthImpl(sentinelState, health, broadcast)
  }
  function getClaudeHealth(): import('../shared/protocol').ClaudeHealthUpdate | undefined {
    return sentinelState.claudeHealth
  }
  function setClaudeEfficiency(efficiency: import('../shared/protocol').ClaudeEfficiencyUpdate): void {
    setClaudeEfficiencyImpl(sentinelState, efficiency, broadcast)
  }
  function getClaudeEfficiency(): import('../shared/protocol').ClaudeEfficiencyUpdate | undefined {
    return sentinelState.claudeEfficiency
  }

  /** Stamp `entry.seq` on every entry in-place using the per-conversation counter.
   *  Mutates the array in place -- callers rely on this so subsequent
   *  broadcasts (which share the same entry objects) carry the stamp.
   *  If `reset` is true, the counter is reset to 0 first (isInitial path). */
  // Transcript cache methods
  function addTranscriptEntries(conversationId: string, entries: TranscriptEntry[], isInitial: boolean): void {
    addTranscriptEntriesImpl(ctx, conversationId, entries, isInitial)
  }

  function getTranscriptEntries(conversationId: string, limit?: number): TranscriptEntry[] {
    const entries = transcriptCache.get(conversationId) || []
    if (limit && entries.length > limit) {
      return entries.slice(-limit)
    }
    return entries
  }

  function hasTranscriptCache(conversationId: string): boolean {
    return transcriptCache.has(conversationId)
  }

  function loadTranscriptFromStore(conversationId: string, limit: number): TranscriptEntry[] | null {
    if (!store) return null
    const records = store.transcripts.getLatest(conversationId, limit)
    if (records.length === 0) return null
    const entries = records.map(r => ({ ...r.content, seq: r.seq }) as TranscriptEntry)
    // Seed the in-memory seq counter so live entries continue from where
    // SQLite left off. Without this, broker restart resets the counter to 0,
    // live entries get seq 1..N, and clients that fetched from SQLite (seq 500+)
    // filter them all out as "already applied".
    const maxSeq = entries[entries.length - 1].seq ?? 0
    const currentSeq = transcriptSeqCounters.get(conversationId) ?? 0
    if (maxSeq > currentSeq) {
      transcriptSeqCounters.set(conversationId, maxSeq)
    }
    return entries
  }

  function addSubagentTranscriptEntries(
    conversationId: string,
    agentId: string,
    entries: TranscriptEntry[],
    isInitial: boolean,
  ): void {
    const key = `${conversationId}:${agentId}`
    if (isInitial) {
      // Stamp full batch on initial load -- counter resets to 0.
      assignTranscriptSeqs(subagentTranscriptSeqCounters, key, entries, true)
      subagentTranscriptCache.set(key, entries.slice(-MAX_TRANSCRIPT_ENTRIES))
    } else {
      const existing = subagentTranscriptCache.get(key) || []
      // Deduplicate: agent entries arrive from both the subagent JSONL watcher
      // AND extracted from parent transcript progress entries. Use uuid to filter.
      const seen = new Set(existing.map(e => e.uuid).filter(Boolean))
      const fresh = entries.filter(e => !e.uuid || !seen.has(e.uuid))
      if (fresh.length === 0) return
      // Only stamp the deduped tail. Skipped duplicates already had their seq
      // from the prior ingest; re-stamping would renumber them and break
      // client's lastAppliedSeq comparison.
      assignTranscriptSeqs(subagentTranscriptSeqCounters, key, fresh, false)
      existing.push(...fresh)
      if (existing.length > MAX_TRANSCRIPT_ENTRIES) {
        subagentTranscriptCache.set(key, existing.slice(-MAX_TRANSCRIPT_ENTRIES))
      } else {
        subagentTranscriptCache.set(key, existing)
      }
    }

    // Extract token usage from subagent transcript entries
    const conv = conversations.get(conversationId)
    if (!conv) return
    const subagent = conv.subagents.find(a => a.agentId === agentId)
    if (!subagent) return

    let changed = false
    for (const entry of entries) {
      if (entry.type !== 'assistant') continue
      const usage = (entry as TranscriptAssistantEntry).message?.usage
      if (!usage || typeof usage.input_tokens !== 'number') continue

      if (!subagent.tokenUsage) {
        subagent.tokenUsage = { totalInput: 0, totalOutput: 0, cacheCreation: 0, cacheRead: 0 }
      }
      if (isInitial && !changed) {
        // On initial load, reset to avoid double-counting
        subagent.tokenUsage = { totalInput: 0, totalOutput: 0, cacheCreation: 0, cacheRead: 0 }
      }
      subagent.tokenUsage.totalInput +=
        (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
      subagent.tokenUsage.totalOutput += usage.output_tokens || 0
      subagent.tokenUsage.cacheCreation += usage.cache_creation_input_tokens || 0
      subagent.tokenUsage.cacheRead += usage.cache_read_input_tokens || 0
      changed = true
    }

    if (changed) broadcastConversationUpdate(conversationId)
  }

  function getSubagentTranscriptEntries(conversationId: string, agentId: string, limit?: number): TranscriptEntry[] {
    const entries = subagentTranscriptCache.get(`${conversationId}:${agentId}`) || []
    if (limit && entries.length > limit) {
      return entries.slice(-limit)
    }
    return entries
  }

  function hasSubagentTranscriptCache(conversationId: string, agentId: string): boolean {
    return subagentTranscriptCache.has(`${conversationId}:${agentId}`)
  }

  function addBgTaskOutput(conversationId: string, taskId: string, data: string, done: boolean) {
    if (data) {
      const existing = bgTaskOutputCache.get(taskId) || ''
      // Cap at 100KB to prevent memory issues
      const combined = existing + data
      bgTaskOutputCache.set(taskId, combined.length > 100_000 ? combined.slice(-100_000) : combined)
    }
    // Store output reference on the bgTask if it exists
    const conv = conversations.get(conversationId)
    if (conv && done) {
      const bgTask = conv.bgTasks.find(t => t.taskId === taskId)
      if (bgTask && bgTask.status === 'running') {
        bgTask.status = 'completed'
        bgTask.completedAt = Date.now()
      }
    }
  }

  function getBgTaskOutput(taskId: string): string | undefined {
    return bgTaskOutputCache.get(taskId)
  }

  // Request-response listeners: extracted to listeners.ts
  const listeners = createListenerRegistry()
  const {
    addSpawnListener,
    removeSpawnListener,
    resolveSpawn,
    addDirListener,
    removeDirListener,
    resolveDir,
    addCcSessionsListener,
    removeCcSessionsListener,
    resolveCcSessions,
  } = listeners

  // ─── Pending Launch Configs (conversationId -> LaunchConfig) ─────────────
  // Stored at spawn time, consumed when the conversation connects (meta handler).
  const pendingLaunchConfigs = new Map<string, LaunchConfig>()

  function setPendingLaunchConfig(conversationId: string, config: LaunchConfig) {
    pendingLaunchConfigs.set(conversationId, config)
    // Auto-cleanup after 5 min in case conversation never connects
    setTimeout(() => pendingLaunchConfigs.delete(conversationId), 5 * 60 * 1000)
  }

  function consumePendingLaunchConfig(conversationId: string): LaunchConfig | undefined {
    const config = pendingLaunchConfigs.get(conversationId)
    if (config) pendingLaunchConfigs.delete(conversationId)
    return config
  }

  // Launch jobs: extracted to spawn-jobs.ts
  const spawnJobs = createSpawnJobRegistry()
  const {
    createJob,
    recordJobConfig,
    subscribeJob,
    unsubscribeJob,
    forwardJobEvent,
    completeJob,
    failJob,
    getJobByConversation,
    getJobDiagnostics,
    listActiveJobs,
    cleanupJobSubscriber,
  } = spawnJobs

  // Rendezvous + pending restarts: extracted to spawn-jobs.ts
  const rendezvous = createRendezvousRegistry()
  const { addPendingRestart, consumePendingRestart, getRendezvousInfo } = rendezvous

  function addRendezvous(
    conversationId: string,
    callerConversationId: string,
    project: string,
    action: 'spawn' | 'revive' | 'restart',
  ): Promise<Conversation> {
    return rendezvous.addRendezvous(conversationId, callerConversationId, project, action)
  }

  function resolveRendezvous(conversationId: string, connectionId: string): boolean {
    return rendezvous.resolveRendezvous(conversationId, connectionId, id => {
      return conversations.get(id)
    })
  }

  // ─── Pending conversation names (set at spawn time, applied on connect) ──
  const pendingConversationNames = new Map<string, string>()

  function setPendingConversationName(conversationId: string, name: string): void {
    pendingConversationNames.set(conversationId, name)
    setTimeout(() => pendingConversationNames.delete(conversationId), 120_000)
  }

  function consumePendingConversationName(conversationId: string): string | undefined {
    const name = pendingConversationNames.get(conversationId)
    if (name) pendingConversationNames.delete(conversationId)
    return name
  }

  // File listeners: from extracted listeners module
  const { addFileListener, removeFileListener, resolveFile } = listeners

  function broadcastConversationUpdate(conversationId: string): void {
    scheduleConversationUpdate(conversationId)
  }

  // Inter-project link registry: extracted to project-links.ts
  const projectLinkReg = createProjectLinkRegistry(conversations, conversationSockets)
  const {
    checkProjectLink,
    linkProjects,
    unlinkProjects,
    blockProject,
    queueProjectMessage,
    drainProjectMessages,
    broadcastToConversationsForProject,
  } = projectLinkReg

  function getLinkedProjects(conversationId: string): Array<{ project: string; name: string }> {
    return projectLinkReg.getLinkedProjects(conversationId)
  }

  function broadcastForProject(projectOrCwd: string): void {
    const project = projectLinkReg.toProjectUri(projectOrCwd)
    for (const [id, s] of conversations) {
      if (s.project === project) scheduleConversationUpdate(id)
    }
  }

  const result: ConversationStore = {
    createConversation,
    resumeConversation,
    clearConversation,
    getConversation,
    getAllConversations,
    getActiveConversations,
    addEvent,
    updateActivity,
    updateTasks,
    markAllTasksDone,
    endConversation,
    removeConversation,
    getConversationEvents,
    setConversationSocket,
    getConversationSocket,
    findSocketByConversationId,
    findConversationByConversationId,
    removeConversationSocket,
    removeConversationSocketsByRef,
    getActiveConversationCount,
    getConnectionIds,
    reapPhantomConversations,
    addTerminalViewer,
    getTerminalViewers,
    removeTerminalViewer,
    removeTerminalViewerBySocket,
    hasTerminalViewers,
    addJsonStreamViewer,
    getJsonStreamViewers,
    removeJsonStreamViewer,
    removeJsonStreamViewerBySocket,
    hasJsonStreamViewers,
    addSubscriber,
    sendConversationsList,
    handleSyncCheck,
    getSyncState: () => ({ epoch: sync.epoch, seq: sync.seq }),
    removeSubscriber,
    getSubscriberCount,
    getSubscribers,
    getShareViewerCount,
    broadcastConversationScoped: (message: Record<string, unknown>, project: string) =>
      broadcastConversationScoped(message as unknown as ControlPanelMessage, project),
    broadcastSharesUpdate,
    subscribeChannel,
    unsubscribeChannel,
    unsubscribeAllChannels,
    getChannelSubscribers,
    broadcastToChannel,
    isV2Subscriber,
    getSubscriptionsDiag,
    setSentinel,
    getSentinel,
    getSentinelByAlias,
    getSentinelConnection,
    getSentinelInfo,
    getDefaultSentinelId,
    getDefaultSentinelAlias,
    getConnectedSentinels,
    removeSentinel,
    recordSentinelHeartbeat,
    isSentinelAlive,
    hasSentinel,
    pushSentinelDiag,
    getSentinelDiag,
    setUsage,
    getUsage,
    setClaudeHealth,
    getClaudeHealth,
    setClaudeEfficiency,
    getClaudeEfficiency,
    addTranscriptEntries,
    getTranscriptEntries,
    hasTranscriptCache,
    loadTranscriptFromStore,
    addSubagentTranscriptEntries,
    getSubagentTranscriptEntries,
    hasSubagentTranscriptCache,
    addBgTaskOutput,
    getBgTaskOutput,
    broadcastConversationUpdate,
    createJob,
    recordJobConfig,
    subscribeJob,
    unsubscribeJob,
    forwardJobEvent,
    completeJob,
    failJob,
    getJobByConversation,
    getJobDiagnostics,
    listActiveSpawnJobs: listActiveJobs,
    cleanupJobSubscriber,
    addSpawnListener,
    removeSpawnListener,
    resolveSpawn,
    addDirListener,
    removeDirListener,
    resolveDir,
    addCcSessionsListener,
    removeCcSessionsListener,
    resolveCcSessions,
    broadcastToConversationsForProject,
    broadcastToConversationsAtCwd: broadcastToConversationsForProject,
    addFileListener,
    removeFileListener,
    resolveFile,
    checkProjectLink,
    getLinkedProjects,
    linkProjects,
    unlinkProjects,
    blockProject,
    queueProjectMessage,
    drainProjectMessages,
    broadcastForProject,
    addPendingRestart,
    consumePendingRestart,
    addRendezvous,
    resolveRendezvous,
    getRendezvousInfo,
    setPendingLaunchConfig,
    consumePendingLaunchConfig,
    setPendingConversationName,
    consumePendingConversationName,
    recordTraffic,
    getTrafficStats,
    saveState,
    clearState,
    flushTranscripts,
    persistConversationById,
    scheduleRecap: (conversationId: string) => scheduleRecap(self, conversationId),
    cancelRecap,
    setGatewaySocket,
    getGatewaySocketById,
    getGatewaysByType,
    getGatewaySocket,
    removeGatewaySocketByRef,
  }

  self = result
  return result
}
