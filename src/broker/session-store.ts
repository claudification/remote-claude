/**
 * Session Store
 * In-memory session registry with event storage, backed by StoreDriver for persistence
 */

import type { ServerWebSocket } from 'bun'
import { resolveContextWindow } from '../shared/context-window'
import {
  buildProjectUri,
  cwdToProjectUri,
  DEFAULT_SENTINEL_NAME,
  extractProjectLabel,
  parseProjectUri,
} from '../shared/project-uri'
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
  TranscriptProgressEntry,
  TranscriptUserEntry,
} from '../shared/protocol'
import { BUILD_VERSION } from '../shared/version'
import { clearSession as clearAnalyticsSession, recordHookEvent } from './analytics-store'
import { getModelInfo } from './model-pricing'
import type { UserGrant } from './permissions'
import { resolvePermissionFlags, resolvePermissions } from './permissions'
import { getProjectSettings } from './project-settings'
import { appendSharedFile } from './routes'
import type { SentinelRegistry } from './sentinel-registry'
import { createChannelRegistry } from './session-store/channel-registry'
import { createListenerRegistry } from './session-store/listeners'
import { detectClipboardMime, detectContextModeFromStdout, isReadableText } from './session-store/parsers'
import { createProjectLinkRegistry } from './session-store/project-links'
import {
  createSentinelState,
  pushSentinelDiag as pushSentinelDiagImpl,
  removeSentinel as removeSentinelImpl,
  type SentinelIdentifyInfo,
  setSentinel as setSentinelImpl,
  setUsage as setUsageImpl,
} from './session-store/sentinel'
import { createRendezvousRegistry, createSpawnJobRegistry } from './session-store/spawn-jobs'
import {
  createSyncState,
  handleSyncCheck as handleSyncCheckImpl,
  type SyncState,
  stampAndBuffer as stampAndBufferImpl,
  syncStamp as syncStampImpl,
} from './session-store/sync-protocol'
import { createTerminalRegistry } from './session-store/terminal-registry'
import { createTrafficTracker } from './session-store/traffic'
import type { ControlPanelMessage } from './session-store/types'
import { createViewerRegistry } from './session-store/viewer-registry'
import { listShares } from './shares'
import type { StoreDriver } from './store/types'

export type { ControlPanelMessage, ConversationSummary }

export interface SessionStoreOptions {
  cacheDir?: string
  enablePersistence?: boolean
  store?: StoreDriver
  sentinelRegistry?: SentinelRegistry
}

export interface ConversationStore {
  createSession: (
    id: string,
    project: string,
    model?: string,
    args?: string[],
    capabilities?: AgentHostCapability[],
  ) => Conversation
  resumeSession: (id: string) => void
  rekeySession: (
    oldId: string,
    newId: string,
    conversationId: string,
    newProject: string,
    model?: string,
  ) => Conversation | undefined
  getSession: (id: string) => Conversation | undefined
  getAllSessions: () => Conversation[]
  getActiveSessions: () => Conversation[]
  addEvent: (sessionId: string, event: HookEvent) => void
  updateActivity: (sessionId: string) => void
  endSession: (sessionId: string, reason: string) => void
  removeSession: (sessionId: string) => void
  getSessionEvents: (sessionId: string, limit?: number, since?: number) => HookEvent[]
  updateTasks: (sessionId: string, tasks: TaskInfo[]) => void
  setSessionSocket: (sessionId: string, conversationId: string, ws: ServerWebSocket<unknown>) => void
  getSessionSocket: (sessionId: string) => ServerWebSocket<unknown> | undefined
  getSessionSocketByConversation: (conversationId: string) => ServerWebSocket<unknown> | undefined
  getSessionByConversation: (conversationId: string) => Conversation | undefined
  removeSessionSocket: (sessionId: string, conversationId: string) => void
  getActiveConversationCount: (sessionId: string) => number
  getConversationIds: (sessionId: string) => string[]
  // Transcript cache methods
  addTranscriptEntries: (sessionId: string, entries: TranscriptEntry[], isInitial: boolean) => void
  getTranscriptEntries: (sessionId: string, limit?: number) => TranscriptEntry[]
  hasTranscriptCache: (sessionId: string) => boolean
  addSubagentTranscriptEntries: (
    sessionId: string,
    agentId: string,
    entries: TranscriptEntry[],
    isInitial: boolean,
  ) => void
  getSubagentTranscriptEntries: (sessionId: string, agentId: string, limit?: number) => TranscriptEntry[]
  hasSubagentTranscriptCache: (sessionId: string, agentId: string) => boolean
  // Background task output methods
  addBgTaskOutput: (sessionId: string, taskId: string, data: string, done: boolean) => void
  getBgTaskOutput: (taskId: string) => string | undefined
  broadcastSessionUpdate: (sessionId: string) => void
  // Terminal viewer methods (multiple viewers per session)
  // Terminal viewers keyed by conversationId (each PTY is on a specific rclaude instance)
  addTerminalViewer: (conversationId: string, ws: ServerWebSocket<unknown>) => void
  getTerminalViewers: (conversationId: string) => Set<ServerWebSocket<unknown>>
  removeTerminalViewer: (conversationId: string, ws: ServerWebSocket<unknown>) => void
  removeTerminalViewerBySocket: (ws: ServerWebSocket<unknown>) => void
  hasTerminalViewers: (conversationId: string) => boolean
  // JSON stream viewer methods (raw NDJSON tail for headless sessions)
  addJsonStreamViewer: (conversationId: string, ws: ServerWebSocket<unknown>) => void
  getJsonStreamViewers: (conversationId: string) => Set<ServerWebSocket<unknown>>
  removeJsonStreamViewer: (conversationId: string, ws: ServerWebSocket<unknown>) => void
  removeJsonStreamViewerBySocket: (ws: ServerWebSocket<unknown>) => void
  hasJsonStreamViewers: (conversationId: string) => boolean
  // Dashboard subscriber methods
  addSubscriber: (ws: ServerWebSocket<unknown>, protocolVersion?: number) => void
  sendSessionsList: (ws: ServerWebSocket<unknown>) => void
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
    sessionId: string,
    agentId?: string,
  ) => void
  unsubscribeChannel: (
    ws: ServerWebSocket<unknown>,
    channel: SubscriptionChannel,
    sessionId: string,
    agentId?: string,
  ) => void
  unsubscribeAllChannels: (ws: ServerWebSocket<unknown>) => void
  getChannelSubscribers: (
    channel: SubscriptionChannel,
    sessionId: string,
    agentId?: string,
  ) => Set<ServerWebSocket<unknown>>
  broadcastToChannel: (channel: SubscriptionChannel, sessionId: string, message: unknown, agentId?: string) => void
  isV2Subscriber: (ws: ServerWebSocket<unknown>) => boolean
  getSubscriptionsDiag: () => SubscriptionsDiag
  // Sentinel methods (sentinels Map internally)
  setSentinel: (ws: ServerWebSocket<unknown>, info?: SentinelIdentifyInfo) => boolean
  getSentinel: () => ServerWebSocket<unknown> | undefined
  getSentinelByAlias: (alias: string) => ServerWebSocket<unknown> | undefined
  getSentinelConnection: (sentinelId: string) => import('./session-store/sentinel').SentinelConnection | undefined
  getSentinelInfo: () => { machineId?: string; hostname?: string } | undefined
  getDefaultSentinelId: () => string | undefined
  getDefaultSentinelAlias: () => string | undefined
  getConnectedSentinels: () => Array<{ sentinelId: string; alias: string; hostname?: string; connectedAt: number }>
  removeSentinel: (ws: ServerWebSocket<unknown>) => void
  hasSentinel: () => boolean
  // Sentinel diagnostics (structured log entries from sentinel)
  pushSentinelDiag: (entry: { t: number; type: string; msg: string; args?: unknown }) => void
  getSentinelDiag: () => Array<{ t: number; type: string; msg: string; args?: unknown }>
  // Plan usage data (from sentinel OAuth usage API polling)
  setUsage: (usage: import('../shared/protocol').UsageUpdate) => void
  getUsage: () => import('../shared/protocol').UsageUpdate | undefined
  // Request-response listeners for sentinel relay (spawn, dir listing)
  addSpawnListener: (requestId: string, cb: (result: unknown) => void) => void
  removeSpawnListener: (requestId: string) => void
  resolveSpawn: (requestId: string, result: unknown) => void
  addDirListener: (requestId: string, cb: (result: unknown) => void) => void
  removeDirListener: (requestId: string) => void
  resolveDir: (requestId: string, result: unknown) => void
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
  completeJob: (conversationId: string, sessionId: string) => void
  failJob: (jobId: string, error: string) => void
  getJobByConversation: (conversationId: string) => string | undefined
  getJobDiagnostics: (jobId: string) => {
    jobId: string
    conversationId: string
    sessionId: string | null
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
  cleanupJobSubscriber: (ws: ServerWebSocket<unknown>) => void
  // Session rendezvous (spawn/revive callback)
  addRendezvous: (
    conversationId: string,
    callerSessionId: string,
    project: string,
    action: 'spawn' | 'revive' | 'restart',
  ) => Promise<ConversationSummary>
  // Pending restart (terminate + auto-revive on disconnect)
  addPendingRestart: (
    conversationId: string,
    info: { callerSessionId: string; targetSessionId: string; project: string; isSelfRestart: boolean },
  ) => void
  consumePendingRestart: (
    conversationId: string,
  ) => { callerSessionId: string; targetSessionId: string; project: string; isSelfRestart: boolean } | undefined
  resolveRendezvous: (conversationId: string, sessionId: string) => boolean
  getRendezvousInfo: (conversationId: string) => { callerSessionId: string; action: string } | undefined
  // Pending launch configs (set at spawn, consumed on connect to restore on revive)
  setPendingLaunchConfig: (conversationId: string, config: LaunchConfig) => void
  consumePendingLaunchConfig: (conversationId: string) => LaunchConfig | undefined
  // Pending session names (set at spawn, consumed on connect)
  setPendingSessionName: (conversationId: string, name: string) => void
  consumePendingSessionName: (conversationId: string) => string | undefined
  // Inter-project link management
  checkProjectLink: (from: string, to: string) => 'linked' | 'blocked' | 'unknown'
  getLinkedProjects: (sessionId: string) => Array<{ project: string; name: string }>
  linkProjects: (a: string, b: string) => void
  unlinkProjects: (a: string, b: string) => void
  blockProject: (blocker: string, blocked: string) => void
  queueProjectMessage: (from: string, to: string, message: Record<string, unknown>) => void
  drainProjectMessages: (from: string, to: string) => Array<Record<string, unknown>>
  broadcastForProject: (project: string) => void
  broadcastSessionScoped: (message: Record<string, unknown>, project: string) => void
  broadcastSharesUpdate: () => void
  recordTraffic: (direction: 'in' | 'out', bytes: number) => void
  getTrafficStats: () => {
    in: { messagesPerSec: number; bytesPerSec: number }
    out: { messagesPerSec: number; bytesPerSec: number }
  }
  saveState: () => Promise<void>
  clearState: () => Promise<void>
  flushTranscripts: () => Promise<void>
}

/**
 * Create a session store with optional persistence
 */
export function createConversationStore(options: SessionStoreOptions = {}): ConversationStore {
  const { store, sentinelRegistry } = options

  const sessions = new Map<string, Conversation>()
  // sessionId -> (conversationId -> socket): multiple rclaude instances can share a Claude session
  const sessionSockets = new Map<string, Map<string, ServerWebSocket<unknown>>>()
  // Terminal viewers keyed by conversationId (each PTY is on a specific conversation)
  const terminalRegistry = createTerminalRegistry()
  // JSON stream viewers keyed by conversationId (raw NDJSON tail for headless sessions)
  const jsonStreamRegistry = createViewerRegistry()
  const dashboardSubscribers = new Set<ServerWebSocket<unknown>>()
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
  // which are defined in this factory. dashboardSubscribers is a shared mutable ref.
  const channelRegistry = createChannelRegistry({
    dashboardSubscribers,
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
    migrateChannels,
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

  // Passive hooks: don't transition session status to 'active'
  // SessionStart/InstructionsLoaded = initialization, not work
  // ConfigChange/Setup/Elicitation = configuration, not work
  const PASSIVE_HOOKS = new Set([
    'Stop',
    'StopFailure',
    'SessionStart',
    'SessionEnd',
    'Notification',
    'TeammateIdle',
    'TaskCompleted',
    'InstructionsLoaded',
    'ConfigChange',
    'Setup',
    'Elicitation',
    'ElicitationResult',
    'CwdChanged',
    'FileChanged',
    'TaskCreated',
    'PermissionDenied',
  ])
  const MAX_EVENTS = 1000

  // Transcript cache: sessionId -> entries (ring buffer, max 1000 per session)
  const MAX_TRANSCRIPT_ENTRIES = 1000
  const transcriptCache = new Map<string, TranscriptEntry[]>()
  // Dirty tracking for transcript persistence: sessions modified since last flush
  const dirtyTranscripts = new Set<string>()
  // Deduplicate clipboard captures by tool_use_id (prevents re-processing on transcript re-reads)
  const processedClipboardIds = new Set<string>()

  /** Per-session monotonic transcript sequence counter. Stamps `entry.seq` on
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

  // Subagent transcript cache: `${sessionId}:${agentId}` -> entries
  const subagentTranscriptCache = new Map<string, TranscriptEntry[]>()
  /** Per-subagent transcript seq counter. Same semantics as
   *  `transcriptSeqCounters` above, but keyed by `${sessionId}:${agentId}`. */
  const subagentTranscriptSeqCounters = new Map<string, number>()
  // Transcript kick tracking: sessionId -> last kick timestamp (debounce 60s)
  const lastTranscriptKick = new Map<string, number>()
  const TRANSCRIPT_KICK_DEBOUNCE_MS = 60_000
  const TRANSCRIPT_KICK_EVENT_THRESHOLD = 5
  // Background task output cache: taskId -> accumulated output string
  const bgTaskOutputCache = new Map<string, string>()

  // Helper to create session summary for broadcasting
  function toSessionSummary(session: Conversation): ConversationSummary {
    const wrappers = sessionSockets.get(session.id)
    return {
      id: session.id,
      project: session.project,
      model: session.configuredModel || session.model,
      capabilities: session.capabilities,
      version: session.version,
      buildTime: session.buildTime,
      claudeVersion: session.claudeVersion,
      claudeAuth: session.claudeAuth,
      spinnerVerbs: session.spinnerVerbs,
      autocompactPct: session.autocompactPct,
      maxBudgetUsd: session.maxBudgetUsd,
      conversationIds: wrappers ? Array.from(wrappers.keys()) : [],
      startedAt: session.startedAt,
      lastActivity: session.lastActivity,
      status: session.status,
      compacting: session.compacting || undefined,
      compactedAt: session.compactedAt,
      eventCount: session.events.length,
      activeSubagentCount: session.subagents.filter(a => a.status === 'running').length,
      totalSubagentCount: session.subagents.length,
      subagents: session.subagents.map(a => ({
        agentId: a.agentId,
        agentType: a.agentType,
        description: a.description,
        status: a.status,
        startedAt: a.startedAt,
        stoppedAt: a.stoppedAt,
        eventCount: a.events.length,
        ...(a.tokenUsage && { tokenUsage: a.tokenUsage }),
      })),
      taskCount: session.tasks.length,
      pendingTaskCount: session.tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length,
      activeTasks: session.tasks.filter(t => t.status === 'in_progress').map(t => ({ id: t.id, subject: t.subject })),
      pendingTasks: session.tasks
        .filter(t => t.status === 'pending')
        .slice(0, 4)
        .map(t => ({ id: t.id, subject: t.subject })),
      archivedTaskCount: session.archivedTasks.reduce((sum, g) => sum + g.tasks.length, 0),
      archivedTasks: session.archivedTasks
        .flatMap(g => g.tasks)
        .slice(-50)
        .map(t => ({ id: t.id, subject: t.subject })),
      runningBgTaskCount: session.bgTasks.filter(t => t.status === 'running').length,
      bgTasks: session.bgTasks.map(t => ({
        taskId: t.taskId,
        command: t.command,
        description: t.description,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        status: t.status,
      })),
      monitors: session.monitors,
      runningMonitorCount: session.monitors.filter(m => m.status === 'running').length,
      teammates: session.teammates.map(t => ({
        name: t.name,
        status: t.status,
        currentTaskSubject: t.currentTaskSubject,
        completedTaskCount: t.completedTaskCount,
      })),
      team: session.team,
      effortLevel: session.effortLevel,
      permissionMode: session.permissionMode || undefined,
      lastError: session.lastError,
      rateLimit: session.rateLimit,
      planMode: session.planMode || undefined,
      pendingAttention: session.pendingAttention,
      hasNotification: session.hasNotification,
      summary: session.summary,
      title: session.title,
      description: session.description,
      agentName: session.agentName,
      prLinks: session.prLinks,
      linkedProjects: getLinkedProjects(session.id),
      tokenUsage: session.tokenUsage,
      contextWindow: resolveContextWindow(session.configuredModel || session.model, session.contextMode),
      cacheTtl: session.cacheTtl,
      lastTurnEndedAt: session.lastTurnEndedAt,
      stats: session.stats,
      costTimeline: session.costTimeline,
      gitBranch: session.gitBranch,
      adHocTaskId: session.adHocTaskId,
      adHocWorktree: session.adHocWorktree,
      modelMismatch: session.modelMismatch,
      resultText: session.resultText,
      recap: session.recap,
      recapFresh: session.recapFresh,
      hostSentinelId: session.hostSentinelId,
      hostSentinelAlias: session.hostSentinelAlias,
    }
  }

  // Broadcast to all dashboard subscribers (sequenced + buffered for sync catchup)
  function broadcast(message: ControlPanelMessage): void {
    const json = stampAndBuffer(message)
    for (const ws of dashboardSubscribers) {
      try {
        ws.send(json)
        recordTraffic('out', json.length)
      } catch (err) {
        const subInfo = channelRegistry.getSubscriberEntry(ws)
        console.error(
          `[broadcast] Send failed to ${subInfo?.id || 'unknown'}: ${err instanceof Error ? err.message : err}`,
        )
        dashboardSubscribers.delete(ws)
      }
    }
  }

  /** Broadcast a session message only to subscribers who have chat:read for that project */
  function broadcastSessionScoped(message: ControlPanelMessage, project: string): void {
    const json = stampAndBuffer(message)
    for (const ws of dashboardSubscribers) {
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
        dashboardSubscribers.delete(ws)
      }
    }
  }

  // Coalesced session_update broadcasts: only the last update per session per tick is sent
  const pendingSessionUpdates = new Set<string>()
  let sessionUpdateScheduled = false

  function scheduleSessionUpdate(sessionId: string): void {
    pendingSessionUpdates.add(sessionId)
    if (!sessionUpdateScheduled) {
      sessionUpdateScheduled = true
      queueMicrotask(flushSessionUpdates)
    }
  }

  function flushSessionUpdates(): void {
    sessionUpdateScheduled = false
    for (const id of pendingSessionUpdates) {
      const session = sessions.get(id)
      if (session) {
        broadcastSessionScoped(
          {
            type: 'conversation_update',
            sessionId: id,
            session: toSessionSummary(session),
          },
          session.project,
        )
      }
    }
    pendingSessionUpdates.clear()
  }

  // Load persisted state from StoreDriver on startup
  if (store) {
    loadFromStore()
  }

  // Periodically mark idle sessions, clean stale agents, evict old sessions, and save state
  const ENDED_EVICTION_TTL_MS = 28 * 24 * 60 * 60 * 1000 // 28 days after ending (user can manually dismiss)
  const ZOMBIE_EVICTION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days for stale STARTING sessions
  const MAX_ENDED_SESSIONS = 200 // hard cap on ended sessions in memory

  setInterval(() => {
    const now = Date.now()
    const STALE_AGENT_MS = 10 * 60 * 1000 // 10 minutes
    const LIVENESS_MS = 5 * 60_000 // 5m without hooks = not "actively receiving"
    const toEvict: string[] = []

    for (const session of sessions.values()) {
      let changed = false

      // Liveness check: no hooks for 30s means session isn't actively receiving
      if (session.status === 'active' && now - session.lastActivity > LIVENESS_MS) {
        session.status = 'idle'
        changed = true
      }

      // Clean up stale "running" agents (SubagentStop may have been missed)
      for (const agent of session.subagents) {
        if (
          agent.status === 'running' &&
          now - agent.startedAt > STALE_AGENT_MS &&
          now - session.lastActivity > STALE_AGENT_MS
        ) {
          agent.status = 'stopped'
          agent.stoppedAt = now
          changed = true
        }
      }

      // Mark ended sessions for eviction after TTL
      if (session.status === 'ended' && now - session.lastActivity > ENDED_EVICTION_TTL_MS) {
        toEvict.push(session.id)
      }

      // Evict zombie sessions: STARTING with 0 events, idle > 24h, no active wrapper
      if (session.status === 'starting' && session.events.length === 0) {
        const idleMs = now - session.lastActivity
        if (idleMs > ZOMBIE_EVICTION_TTL_MS && !sessionSockets.has(session.id)) {
          const hours = Math.round(idleMs / 3600000)
          console.log(`[evict] Zombie session ${session.id.slice(0, 8)} (STARTING, 0 events, idle ${hours}h)`)
          toEvict.push(session.id)
        }
      }

      if (changed) {
        scheduleSessionUpdate(session.id)
      }
    }

    // Evict TTL-expired ended sessions
    for (const id of toEvict) {
      removeSession(id)
    }

    // Hard cap: if too many ended sessions, evict oldest first
    const ended = Array.from(sessions.values())
      .filter(s => s.status === 'ended')
      .sort((a, b) => a.lastActivity - b.lastActivity)
    if (ended.length > MAX_ENDED_SESSIONS) {
      for (let i = 0; i < ended.length - MAX_ENDED_SESSIONS; i++) {
        removeSession(ended[i].id)
      }
    }

    if (toEvict.length > 0 || ended.length > MAX_ENDED_SESSIONS) {
      const evictedCount = toEvict.length + Math.max(0, ended.length - MAX_ENDED_SESSIONS)
      console.log(`[eviction] Removed ${evictedCount} ended sessions (${sessions.size} remaining)`)
    }
  }, 10000)

  // StoreDriver writes are immediate -- no debounced save needed

  function loadFromStore(): void {
    if (!store) return
    try {
      const records = store.sessions.list()
      for (const rec of records) {
        const meta = (rec as unknown as { meta?: Record<string, unknown> }).meta || {}
        // Full record for meta fields
        const full = store.sessions.get(rec.id)
        const fullMeta = full?.meta || meta
        const session: Conversation = {
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
          tasks: (fullMeta.tasks as Conversation['tasks']) || [],
          archivedTasks: (fullMeta.archivedTasks as Conversation['archivedTasks']) || [],
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
        }
        sessions.set(session.id, session)
      }
      if (records.length > 0) {
        console.log(`[store] Loaded ${records.length} sessions from SQLite`)
      }
    } catch (err) {
      console.error(`[store] Failed to load sessions: ${err}`)
    }
  }

  function persistSession(session: Conversation): void {
    if (!store) return
    try {
      const existing = store.sessions.get(session.id)
      const meta: Record<string, unknown> = {
        subagents: session.subagents,
        tasks: session.tasks,
        archivedTasks: session.archivedTasks,
        bgTasks: session.bgTasks,
        monitors: session.monitors,
        teammates: session.teammates,
        team: session.team,
        configuredModel: session.configuredModel,
        permissionMode: session.permissionMode,
        effortLevel: session.effortLevel,
        contextMode: session.contextMode,
        args: session.args,
        capabilities: session.capabilities,
        version: session.version,
        buildTime: session.buildTime,
        claudeVersion: session.claudeVersion,
        claudeAuth: session.claudeAuth,
        transcriptPath: session.transcriptPath,
        compactedAt: session.compactedAt,
        costTimeline: session.costTimeline,
        gitBranch: session.gitBranch,
        adHocTaskId: session.adHocTaskId,
        adHocWorktree: session.adHocWorktree,
        launchConfig: session.launchConfig,
        resultText: session.resultText,
        recap: session.recap,
        recapFresh: session.recapFresh,
        titleUserSet: session.titleUserSet,
        description: session.description,
        agentName: session.agentName,
        prLinks: session.prLinks?.length ? session.prLinks : undefined,
        hostSentinelId: session.hostSentinelId,
        hostSentinelAlias: session.hostSentinelAlias,
      }
      if (!existing) {
        store.sessions.create({
          id: session.id,
          scope: session.project,
          agentType: 'rclaude',
          agentVersion: session.version,
          title: session.title,
          model: session.model,
          meta,
          createdAt: session.startedAt,
        })
      } else {
        store.sessions.update(session.id, {
          status: session.status,
          model: session.model,
          title: session.title,
          summary: session.summary,
          lastActivity: session.lastActivity,
          endedAt: session.status === 'ended' ? session.lastActivity : undefined,
          meta,
          stats: session.stats as unknown as import('./store/types').ConversationStats,
        })
      }
    } catch (err) {
      console.error(`[store] Failed to persist session ${session.id.slice(0, 8)}: ${err}`)
    }
  }

  async function saveState(): Promise<void> {
    // StoreDriver writes are immediate -- this is now a no-op
  }

  async function clearState(): Promise<void> {
    sessions.clear()
    if (store) {
      const all = store.sessions.list()
      for (const s of all) {
        store.sessions.delete(s.id)
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

  function createSession(
    id: string,
    projectOrCwd: string,
    model?: string,
    args?: string[],
    capabilities?: AgentHostCapability[],
  ): Conversation {
    const sentinelAlias = getDefaultSentinelAlias()
    const project = resolveProjectUri(projectOrCwd, sentinelAlias)
    const session: Conversation = {
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
    sessions.set(id, session)
    persistSession(session)

    // Broadcast to dashboard subscribers (scoped by grants)
    broadcastSessionScoped(
      {
        type: 'conversation_created',
        sessionId: id,
        session: toSessionSummary(session),
      },
      session.project,
    )

    // Push per-session permissions to scoped subscribers so the client can
    // immediately include the new session in its filtered list.
    for (const ws of dashboardSubscribers) {
      try {
        const grants = (ws.data as { grants?: UserGrant[] }).grants
        if (!grants) continue // admins don't use sessionPermissions
        const { permissions } = resolvePermissions(grants, session.project)
        if (!permissions.has('chat:read')) continue
        ws.send(
          JSON.stringify({
            type: 'permissions',
            sessions: { [id]: resolvePermissionFlags(grants, session.project) },
          }),
        )
      } catch {}
    }

    return session
  }

  function resumeSession(id: string): void {
    const session = sessions.get(id)
    if (session) {
      session.status = 'starting'
      session.lastActivity = Date.now()
      // Reset stale state from previous run
      session.subagents = []
      session.teammates = []
      session.team = undefined
      session.compacting = false
      session.lastError = undefined
      session.rateLimit = undefined
      // Mark stale bg tasks as killed
      for (const bgTask of session.bgTasks) {
        if (bgTask.status === 'running') {
          bgTask.status = 'killed'
          bgTask.completedAt = Date.now()
        }
      }
      // Notify dashboards that this session resumed - triggers transcript re-fetch
      broadcastSessionScoped(
        {
          type: 'conversation_update',
          sessionId: id,
          session: toSessionSummary(session),
        },
        session.project,
      )
    }
  }

  // Re-key a session from oldId to newId (e.g. /clear changes Claude's session ID)
  // Preserves the session entry and wrapper socket, resets ephemeral state
  function rekeySession(
    oldId: string,
    newId: string,
    _conversationId: string,
    newProjectOrCwd: string,
    newModel?: string,
  ): Conversation | undefined {
    const newProject = newProjectOrCwd.includes('://') ? newProjectOrCwd : cwdToProjectUri(newProjectOrCwd)
    const session = sessions.get(oldId)
    if (!session) return undefined

    // Same-ID rekey: just update metadata, skip the destructive migration
    if (oldId === newId) {
      session.project = newProject
      if (newModel) session.model = newModel
      session.lastActivity = Date.now()
      persistSession(session)
      broadcastSessionScoped(
        { type: 'conversation_update', sessionId: newId, session: toSessionSummary(session) },
        session.project,
      )
      return session
    }

    // Re-key in sessions map
    sessions.delete(oldId)
    if (store) {
      try {
        store.sessions.delete(oldId)
      } catch {}
    }
    session.id = newId
    session.project = newProject
    if (newModel) session.model = newModel
    session.status = 'idle'
    session.lastActivity = Date.now()
    sessions.set(newId, session)
    persistSession(session)

    // Reset ephemeral state (preserve compacting flag - processEvent handles the transition)
    const wasCompacting = session.compacting
    session.events = []
    session.subagents = []
    session.teammates = []
    session.team = undefined
    // Don't reset session.compacting here - let processEvent clear it on SessionStart
    // so the compacted marker gets properly injected into the new transcript
    session.tasks = []
    session.archivedTasks = []
    session.diagLog = []
    session.tokenUsage = undefined
    session.summary = undefined
    session.recap = undefined
    session.recapFresh = undefined
    for (const bgTask of session.bgTasks) {
      if (bgTask.status === 'running') {
        bgTask.status = 'killed'
        bgTask.completedAt = Date.now()
      }
    }

    // Clear transcript caches + seq counters for old session ID.
    // Rekey creates a new conversation identity; the new session gets a fresh
    // counter starting at 0. Client's lastAppliedSeq for the old id is no
    // longer compared against (sessionId is the key).
    transcriptCache.delete(oldId)
    transcriptSeqCounters.delete(oldId)
    dirtyTranscripts.delete(oldId)
    // Clear subagent transcript caches (keyed as "sessionId:agentId")
    for (const key of subagentTranscriptCache.keys()) {
      if (key.startsWith(`${oldId}:`)) {
        subagentTranscriptCache.delete(key)
        subagentTranscriptSeqCounters.delete(key)
      }
    }

    // Re-key socket map
    const wrappers = sessionSockets.get(oldId)
    if (wrappers) {
      sessionSockets.delete(oldId)
      sessionSockets.set(newId, wrappers)
    }

    // Migrate channel subscriptions from oldId to newId
    migrateChannels(oldId, newId)

    // Project links are URI-based, no migration needed on rekey.

    // Clear subagent transcript subscriptions (subagents are reset on rekey)
    clearSubagentChannels(oldId)

    // Broadcast update (not end+create) so dashboard stays on this session
    broadcastSessionScoped(
      {
        type: 'conversation_update',
        sessionId: newId,
        previousSessionId: oldId,
        session: toSessionSummary(session),
      },
      session.project,
    )

    // If compaction was in progress, re-inject the compacting marker into the new transcript.
    // Sent AFTER session_update so dashboard has already switched to newId and won't wipe it.
    // Sent AFTER channel migration so broadcastToChannel reaches the migrated subscribers.
    if (wasCompacting) {
      const marker = { type: 'compacting' as const, timestamp: new Date().toISOString() }
      addTranscriptEntries(newId, [marker], false)
      broadcastToChannel('conversation:transcript', newId, {
        type: 'transcript_entries',
        sessionId: newId,
        entries: [marker],
        isInitial: false,
      })
    }

    return session
  }

  function getSession(id: string): Conversation | undefined {
    return sessions.get(id)
  }

  function getAllSessions(): Conversation[] {
    return Array.from(sessions.values())
  }

  function getActiveSessions(): Conversation[] {
    return Array.from(sessions.values()).filter(s => s.status !== 'ended')
  }

  function addEvent(sessionId: string, event: HookEvent): void {
    const session = sessions.get(sessionId)
    if (session) {
      session.events.push(event)
      if (session.events.length > MAX_EVENTS) {
        session.events.splice(0, session.events.length - MAX_EVENTS)
      }
      session.lastActivity = Date.now()

      // Feed analytics store (non-blocking, fire-and-forget)
      recordHookEvent(sessionId, event.hookEvent, (event.data || {}) as Record<string, unknown>, {
        projectUri: session.project,
        model: session.model || '',
        account: (session.claudeAuth?.email as string) || '',
        projectLabel: getProjectSettings(session.project)?.label,
      })

      // Correlate hook events to subagents: if the hook's session_id differs
      // from the parent session ID, it came from a subagent context.
      // MUST happen BEFORE status transitions so subagent activity doesn't
      // flip the parent from idle -> active (spinner stays on after Stop).
      const hookSessionId = (event.data as Record<string, unknown>)?.session_id
      const isSubagentEvent = typeof hookSessionId === 'string' && hookSessionId !== session.id
      if (isSubagentEvent) {
        const subagent = session.subagents.find(a => a.agentId === hookSessionId && a.status === 'running')
        if (subagent) {
          subagent.events.push(event)
        }
      }

      // Detect recap/away_summary events -- these are system-generated, not real user activity.
      // CC fires hook events when processing recaps but they shouldn't flip status to 'active'.
      const eventData = event.data as Record<string, unknown> | undefined
      const eventInput = eventData?.input as Record<string, unknown> | undefined
      const isRecap = eventInput?.type === 'system' && eventInput?.subtype === 'away_summary'
      if (isRecap && typeof eventInput?.content === 'string') {
        session.recap = { content: eventInput.content, timestamp: event.timestamp }
        session.recapFresh = true
        scheduleSessionUpdate(sessionId)
      }

      // Status transitions based on actual Claude hooks (not artificial timers).
      // Skip subagent events -- they shouldn't change the parent's status.
      // Skip recap events -- away_summary is system-generated, not user work.
      if (!isSubagentEvent && !isRecap) {
        if (event.hookEvent === 'Stop' || event.hookEvent === 'StopFailure') {
          session.status = 'idle'
          session.lastTurnEndedAt = event.timestamp
          // Capture error details from StopFailure
          if (event.hookEvent === 'StopFailure' && event.data) {
            const d = event.data as Record<string, unknown>
            session.lastError = {
              stopReason: String(d.stop_reason || d.stopReason || ''),
              errorType: String(d.error_type || d.errorType || ''),
              errorMessage: String(d.error_message || d.errorMessage || d.error || ''),
              timestamp: event.timestamp,
            }
          }

          // Record estimated cost for PTY sessions (headless uses exact turn_cost)
          if (event.hookEvent === 'Stop' && !session.capabilities?.includes('headless')) {
            const s = session.stats
            if (s.totalInputTokens > 0 || s.totalOutputTokens > 0) {
              // Estimate cumulative cost using LiteLLM pricing + split cache write tiers
              const info = session.model ? getModelInfo(session.model) : undefined
              let totalEstCost: number
              if (info) {
                const uncached = Math.max(0, s.totalInputTokens - s.totalCacheCreation - s.totalCacheRead)
                const cacheReadCost = info.cacheReadCostPerToken ?? info.inputCostPerToken * 0.125
                const cacheWrite5mCost = info.cacheWriteCostPerToken ?? info.inputCostPerToken * 1.25
                const cacheWrite1hCost = info.inputCostPerToken * 2.0
                totalEstCost =
                  uncached * info.inputCostPerToken +
                  s.totalOutputTokens * info.outputCostPerToken +
                  s.totalCacheRead * cacheReadCost +
                  s.totalCacheWrite5m * cacheWrite5mCost +
                  s.totalCacheWrite1h * cacheWrite1hCost
              } else {
                const uncached = Math.max(0, s.totalInputTokens - s.totalCacheCreation - s.totalCacheRead)
                totalEstCost =
                  (uncached * 15 +
                    s.totalOutputTokens * 75 +
                    s.totalCacheRead * 1.875 +
                    s.totalCacheWrite5m * 18.75 +
                    s.totalCacheWrite1h * 30) /
                  1_000_000
              }
              // Delta computation handled inside store.costs.recordTurnFromCumulatives
              store?.costs.recordTurnFromCumulatives({
                timestamp: event.timestamp,
                conversationId: sessionId,
                projectUri: session.project,
                account: session.claudeAuth?.email || '',
                orgId: session.claudeAuth?.orgId || '',
                model: session.model || '',
                totalInputTokens: s.totalInputTokens,
                totalOutputTokens: s.totalOutputTokens,
                totalCacheRead: s.totalCacheRead,
                totalCacheWrite: s.totalCacheCreation,
                totalCostUsd: totalEstCost,
                exactCost: false,
              })
            }
          }
        } else if (!PASSIVE_HOOKS.has(event.hookEvent) && session.status !== 'ended') {
          session.status = 'active'
          // Clear error/rate-limit when session resumes working
          if (session.lastError) session.lastError = undefined
          if (session.rateLimit) session.rateLimit = undefined
        }
      }

      // Extract transcript_path and model from SessionStart events
      if (event.hookEvent === 'SessionStart' && event.data) {
        const data = event.data as Record<string, unknown>
        if (data.transcript_path && typeof data.transcript_path === 'string') {
          session.transcriptPath = data.transcript_path
        }
        if (data.model && typeof data.model === 'string' && !session.model) {
          session.model = data.model
        }
        // Clear stale error from previous run (belt and suspenders with resumeSession)
        session.lastError = undefined
      }

      // Track current working directory (NOT the session's project root).
      // session.project stays as the launch project URI (project identity).
      // session.currentPath tracks where Claude is working right now.
      if (event.hookEvent === 'CwdChanged' && event.data) {
        const data = event.data as Record<string, unknown>
        if (data.cwd && typeof data.cwd === 'string') {
          session.currentPath = data.cwd
        }
      }

      // Track compacting state + inject synthetic transcript markers.
      // PreCompact -> compacting=true, PostCompact -> compacting=false + compacted marker.
      // PostCompact was added in Claude Code 2.1.76 as the definitive completion signal.
      // Fallback: SessionStart after PreCompact also clears compacting (older CC versions).
      if (event.hookEvent === 'PreCompact') {
        session.compacting = true
        const marker = { type: 'compacting', timestamp: new Date().toISOString() }
        addTranscriptEntries(sessionId, [marker], false)
        broadcastToChannel('conversation:transcript', sessionId, {
          type: 'transcript_entries',
          sessionId,
          entries: [marker],
          isInitial: false,
        })
      } else if (event.hookEvent === 'PostCompact' && session.compacting) {
        session.compacting = false
        session.compactedAt = Date.now()
        const marker = { type: 'compacted', timestamp: new Date().toISOString() }
        addTranscriptEntries(sessionId, [marker], false)
        broadcastToChannel('conversation:transcript', sessionId, {
          type: 'transcript_entries',
          sessionId,
          entries: [marker],
          isInitial: false,
        })
      } else if (session.compacting && event.hookEvent === 'SessionStart') {
        // Fallback for CC < 2.1.76 (no PostCompact): SessionStart after PreCompact = done
        session.compacting = false
        session.compactedAt = Date.now()
        const marker = { type: 'compacted', timestamp: new Date().toISOString() }
        addTranscriptEntries(sessionId, [marker], false)
        broadcastToChannel('conversation:transcript', sessionId, {
          type: 'transcript_entries',
          sessionId,
          entries: [marker],
          isInitial: false,
        })
      }

      // Capture agent description from PreToolUse(Agent) tool calls
      if (event.hookEvent === 'PreToolUse' && event.data) {
        const data = event.data as Record<string, unknown>
        if (data.tool_name === 'Agent' && data.tool_input) {
          const input = data.tool_input as Record<string, unknown>
          if (input.description && typeof input.description === 'string') {
            const queue = pendingAgentDescriptions.get(sessionId) || []
            queue.push(input.description)
            pendingAgentDescriptions.set(sessionId, queue)
          }
        }
        // Track AskUserQuestion PreToolUse - might block waiting for user
        if (data.tool_name === 'AskUserQuestion') {
          session.pendingAttention = {
            type: 'ask',
            toolName: 'AskUserQuestion',
            question: (data.tool_input as Record<string, unknown>)?.question as string | undefined,
            timestamp: event.timestamp,
          }
        }
      }

      // PermissionRequest - Claude is blocked waiting for permission approval
      if (event.hookEvent === 'PermissionRequest' && event.data) {
        const data = event.data as Record<string, unknown>
        session.pendingAttention = {
          type: 'permission',
          toolName: data.tool_name as string | undefined,
          filePath: (data.tool_input as Record<string, unknown>)?.file_path as string | undefined,
          timestamp: event.timestamp,
        }
      }

      // PermissionDenied - Claude was denied permission (tool blocked by user rules)
      if (event.hookEvent === 'PermissionDenied' && event.data) {
        const data = event.data as Record<string, unknown>
        // Clear any pending permission state since it's now resolved (denied)
        if (session.pendingAttention?.type === 'permission') {
          session.pendingAttention = undefined
        }
        if (session.pendingPermission) {
          session.pendingPermission = undefined
        }
        const toolName = data.tool_name as string | undefined
        const projectName = getProjectSettings(session.project)?.label || extractProjectLabel(session.project)
        broadcastSessionScoped(
          {
            type: 'toast',
            sessionId,
            title: projectName,
            message: `Permission denied: ${toolName || 'unknown tool'}`,
          },
          session.project,
        )
      }

      // Elicitation - Claude is asking a structured question
      if (event.hookEvent === 'Elicitation' && event.data) {
        const data = event.data as Record<string, unknown>
        session.pendingAttention = {
          type: 'elicitation',
          question: data.message as string | undefined,
          timestamp: event.timestamp,
        }
      }

      // Clear pendingAttention + stored request payloads on resolution events
      if (
        event.hookEvent === 'PostToolUse' ||
        event.hookEvent === 'PostToolUseFailure' ||
        event.hookEvent === 'ElicitationResult'
      ) {
        if (session.pendingAttention) {
          session.pendingAttention = undefined
        }
        if (session.pendingPermission) {
          session.pendingPermission = undefined
        }
        if (session.pendingAskQuestion) {
          session.pendingAskQuestion = undefined
        }
      }

      // Track sub-agent lifecycle
      if (event.hookEvent === 'SubagentStart' && event.data) {
        const data = event.data as Record<string, unknown>
        const agentId = String(data.agent_id || '')
        if (agentId && !session.subagents.some(a => a.agentId === agentId)) {
          const queue = pendingAgentDescriptions.get(sessionId)
          const description = queue?.shift()
          session.subagents.push({
            agentId,
            agentType: String(data.agent_type || 'unknown'),
            description,
            startedAt: event.timestamp,
            status: 'running',
            events: [],
          })
        }
      }

      if (event.hookEvent === 'SubagentStop' && event.data) {
        const data = event.data as Record<string, unknown>
        const agentId = String(data.agent_id || '')
        const agent = session.subagents.find(a => a.agentId === agentId)
        if (agent) {
          agent.stoppedAt = event.timestamp
          agent.status = 'stopped'
          if (data.agent_transcript_path && typeof data.agent_transcript_path === 'string') {
            agent.transcriptPath = data.agent_transcript_path
          }
        }
      }

      // TaskStop kills a background agent without firing SubagentStop.
      // Correlate by task_id (which is the agent_id) to mark it stopped.
      if (event.hookEvent === 'PostToolUse' && event.data) {
        const data = event.data as Record<string, unknown>
        if (data.tool_name === 'TaskStop' && data.tool_input) {
          const taskId = (data.tool_input as Record<string, unknown>).task_id as string | undefined
          if (taskId) {
            const agent = session.subagents.find(a => a.agentId === taskId && a.status === 'running')
            if (agent) {
              agent.status = 'stopped'
              agent.stoppedAt = event.timestamp
            }
          }
        }
      }

      // Track background Bash commands
      if (event.hookEvent === 'PostToolUse' && event.data) {
        const data = event.data as Record<string, unknown>
        const toolName = data.tool_name as string
        const input = (data.tool_input || {}) as Record<string, unknown>
        const responseObj = data.tool_response
        // tool_response can be a string OR an object - normalize to string for pattern matching
        const response =
          typeof responseObj === 'object' && responseObj !== null
            ? JSON.stringify(responseObj)
            : String(responseObj || '')

        if (toolName === 'Bash') {
          // Detect background commands - tool_response is an object with backgroundTaskId
          const bgTaskId =
            typeof responseObj === 'object' && responseObj !== null
              ? ((responseObj as Record<string, unknown>).backgroundTaskId as string | undefined)
              : undefined
          // Fallback: match "with ID: xxx" in string response (user Ctrl+B backgrounded)
          const idMatch = !bgTaskId ? response.match(/with ID: (\S+)/) : null
          const taskId = bgTaskId || idMatch?.[1]

          if (taskId) {
            session.bgTasks.push({
              taskId,
              command: String(input.command || '').slice(0, 100),
              description: String(input.description || ''),
              startedAt: event.timestamp,
              status: 'running',
            })
          }
        }

        // Detect TaskOutput/TaskStop to mark bg tasks as completed
        if (toolName === 'TaskOutput' || toolName === 'TaskStop') {
          const taskId = String(input.task_id || input.taskId || '')
          const bgTask = session.bgTasks.find(t => t.taskId === taskId)
          if (bgTask && bgTask.status === 'running') {
            bgTask.completedAt = event.timestamp
            bgTask.status = toolName === 'TaskStop' ? 'killed' : 'completed'
          }
        }
      }

      // Detect team membership from TeammateIdle events
      if (event.hookEvent === 'TeammateIdle' && event.data) {
        const data = event.data as Record<string, unknown>
        const teamName = String(data.team_name || '')
        const agentId = String(data.agent_id || '')
        const agentName = String(data.agent_name || agentId.slice(0, 8))

        if (teamName && !session.team) {
          session.team = { teamName, role: 'lead' }
        }

        if (agentId) {
          let teammate = session.teammates.find(t => t.agentId === agentId)
          if (!teammate) {
            teammate = {
              agentId,
              name: agentName,
              teamName,
              status: 'idle',
              startedAt: event.timestamp,
              completedTaskCount: 0,
            }
            session.teammates.push(teammate)
          }
          teammate.status = 'idle'
          teammate.currentTaskId = undefined
          teammate.currentTaskSubject = undefined
        }
      }

      // Track teammate work from SubagentStart (teammates are agents)
      if (event.hookEvent === 'SubagentStart' && event.data) {
        const data = event.data as Record<string, unknown>
        const agentId = String(data.agent_id || '')
        const teammate = session.teammates.find(t => t.agentId === agentId)
        if (teammate) {
          teammate.status = 'working'
        }
      }

      // Track teammate stop
      if (event.hookEvent === 'SubagentStop' && event.data) {
        const data = event.data as Record<string, unknown>
        const agentId = String(data.agent_id || '')
        const teammate = session.teammates.find(t => t.agentId === agentId)
        if (teammate) {
          teammate.status = 'stopped'
          teammate.stoppedAt = event.timestamp
        }
      }

      // Track task completion by teammates
      if (event.hookEvent === 'TaskCompleted' && event.data) {
        const data = event.data as Record<string, unknown>
        const owner = String(data.owner || '')
        const teamName = String(data.team_name || '')

        if (teamName && !session.team) {
          session.team = { teamName, role: 'lead' }
        }

        // Find teammate by name match (owner is the agent name)
        const teammate = session.teammates.find(t => t.name === owner)
        if (teammate) {
          teammate.completedTaskCount++
          teammate.currentTaskId = undefined
          teammate.currentTaskSubject = undefined
          // Back to idle after completing
          teammate.status = 'idle'
        }
      }

      // Notification hook -> toast + unread badge
      if (event.hookEvent === 'Notification') {
        session.hasNotification = true
        const data = event.data as Record<string, unknown>
        const message = typeof data.message === 'string' ? data.message : 'Needs attention'
        const projectName = getProjectSettings(session.project)?.label || extractProjectLabel(session.project)
        broadcastSessionScoped(
          {
            type: 'toast',
            sessionId,
            title: projectName,
            message,
          },
          session.project,
        )
      }

      // Broadcast event to dashboard subscribers (channel-filtered for v2)
      broadcastToChannel('conversation:events', sessionId, {
        type: 'event',
        sessionId,
        event,
      })

      // Transcript kick: if events are flowing but no transcript entries, nudge the wrapper
      if (
        session.events.length >= TRANSCRIPT_KICK_EVENT_THRESHOLD &&
        !transcriptCache.has(sessionId) &&
        session.status !== 'ended'
      ) {
        const now = Date.now()
        const lastKick = lastTranscriptKick.get(sessionId) || 0
        if (now - lastKick > TRANSCRIPT_KICK_DEBOUNCE_MS) {
          lastTranscriptKick.set(sessionId, now)
          // Find the wrapper socket for this session and send kick
          const wrappers = sessionSockets.get(sessionId)
          if (wrappers) {
            for (const ws of wrappers.values()) {
              try {
                ws.send(JSON.stringify({ type: 'transcript_kick', sessionId }))
                console.log(`[session-store] Sent transcript_kick to wrapper for ${sessionId.slice(0, 8)}`)
              } catch {
                // Wrapper socket may be dead
              }
            }
          }
        }
      }

      // Coalesce session update (for lastActivity, eventCount changes)
      scheduleSessionUpdate(sessionId)
    }
  }

  function updateActivity(sessionId: string): void {
    const session = sessions.get(sessionId)
    if (session) {
      session.lastActivity = Date.now()
      if (session.recapFresh && (!session.recap || Date.now() - session.recap.timestamp > 10_000)) {
        session.recapFresh = false
      }
      if (session.status === 'idle') {
        session.status = 'active'
      }
    }
  }

  function endSession(sessionId: string, _reason: string): void {
    const session = sessions.get(sessionId)
    if (session) {
      session.status = 'ended'
      session.planMode = false
      clearAnalyticsSession(sessionId)

      // Mark all running subagents as stopped (SubagentStop hook may not fire)
      for (const agent of session.subagents) {
        if (agent.status === 'running') {
          agent.status = 'stopped'
          agent.stoppedAt = Date.now()
        }
      }

      // Mark all teammates as stopped
      for (const teammate of session.teammates) {
        if (teammate.status !== 'stopped') {
          teammate.status = 'stopped'
          teammate.stoppedAt = Date.now()
        }
      }

      // Mark all running bg tasks as killed
      for (const bgTask of session.bgTasks) {
        if (bgTask.status === 'running') {
          bgTask.status = 'killed'
          bgTask.completedAt = Date.now()
        }
      }

      // Broadcast to dashboard subscribers (scoped by grants)
      broadcastSessionScoped(
        {
          type: 'conversation_ended',
          sessionId,
          session: toSessionSummary(session),
        },
        session.project,
      )

      // Persist to store immediately
      persistSession(session)
    }
  }

  function removeSession(sessionId: string): void {
    const session = sessions.get(sessionId)
    if (session) {
      for (const bg of session.bgTasks) {
        bgTaskOutputCache.delete(bg.taskId)
      }
    }
    sessions.delete(sessionId)
    sessionSockets.delete(sessionId)
    transcriptCache.delete(sessionId)
    transcriptSeqCounters.delete(sessionId)
    dirtyTranscripts.delete(sessionId)
    pendingAgentDescriptions.delete(sessionId)
    lastTranscriptKick.delete(sessionId)
    for (const key of subagentTranscriptCache.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        subagentTranscriptCache.delete(key)
        subagentTranscriptSeqCounters.delete(key)
      }
    }
    if (store) {
      try {
        store.sessions.delete(sessionId)
      } catch {}
    }
  }

  function getSessionEvents(sessionId: string, limit?: number, since?: number): HookEvent[] {
    const session = sessions.get(sessionId)
    if (!session) return []

    let events = session.events

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

  function setSessionSocket(sessionId: string, conversationId: string, ws: ServerWebSocket<unknown>): void {
    // Remove conversationId from any OTHER session first (wrapper reconnected to different session)
    for (const [sid, wrappers] of sessionSockets.entries()) {
      if (sid !== sessionId && wrappers.has(conversationId)) {
        wrappers.delete(conversationId)
        if (wrappers.size === 0) sessionSockets.delete(sid)
        // Broadcast so dashboard drops the stale conversationId from the old session
        broadcastSessionUpdate(sid)
      }
    }
    let wrappers = sessionSockets.get(sessionId)
    if (!wrappers) {
      wrappers = new Map()
      sessionSockets.set(sessionId, wrappers)
    }
    wrappers.set(conversationId, ws)
  }

  function getSessionSocket(sessionId: string): ServerWebSocket<unknown> | undefined {
    const wrappers = sessionSockets.get(sessionId)
    if (!wrappers || wrappers.size === 0) return undefined
    // Return the most recently added wrapper socket
    let last: ServerWebSocket<unknown> | undefined
    for (const ws of wrappers.values()) last = ws
    return last
  }

  function getSessionSocketByConversation(conversationId: string): ServerWebSocket<unknown> | undefined {
    for (const wrappers of sessionSockets.values()) {
      const ws = wrappers.get(conversationId)
      if (ws) return ws
    }
    return undefined
  }

  function getSessionByConversation(conversationId: string): Conversation | undefined {
    for (const [sessionId, wrappers] of sessionSockets.entries()) {
      if (wrappers.has(conversationId)) return sessions.get(sessionId)
    }
    return undefined
  }

  function removeSessionSocket(sessionId: string, conversationId: string): void {
    const wrappers = sessionSockets.get(sessionId)
    if (wrappers) {
      wrappers.delete(conversationId)
      if (wrappers.size === 0) sessionSockets.delete(sessionId)
    }
  }

  function getActiveConversationCount(sessionId: string): number {
    return sessionSockets.get(sessionId)?.size ?? 0
  }

  function getConversationIds(sessionId: string): string[] {
    const wrappers = sessionSockets.get(sessionId)
    return wrappers ? Array.from(wrappers.keys()) : []
  }

  // Terminal viewer management (multiple viewers per session) -- delegated to terminal-registry
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
    dashboardSubscribers.add(ws)

    // Track v2 subscribers and create registry entry (delegated to channel registry)
    channelRegistry.registerSubscriber(ws, protocolVersion, () => ++subscriberIdCounter)

    sendSessionsList(ws)

    // If this is a share viewer, notify admins about updated viewer counts
    if ((ws.data as { shareToken?: string }).shareToken) {
      broadcastSharesUpdate()
    }
  }

  /** Filter sessions by user's grants - only show sessions they have chat:read for */
  function filterSessionsByGrants(allSessions: ConversationSummary[], grants?: UserGrant[]): ConversationSummary[] {
    if (!grants) return allSessions // no grants = admin/secret auth = see everything
    return allSessions.filter(s => {
      const { permissions } = resolvePermissions(grants, s.project)
      return permissions.has('chat:read')
    })
  }

  function buildSessionsListMessage(grants?: UserGrant[]): string {
    const allSummaries = Array.from(sessions.values()).map(toSessionSummary)
    return JSON.stringify({
      type: 'conversations_list',
      sessions: filterSessionsByGrants(allSummaries, grants),
      serverVersion: BUILD_VERSION.gitHashShort,
      _epoch: sync.epoch,
      _seq: sync.seq,
    })
  }

  function sendSessionsList(ws: ServerWebSocket<unknown>): void {
    try {
      const grants = (ws.data as { grants?: UserGrant[] }).grants
      ws.send(buildSessionsListMessage(grants))
    } catch {}
  }

  function removeSubscriber(ws: ServerWebSocket<unknown>): void {
    const wasShareViewer = !!(ws.data as { shareToken?: string }).shareToken
    dashboardSubscribers.delete(ws)
    // Unregister from channel registry (removes v2, unsubscribes all channels, deletes registry entry)
    channelRegistry.unregisterSubscriber(ws)

    // If a share viewer disconnected, notify admins about updated viewer counts
    if (wasShareViewer) {
      broadcastSharesUpdate()
    }
  }

  function updateTasks(sessionId: string, tasks: TaskInfo[]): void {
    const session = sessions.get(sessionId)
    if (!session) return

    // Diff: find tasks that disappeared (deleted by Claude after completion)
    const incomingIds = new Set(tasks.map(t => t.id))
    const disappeared = session.tasks.filter(t => !incomingIds.has(t.id))
    if (disappeared.length > 0) {
      session.archivedTasks.push({
        archivedAt: Date.now(),
        tasks: disappeared,
      })
    }

    session.tasks = tasks
    scheduleSessionUpdate(sessionId)
  }

  function getSubscriberCount(): number {
    return dashboardSubscribers.size
  }

  function getSubscribers(): Set<ServerWebSocket<unknown>> {
    return dashboardSubscribers
  }

  function getShareViewerCount(shareToken: string): number {
    let count = 0
    for (const ws of dashboardSubscribers) {
      if ((ws.data as { shareToken?: string }).shareToken === shareToken) count++
    }
    return count
  }

  /** Broadcast shares_updated to admin subscribers (admin role or no grants = bearer auth) */
  function broadcastSharesUpdate(): void {
    const active = listShares()
    const shares = active.map(s => ({
      token: s.token,
      sessionCwd: s.sessionCwd,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      createdBy: s.createdBy,
      label: s.label,
      permissions: s.permissions,
      hideUserInput: s.hideUserInput || false,
      viewerCount: getShareViewerCount(s.token),
    }))
    const json = JSON.stringify({ type: 'shares_updated', shares })
    for (const ws of dashboardSubscribers) {
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

  /** Stamp `entry.seq` on every entry in-place using the per-session counter.
   *  Mutates the array in place -- callers rely on this so subsequent
   *  broadcasts (which share the same entry objects) carry the stamp.
   *  If `reset` is true, the counter is reset to 0 first (isInitial path). */
  function assignTranscriptSeqs(
    counters: Map<string, number>,
    key: string,
    entries: TranscriptEntry[],
    reset: boolean,
  ): void {
    if (reset) counters.set(key, 0)
    let seq = counters.get(key) ?? 0
    for (const e of entries) {
      e.seq = ++seq
    }
    counters.set(key, seq)
  }

  // Transcript cache methods
  function addTranscriptEntries(sessionId: string, entries: TranscriptEntry[], isInitial: boolean): void {
    // Stamp seqs BEFORE cache insert and BEFORE any broadcast the caller does.
    // All entries in `entries` are mutated in place with `entry.seq = N`.
    // Callers (handlers/transcript.ts, handlers/boot-lifecycle.ts) then
    // broadcast the same objects, so the wire payload carries seqs too.
    assignTranscriptSeqs(transcriptSeqCounters, sessionId, entries, isInitial)
    if (isInitial) {
      transcriptCache.set(sessionId, entries.slice(-MAX_TRANSCRIPT_ENTRIES))
    } else {
      const existing = transcriptCache.get(sessionId) || []
      existing.push(...entries)
      if (existing.length > MAX_TRANSCRIPT_ENTRIES) {
        transcriptCache.set(sessionId, existing.slice(-MAX_TRANSCRIPT_ENTRIES))
      } else {
        transcriptCache.set(sessionId, existing)
      }
    }
    dirtyTranscripts.add(sessionId)

    // Extract stats from transcript entries
    const session = sessions.get(sessionId)
    let sessionChanged = false
    if (session) {
      // Ensure stats object exists (sessions created before this feature)
      if (!session.stats || isInitial) {
        // Reset stats + metadata on initial load to avoid double-counting when
        // transcript watcher re-reads the full file (restart, reconnect, truncation recovery)
        session.summary = undefined
        if (!session.titleUserSet) session.title = undefined // preserve user-set titles (spawn dialog)
        session.agentName = undefined
        session.prLinks = undefined
        session.stats = {
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
        }
      }
      for (const entry of entries) {
        // Extract git branch from any entry (gitBranch is on TranscriptEntryBase)
        if (!session.gitBranch && entry.gitBranch) {
          session.gitBranch = entry.gitBranch
          sessionChanged = true
        }

        // Count user turns
        if (entry.type === 'user') {
          const userEntry = entry as TranscriptUserEntry
          const content = userEntry.message?.content
          // Only count actual user messages, not tool results
          if (typeof content === 'string' || (Array.isArray(content) && content.some(c => c.type === 'text'))) {
            if (!Array.isArray(content) || !content.some(c => c.type === 'tool_result')) {
              session.stats.turnCount++
            }
          }
        }

        // Count compactions (synthetic marker from hooks OR native JSONL compact_boundary)
        if (entry.type === 'compacted') {
          session.stats.compactionCount++
        }
        if (entry.type === 'system' && (entry as Record<string, unknown>).subtype === 'compact_boundary') {
          if (isInitial) {
            // On initial transcript load, just count for stats
            session.stats.compactionCount++
            session.compactedAt = new Date(entry.timestamp || 0).getTime()
          } else {
            // Live: cross-check against hook-based detection.
            // If hooks already handled this compaction (compactedAt set recently), skip.
            const recentlyCompacted = session.compactedAt && Date.now() - session.compactedAt < 30_000
            if (!recentlyCompacted && !session.compacting) {
              session.compactedAt = Date.now()
              session.stats.compactionCount++
              const marker = { type: 'compacted' as const, timestamp: entry.timestamp || new Date().toISOString() }
              addTranscriptEntries(sessionId, [marker], false)
              broadcastToChannel('conversation:transcript', sessionId, {
                type: 'transcript_entries',
                sessionId,
                entries: [marker],
                isInitial: false,
              })
              sessionChanged = true
              console.log(`[compact] detected via JSONL compact_boundary (session ${sessionId.slice(0, 8)})`)
            }
          }
        }

        // Detect effective context mode from /model or /context stdout.
        // These appear as `user` entries with string content wrapping <local-command-stdout>,
        // or `system` entries with subtype 'local_command'.
        {
          let stdoutContent: string | undefined
          if (entry.type === 'user') {
            const c = (entry as TranscriptUserEntry).message?.content
            if (typeof c === 'string' && c.includes('local-command-stdout')) stdoutContent = c
          } else if (entry.type === 'system' && (entry as Record<string, unknown>).subtype === 'local_command') {
            const c = (entry as Record<string, unknown>).content
            if (typeof c === 'string') stdoutContent = c
          }
          if (stdoutContent) {
            const mode = detectContextModeFromStdout(stdoutContent)
            if (mode && session.contextMode !== mode) {
              session.contextMode = mode
              sessionChanged = true
              console.log(`[meta] context mode: ${mode} (session ${sessionId.slice(0, 8)})`)
            }
          }
        }

        // Extract recap from away_summary transcript entries
        if (entry.type === 'system' && (entry as Record<string, unknown>).subtype === 'away_summary') {
          const content = (entry as Record<string, unknown>).content
          if (typeof content === 'string' && content.trim()) {
            const recapTs = new Date(entry.timestamp || 0).getTime()
            session.recap = { content: content.trim(), timestamp: recapTs }
            session.recapFresh = session.lastActivity <= recapTs + 10_000
            // CC writes away_summary precisely because the session has gone idle long enough
            // to need a "what were we doing" summary. If we still have the session as 'active'
            // from earlier activity, flip it to 'idle' -- the recap landing is itself proof.
            if (session.status === 'active') {
              session.status = 'idle'
            }
            sessionChanged = true
          }
        }

        // Extract transcript-derived metadata from special entry types
        if (entry.type === 'summary') {
          const s = (entry as Record<string, unknown>).summary
          if (typeof s === 'string' && s.trim()) {
            session.summary = s.trim()
            sessionChanged = true
            console.log(`[meta] summary: "${session.summary.slice(0, 60)}" (session ${sessionId.slice(0, 8)})`)
          }
        }
        if (entry.type === 'custom-title') {
          const t = (entry as Record<string, unknown>).customTitle
          if (typeof t === 'string' && t.trim()) {
            session.title = t.trim()
            sessionChanged = true
            console.log(`[meta] title: "${session.title}" (session ${sessionId.slice(0, 8)})`)
          }
        }
        if (entry.type === 'agent-name') {
          const n = (entry as Record<string, unknown>).agentName
          if (typeof n === 'string' && n.trim()) {
            session.agentName = n.trim()
            sessionChanged = true
            console.log(`[meta] agent: "${session.agentName}" (session ${sessionId.slice(0, 8)})`)
          }
        }
        if (entry.type === 'pr-link') {
          const e = entry as Record<string, unknown>
          const prNumber = e.prNumber as number | undefined
          const prUrl = e.prUrl as string | undefined
          const prRepository = e.prRepository as string | undefined
          if (prNumber && prUrl) {
            if (!session.prLinks) session.prLinks = []
            // Deduplicate by prUrl
            if (!session.prLinks.some(p => p.prUrl === prUrl)) {
              session.prLinks.push({
                prNumber,
                prUrl,
                prRepository: prRepository || '',
                timestamp: (e.timestamp as string) || new Date().toISOString(),
              })
              console.log(
                `[meta] pr-link: ${prRepository}#${prNumber} (session ${sessionId.slice(0, 8)}, total: ${session.prLinks.length})`,
              )
              sessionChanged = true
            }
          }
        }

        // Detect OSC 52 clipboard sequences in Bash tool results.
        // Skip on initial transcript loads to avoid re-surfacing old captures on reconnect.
        // Deduplicate by tool_use_id to prevent re-processing on transcript re-reads.
        if (!isInitial && entry.type === 'user') {
          const userContent = (entry as TranscriptUserEntry).message?.content
          if (Array.isArray(userContent)) {
            for (const block of userContent) {
              if (block.type !== 'tool_result' || typeof block.content !== 'string') continue
              const toolUseId = block.tool_use_id as string | undefined
              if (toolUseId && processedClipboardIds.has(toolUseId)) continue
              // Match OSC 52: direct (\x1b]52;c;BASE64\x07) or tmux-wrapped (Ptmux;\x1b]52;c;BASE64)
              const osc52Match =
                block.content.match(/(?:\x1bPtmux;\x1b)?(?:\x1b)?\]52;[a-z]*;([A-Za-z0-9+/=]+)/) ||
                block.content.match(/Ptmux;[^\]]*\]52;[a-z]*;([A-Za-z0-9+/=]+)/)
              if (osc52Match?.[1] && osc52Match[1].length > 8) {
                const base64 = osc52Match[1]
                const mime = detectClipboardMime(base64)
                const decodedText = mime ? undefined : Buffer.from(base64, 'base64').toString('utf-8')
                // Skip garbled/binary content that isn't readable text
                if (!mime && (!decodedText || !isReadableText(decodedText))) {
                  if (toolUseId) processedClipboardIds.add(toolUseId)
                  continue
                }
                const capture = {
                  type: 'clipboard_capture' as const,
                  sessionId,
                  contentType: mime ? ('image' as const) : ('text' as const),
                  ...(mime ? { base64, mimeType: mime } : { text: decodedText }),
                  timestamp: Date.now(),
                }
                broadcastSessionScoped(capture, session.project)
                if (toolUseId) processedClipboardIds.add(toolUseId)
                // Persist to shared files log (per-project, survives restarts)
                const clipHash = `clip_${Date.now().toString(36)}_${base64.slice(0, 8)}`
                appendSharedFile({
                  type: 'clipboard',
                  hash: clipHash,
                  filename: mime ? `clipboard.${mime.split('/')[1]}` : 'clipboard.txt',
                  mediaType: mime || 'text/plain',
                  project: session.project,
                  conversationId: sessionId,
                  size: base64.length,
                  url: '',
                  text: decodedText,
                  createdAt: Date.now(),
                })
                console.log(`[clipboard] ${capture.contentType} from transcript (session ${sessionId.slice(0, 8)})`)
              }
            }
          }
        }

        // Extract turn_duration from system entries
        if (!isInitial && entry.type === 'system') {
          const sysEntry = entry as { subtype?: string; durationMs?: number }
          if (sysEntry.subtype === 'turn_duration' && typeof sysEntry.durationMs === 'number') {
            session.stats.totalApiDurationMs += sysEntry.durationMs
            sessionChanged = true
          }
        }

        // Count lines changed from Edit/MultiEdit structuredPatch on tool results
        if (!isInitial && entry.type === 'user') {
          const userContent = (entry as TranscriptUserEntry).message?.content
          if (Array.isArray(userContent)) {
            for (const block of userContent) {
              if (block.type !== 'tool_result') continue
              const tur = (block as unknown as Record<string, unknown>).toolUseResult as
                | Record<string, unknown>
                | undefined
              const patches = tur?.structuredPatch as Array<{ lines?: string[] }> | undefined
              if (!Array.isArray(patches)) continue
              for (const hunk of patches) {
                if (!Array.isArray(hunk.lines)) continue
                for (const line of hunk.lines) {
                  if (line.startsWith('+')) session.stats.linesAdded++
                  else if (line.startsWith('-')) session.stats.linesRemoved++
                }
              }
              sessionChanged = true
            }
          }
        }

        if (entry.type !== 'assistant') continue
        const assistantEntry = entry as TranscriptAssistantEntry

        // Count tool calls
        const content = assistantEntry.message?.content
        if (Array.isArray(content)) {
          session.stats.toolCallCount += content.filter(c => c.type === 'tool_use').length
        }

        // Extract model from assistant messages as a fallback only.
        // configuredModel (from stream-json init / wrapper --model arg) is the
        // authoritative source. Assistant messages strip context-window suffixes
        // like [1m], so only use them when we have nothing better.
        const assistantModel = assistantEntry.message?.model
        if (
          assistantModel &&
          typeof assistantModel === 'string' &&
          assistantModel !== '<synthetic>' &&
          !session.model
        ) {
          session.model = assistantModel
        }

        // Extract token usage (latest = context window, cumulative = totals).
        // Skip `<synthetic>` assistant blocks (auto-compact summaries, recap,
        // hook-injected messages). They aren't real API turns and carry zeroed
        // usage that would clobber the last real context-window snapshot.
        const usage = assistantEntry.message?.usage
        if (usage && typeof usage.input_tokens === 'number' && assistantModel !== '<synthetic>') {
          session.tokenUsage = {
            input: usage.input_tokens || 0,
            cacheCreation: usage.cache_creation_input_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            output: usage.output_tokens || 0,
          }
          // Extract 5m/1h cache write split from usage.cache_creation
          const cc = usage.cache_creation as Record<string, number> | undefined
          const cw5m = cc?.ephemeral_5m_input_tokens || 0
          const cw1h = cc?.ephemeral_1h_input_tokens || 0
          // Fallback: if total cache_creation > sum of 5m+1h, remainder -> 5m bucket
          const cwTotal = usage.cache_creation_input_tokens || 0
          const cwRemainder = Math.max(0, cwTotal - cw5m - cw1h)

          // Determine dominant cache TTL tier for this turn
          if (cw5m + cwRemainder > 0 || cw1h > 0) {
            session.cacheTtl = cw1h > cw5m + cwRemainder ? '1h' : '5m'
          }

          session.stats.totalInputTokens += (usage.input_tokens || 0) + cwTotal + (usage.cache_read_input_tokens || 0)
          session.stats.totalOutputTokens += usage.output_tokens || 0
          session.stats.totalCacheCreation += cwTotal
          session.stats.totalCacheWrite5m += cw5m + cwRemainder
          session.stats.totalCacheWrite1h += cw1h
          session.stats.totalCacheRead += usage.cache_read_input_tokens || 0
          sessionChanged = true

          // Record estimated cost snapshot for PTY sessions (headless uses turn_cost)
          if (!session.stats.totalCostUsd) {
            if (!session.costTimeline) session.costTimeline = []
            // Estimate cost using split cache write pricing (5m=1.25x, 1h=2.0x input price)
            const s = session.stats
            const uncached = Math.max(0, s.totalInputTokens - s.totalCacheCreation - s.totalCacheRead)
            const est =
              (uncached * 15 +
                s.totalOutputTokens * 75 +
                s.totalCacheRead * 1.875 +
                s.totalCacheWrite5m * 18.75 +
                s.totalCacheWrite1h * 30) /
              1_000_000
            session.costTimeline.push({ t: Date.now(), cost: est })
            if (session.costTimeline.length > 500) {
              session.costTimeline = session.costTimeline.slice(-500)
            }
          }
        }
      }
    }

    // Detect bg task completions from <task-notification> in user transcript entries
    if (session?.bgTasks.some(t => t.status === 'running')) {
      for (const entry of entries) {
        if (entry.type !== 'user') continue
        const msg = entry.message as Record<string, unknown> | undefined
        const content = msg?.content
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .filter((c: Record<string, unknown>) => c.type === 'text')
                  .map((c: Record<string, unknown>) => c.text)
                  .join('')
              : ''
        if (!text.includes('<task-notification>')) continue

        // Extract task IDs and statuses
        const re = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g
        let match: RegExpExecArray | null = re.exec(text)
        while (match !== null) {
          const taskId = match[1]
          const status = match[2]
          const bgTask = session.bgTasks.find(t => t.taskId === taskId && t.status === 'running')
          if (bgTask) {
            bgTask.status = status === 'completed' ? 'completed' : 'killed'
            bgTask.completedAt = Date.now()
            sessionChanged = true
          }
          match = re.exec(text)
        }
      }
    }

    // Extract live subagent transcript entries from parent transcript
    // During runtime, agent progress is embedded in parent transcript with data.agentId
    if (session) {
      const agentEntries = new Map<string, TranscriptEntry[]>()
      for (const entry of entries) {
        const agentId =
          entry.type === 'progress'
            ? ((entry as TranscriptProgressEntry).data?.agentId as string | undefined)
            : undefined
        if (agentId && typeof agentId === 'string') {
          let batch = agentEntries.get(agentId)
          if (!batch) {
            batch = []
            agentEntries.set(agentId, batch)
          }
          batch.push(entry)
        }
      }
      // Push to subagent transcript cache + broadcast, and remove from parent cache
      if (agentEntries.size > 0) {
        for (const [agentId, agentBatch] of agentEntries) {
          console.log(
            `[transcript] ${sessionId.slice(0, 8)}... live agent ${agentId.slice(0, 7)} ${agentBatch.length} entries from parent`,
          )
          addSubagentTranscriptEntries(sessionId, agentId, agentBatch, false)
          broadcastToChannel(
            'conversation:subagent_transcript',
            sessionId,
            {
              type: 'subagent_transcript',
              sessionId,
              agentId,
              entries: agentBatch,
              isInitial: false,
            },
            agentId,
          )
        }
        // Filter extracted agent entries out of parent cache (they were copied, not moved)
        const agentEntrySet = new Set([...agentEntries.values()].flat())
        const cached = transcriptCache.get(sessionId)
        if (cached) {
          transcriptCache.set(
            sessionId,
            cached.filter(e => !agentEntrySet.has(e)),
          )
        }
      }
    }

    if (session && sessionChanged) {
      scheduleSessionUpdate(sessionId)
    }
  }

  function getTranscriptEntries(sessionId: string, limit?: number): TranscriptEntry[] {
    const entries = transcriptCache.get(sessionId) || []
    if (limit && entries.length > limit) {
      return entries.slice(-limit)
    }
    return entries
  }

  function hasTranscriptCache(sessionId: string): boolean {
    return transcriptCache.has(sessionId)
  }

  function addSubagentTranscriptEntries(
    sessionId: string,
    agentId: string,
    entries: TranscriptEntry[],
    isInitial: boolean,
  ): void {
    const key = `${sessionId}:${agentId}`
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
    const session = sessions.get(sessionId)
    if (!session) return
    const subagent = session.subagents.find(a => a.agentId === agentId)
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

    if (changed) broadcastSessionUpdate(sessionId)
  }

  function getSubagentTranscriptEntries(sessionId: string, agentId: string, limit?: number): TranscriptEntry[] {
    const entries = subagentTranscriptCache.get(`${sessionId}:${agentId}`) || []
    if (limit && entries.length > limit) {
      return entries.slice(-limit)
    }
    return entries
  }

  function hasSubagentTranscriptCache(sessionId: string, agentId: string): boolean {
    return subagentTranscriptCache.has(`${sessionId}:${agentId}`)
  }

  function addBgTaskOutput(sessionId: string, taskId: string, data: string, done: boolean) {
    if (data) {
      const existing = bgTaskOutputCache.get(taskId) || ''
      // Cap at 100KB to prevent memory issues
      const combined = existing + data
      bgTaskOutputCache.set(taskId, combined.length > 100_000 ? combined.slice(-100_000) : combined)
    }
    // Store output reference on the bgTask if it exists
    const session = sessions.get(sessionId)
    if (session && done) {
      const bgTask = session.bgTasks.find(t => t.taskId === taskId)
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
  const { addSpawnListener, removeSpawnListener, resolveSpawn, addDirListener, removeDirListener, resolveDir } =
    listeners

  // ─── Pending Launch Configs (conversationId -> LaunchConfig) ─────────────
  // Stored at spawn time, consumed when the session connects (meta handler).
  const pendingLaunchConfigs = new Map<string, LaunchConfig>()

  function setPendingLaunchConfig(conversationId: string, config: LaunchConfig) {
    pendingLaunchConfigs.set(conversationId, config)
    // Auto-cleanup after 5 min in case session never connects
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
    cleanupJobSubscriber,
  } = spawnJobs

  // Rendezvous + pending restarts: extracted to spawn-jobs.ts
  const rendezvous = createRendezvousRegistry()
  const { addPendingRestart, consumePendingRestart, getRendezvousInfo } = rendezvous

  function addRendezvous(
    conversationId: string,
    callerSessionId: string,
    project: string,
    action: 'spawn' | 'revive' | 'restart',
  ): Promise<ConversationSummary> {
    return rendezvous.addRendezvous(conversationId, callerSessionId, project, action)
  }

  function resolveRendezvous(conversationId: string, sessionId: string): boolean {
    return rendezvous.resolveRendezvous(conversationId, sessionId, id => {
      const session = sessions.get(id)
      return session ? toSessionSummary(session) : undefined
    })
  }

  // ─── Pending session names (set at spawn time, applied on connect) ──
  const pendingSessionNames = new Map<string, string>()

  function setPendingSessionName(conversationId: string, name: string): void {
    pendingSessionNames.set(conversationId, name)
    setTimeout(() => pendingSessionNames.delete(conversationId), 120_000)
  }

  function consumePendingSessionName(conversationId: string): string | undefined {
    const name = pendingSessionNames.get(conversationId)
    if (name) pendingSessionNames.delete(conversationId)
    return name
  }

  // File listeners: from extracted listeners module
  const { addFileListener, removeFileListener, resolveFile } = listeners

  function broadcastSessionUpdate(sessionId: string): void {
    scheduleSessionUpdate(sessionId)
  }

  // Inter-project link registry: extracted to project-links.ts
  const projectLinkReg = createProjectLinkRegistry(sessions, sessionSockets)
  const {
    checkProjectLink,
    linkProjects,
    unlinkProjects,
    blockProject,
    queueProjectMessage,
    drainProjectMessages,
    broadcastToConversationsForProject,
  } = projectLinkReg

  function getLinkedProjects(sessionId: string): Array<{ project: string; name: string }> {
    return projectLinkReg.getLinkedProjects(sessionId)
  }

  function broadcastForProject(projectOrCwd: string): void {
    const project = projectLinkReg.toProjectUri(projectOrCwd)
    for (const [id, s] of sessions) {
      if (s.project === project) scheduleSessionUpdate(id)
    }
  }

  return {
    createSession,
    resumeSession,
    rekeySession,
    getSession,
    getAllSessions,
    getActiveSessions,
    addEvent,
    updateActivity,
    updateTasks,
    endSession,
    removeSession,
    getSessionEvents,
    setSessionSocket,
    getSessionSocket,
    getSessionSocketByConversation,
    getSessionByConversation,
    removeSessionSocket,
    getActiveConversationCount,
    getConversationIds,
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
    sendSessionsList,
    handleSyncCheck,
    getSyncState: () => ({ epoch: sync.epoch, seq: sync.seq }),
    removeSubscriber,
    getSubscriberCount,
    getSubscribers,
    getShareViewerCount,
    broadcastSessionScoped: (message: Record<string, unknown>, project: string) =>
      broadcastSessionScoped(message as unknown as ControlPanelMessage, project),
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
    hasSentinel,
    pushSentinelDiag,
    getSentinelDiag,
    setUsage,
    getUsage,
    addTranscriptEntries,
    getTranscriptEntries,
    hasTranscriptCache,
    addSubagentTranscriptEntries,
    getSubagentTranscriptEntries,
    hasSubagentTranscriptCache,
    addBgTaskOutput,
    getBgTaskOutput,
    broadcastSessionUpdate,
    createJob,
    recordJobConfig,
    subscribeJob,
    unsubscribeJob,
    forwardJobEvent,
    completeJob,
    failJob,
    getJobByConversation,
    getJobDiagnostics,
    cleanupJobSubscriber,
    addSpawnListener,
    removeSpawnListener,
    resolveSpawn,
    addDirListener,
    removeDirListener,
    resolveDir,
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
    setPendingSessionName,
    consumePendingSessionName,
    recordTraffic,
    getTrafficStats,
    saveState,
    clearState,
    flushTranscripts,
  }
}
