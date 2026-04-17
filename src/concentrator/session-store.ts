/**
 * Session Store
 * In-memory session registry with event storage and optional persistence
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import type {
  ChannelStats,
  HookEvent,
  LaunchConfig,
  Session,
  SessionSummary,
  SubscriberDiag,
  SubscriptionChannel,
  SubscriptionsDiag,
  TaskInfo,
  TranscriptAssistantEntry,
  TranscriptEntry,
  TranscriptProgressEntry,
  TranscriptUserEntry,
  WrapperCapability,
} from '../shared/protocol'
import { BUILD_VERSION } from '../shared/version'
import { clearSession as clearAnalyticsSession, recordHookEvent } from './analytics-store'
import { recordTurnFromCumulatives } from './cost-store'
import { getModelInfo } from './model-pricing'
import type { UserGrant } from './permissions'
import { resolvePermissionFlags, resolvePermissions } from './permissions'
import { getProjectSettings } from './project-settings'
import { appendSharedFile } from './routes'
import { listShares } from './shares'

export type { SessionSummary }

/** Detect image MIME type from base64 prefix (same logic as osc52-parser.ts) */
function detectClipboardMime(base64: string): string | null {
  if (base64.startsWith('iVBORw0K')) return 'image/png'
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('R0lGOD')) return 'image/gif'
  if (base64.startsWith('UklGR')) return 'image/webp'
  return null
}

/** Check if decoded text is mostly printable (not garbled binary) */
function isReadableText(text: string): boolean {
  if (text.length === 0) return false
  let printable = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // Printable ASCII, common Unicode, newlines, tabs
    if ((code >= 0x20 && code < 0x7f) || code === 0x0a || code === 0x0d || code === 0x09 || code >= 0xa0) {
      printable++
    }
  }
  return printable / text.length > 0.8
}

// Dashboard broadcast message (concentrator -> browser)
export interface DashboardMessage {
  type:
    | 'session_update'
    | 'session_created'
    | 'session_ended'
    | 'event'
    | 'sessions_list'
    | 'agent_status'
    | 'toast'
    | 'settings_updated'
    | 'project_settings_updated'
    | 'clipboard_capture'
    | 'usage_update'
  sessionId?: string
  previousSessionId?: string
  session?: SessionSummary
  sessions?: SessionSummary[]
  event?: HookEvent
  connected?: boolean
  machineId?: string
  hostname?: string
  title?: string
  message?: string
  settings?: unknown
}

const DEFAULT_CACHE_DIR = join(homedir(), '.cache', 'concentrator')
const CACHE_FILENAME = 'sessions.json'

export interface SessionStoreOptions {
  cacheDir?: string
  enablePersistence?: boolean
}

export interface SessionStore {
  createSession: (
    id: string,
    cwd: string,
    model?: string,
    args?: string[],
    capabilities?: WrapperCapability[],
  ) => Session
  resumeSession: (id: string) => void
  rekeySession: (oldId: string, newId: string, wrapperId: string, cwd: string, model?: string) => Session | undefined
  getSession: (id: string) => Session | undefined
  getAllSessions: () => Session[]
  getActiveSessions: () => Session[]
  addEvent: (sessionId: string, event: HookEvent) => void
  updateActivity: (sessionId: string) => void
  endSession: (sessionId: string, reason: string) => void
  removeSession: (sessionId: string) => void
  getSessionEvents: (sessionId: string, limit?: number, since?: number) => HookEvent[]
  updateTasks: (sessionId: string, tasks: TaskInfo[]) => void
  setSessionSocket: (sessionId: string, wrapperId: string, ws: ServerWebSocket<unknown>) => void
  getSessionSocket: (sessionId: string) => ServerWebSocket<unknown> | undefined
  getSessionSocketByWrapper: (wrapperId: string) => ServerWebSocket<unknown> | undefined
  getSessionByWrapper: (wrapperId: string) => Session | undefined
  removeSessionSocket: (sessionId: string, wrapperId: string) => void
  getActiveWrapperCount: (sessionId: string) => number
  getWrapperIds: (sessionId: string) => string[]
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
  // Terminal viewers keyed by wrapperId (each PTY is on a specific rclaude instance)
  addTerminalViewer: (wrapperId: string, ws: ServerWebSocket<unknown>) => void
  getTerminalViewers: (wrapperId: string) => Set<ServerWebSocket<unknown>>
  removeTerminalViewer: (wrapperId: string, ws: ServerWebSocket<unknown>) => void
  removeTerminalViewerBySocket: (ws: ServerWebSocket<unknown>) => void
  hasTerminalViewers: (wrapperId: string) => boolean
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
  // Agent methods (exclusive single agent connection)
  setAgent: (ws: ServerWebSocket<unknown>, info?: { machineId?: string; hostname?: string }) => boolean
  getAgent: () => ServerWebSocket<unknown> | undefined
  getAgentInfo: () => { machineId?: string; hostname?: string } | undefined
  removeAgent: (ws: ServerWebSocket<unknown>) => void
  hasAgent: () => boolean
  // Agent diagnostics (structured log entries from host agent)
  pushAgentDiag: (entry: { t: number; type: string; msg: string; args?: unknown }) => void
  getAgentDiag: () => Array<{ t: number; type: string; msg: string; args?: unknown }>
  // Plan usage data (from agent OAuth usage API polling)
  setUsage: (usage: import('../shared/protocol').UsageUpdate) => void
  getUsage: () => import('../shared/protocol').UsageUpdate | undefined
  // Request-response listeners for agent relay (spawn, dir listing)
  addSpawnListener: (requestId: string, cb: (result: unknown) => void) => void
  removeSpawnListener: (requestId: string) => void
  resolveSpawn: (requestId: string, result: unknown) => void
  addDirListener: (requestId: string, cb: (result: unknown) => void) => void
  removeDirListener: (requestId: string) => void
  resolveDir: (requestId: string, result: unknown) => void
  addFileListener: (requestId: string, cb: (result: unknown) => void) => void
  removeFileListener: (requestId: string) => void
  resolveFile: (requestId: string, result: unknown) => boolean
  // Launch jobs (request-scoped event channels for spawn/revive progress)
  createJob: (jobId: string, wrapperId: string) => void
  recordJobConfig: (jobId: string, config: Record<string, unknown>) => void
  subscribeJob: (jobId: string, ws: ServerWebSocket<unknown>) => boolean
  unsubscribeJob: (jobId: string, ws: ServerWebSocket<unknown>) => void
  forwardJobEvent: (jobId: string, msg: Record<string, unknown>) => void
  completeJob: (wrapperId: string, sessionId: string) => void
  failJob: (jobId: string, error: string) => void
  getJobByWrapper: (wrapperId: string) => string | undefined
  getJobDiagnostics: (jobId: string) => {
    jobId: string
    wrapperId: string
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
    wrapperId: string,
    callerSessionId: string,
    cwd: string,
    action: 'spawn' | 'revive' | 'restart',
  ) => Promise<SessionSummary>
  // Pending restart (terminate + auto-revive on disconnect)
  addPendingRestart: (
    wrapperId: string,
    info: { callerSessionId: string; targetSessionId: string; cwd: string; isSelfRestart: boolean },
  ) => void
  consumePendingRestart: (
    wrapperId: string,
  ) => { callerSessionId: string; targetSessionId: string; cwd: string; isSelfRestart: boolean } | undefined
  resolveRendezvous: (wrapperId: string, sessionId: string) => boolean
  getRendezvousInfo: (wrapperId: string) => { callerSessionId: string; action: string } | undefined
  // Pending launch configs (set at spawn, consumed on connect to restore on revive)
  setPendingLaunchConfig: (wrapperId: string, config: LaunchConfig) => void
  consumePendingLaunchConfig: (wrapperId: string) => LaunchConfig | undefined
  // Pending session names (set at spawn, consumed on connect)
  setPendingSessionName: (wrapperId: string, name: string) => void
  consumePendingSessionName: (wrapperId: string) => string | undefined
  // Inter-project link management
  checkProjectLink: (from: string, to: string) => 'linked' | 'blocked' | 'unknown'
  getLinkedProjects: (sessionId: string) => Array<{ cwd: string; name: string }>
  linkProjects: (a: string, b: string) => void
  unlinkProjects: (a: string, b: string) => void
  unlinkProjectsByCwd: (cwdA: string, cwdB: string) => void
  blockProject: (blocker: string, blocked: string) => void
  queueProjectMessage: (from: string, to: string, message: Record<string, unknown>) => void
  drainProjectMessages: (from: string, to: string) => Array<Record<string, unknown>>
  broadcastForProjectCwd: (cwd: string) => void
  broadcastSessionScoped: (message: Record<string, unknown>, cwd: string) => void
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

interface PersistedState {
  version: number
  savedAt: number
  sessions: Array<Omit<Session, 'events'> & { eventCount: number }>
}

/**
 * Create a session store with optional persistence
 */
export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  const { cacheDir = DEFAULT_CACHE_DIR, enablePersistence = true } = options
  const cachePath = join(cacheDir, CACHE_FILENAME)
  const transcriptsDir = join(cacheDir, 'transcripts')

  const sessions = new Map<string, Session>()
  // sessionId -> (wrapperId -> socket): multiple rclaude instances can share a Claude session
  const sessionSockets = new Map<string, Map<string, ServerWebSocket<unknown>>>()
  // Terminal viewers keyed by wrapperId (each PTY is on a specific wrapper)
  const terminalViewers = new Map<string, Set<ServerWebSocket<unknown>>>()
  const dashboardSubscribers = new Set<ServerWebSocket<unknown>>()
  const v2Subscribers = new Set<ServerWebSocket<unknown>>()
  let agentSocket: ServerWebSocket<unknown> | undefined
  let agentInfo: { machineId?: string; hostname?: string } | undefined

  // Channel subscription registry (v2 pub/sub)
  // Forward index: channel key -> set of subscriber sockets
  const channelSubscribers = new Map<string, Set<ServerWebSocket<unknown>>>()
  // Reverse index: socket -> subscriber info (channels, stats)
  interface SubscriberEntry {
    id: string
    protocolVersion: number
    connectedAt: number
    channels: Map<
      string,
      {
        channel: SubscriptionChannel
        sessionId: string
        agentId?: string
        subscribedAt: number
        messagesSent: number
        bytesSent: number
        lastMessageAt: number
      }
    >
    totals: { messagesSent: number; bytesSent: number; messagesReceived: number; bytesReceived: number }
  }
  const subscriberRegistry = new Map<ServerWebSocket<unknown>, SubscriberEntry>()
  let subscriberIdCounter = 0

  // Sync protocol: epoch + monotonic sequence for message ordering and gap detection.
  // Epoch changes on server restart. Clients detect epoch mismatch -> full resync.
  // Capped array holds last N broadcast messages for small-gap catchup.
  // Only broadcast() messages (sent to ALL subscribers) are sequenced and buffered.
  // Channel messages (per-session transcript/events) are NOT buffered - clients
  // re-subscribe and get fresh initial pushes on reconnect.
  const SYNC_EPOCH = Math.random().toString(36).slice(2, 10)
  let syncSeq = 0
  const SYNC_BUFFER_SIZE = 500
  const syncBuffer = new Array<{ seq: number; json: string }>(SYNC_BUFFER_SIZE)
  let syncBufferHead = 0
  let syncBufferCount = 0

  function stampAndBuffer(message: unknown): string {
    const seq = ++syncSeq
    const json = JSON.stringify({ _epoch: SYNC_EPOCH, _seq: seq, ...(message as Record<string, unknown>) })
    syncBuffer[syncBufferHead] = { seq, json }
    syncBufferHead = (syncBufferHead + 1) % SYNC_BUFFER_SIZE
    if (syncBufferCount < SYNC_BUFFER_SIZE) syncBufferCount++
    return json
  }

  function syncStamp(message: unknown): string {
    return JSON.stringify({ _epoch: SYNC_EPOCH, _seq: syncSeq, ...(message as Record<string, unknown>) })
  }

  function sendSyncResponse(ws: ServerWebSocket<unknown>, type: string, extra?: Record<string, unknown>): void {
    ws.send(JSON.stringify({ type, epoch: SYNC_EPOCH, seq: syncSeq, ...extra }))
  }

  function handleSyncCheck(
    ws: ServerWebSocket<unknown>,
    clientEpoch: string,
    clientSeq: number,
    clientTranscripts?: Record<string, number>,
  ): void {
    // Compare client transcript counts with server cache.
    // Returns session IDs where server has more entries than client.
    const staleTranscripts: Record<string, number> = {}
    if (clientTranscripts) {
      for (const [sid, clientCount] of Object.entries(clientTranscripts)) {
        const serverCount = transcriptCache.get(sid)?.length ?? 0
        if (serverCount > clientCount) {
          staleTranscripts[sid] = serverCount
        }
      }
    }
    const transcriptExtra = Object.keys(staleTranscripts).length > 0 ? { staleTranscripts } : undefined

    if (clientEpoch !== SYNC_EPOCH) {
      sendSyncResponse(ws, 'sync_stale', { reason: 'epoch_changed', ...transcriptExtra })
      return
    }
    if (clientSeq >= syncSeq) {
      sendSyncResponse(ws, 'sync_ok', transcriptExtra)
      return
    }
    // Find oldest buffered seq
    if (syncBufferCount === 0) {
      sendSyncResponse(ws, 'sync_ok', transcriptExtra)
      return
    }
    const oldestIdx = (syncBufferHead - syncBufferCount + SYNC_BUFFER_SIZE) % SYNC_BUFFER_SIZE
    const oldestSeq = syncBuffer[oldestIdx].seq
    if (clientSeq < oldestSeq) {
      sendSyncResponse(ws, 'sync_stale', { reason: 'gap_too_large', missed: syncSeq - clientSeq, ...transcriptExtra })
      return
    }
    // Direct index arithmetic: seqs are monotonic, offset = clientSeq - oldestSeq + 1
    const startOffset = clientSeq - oldestSeq + 1
    const count = syncBufferCount - startOffset
    sendSyncResponse(ws, 'sync_catchup', { count, ...transcriptExtra })
    for (let i = 0; i < count; i++) {
      const idx = (oldestIdx + startOffset + i) % SYNC_BUFFER_SIZE
      try {
        ws.send(syncBuffer[idx].json)
      } catch {
        break
      }
    }
  }

  function channelKey(channel: SubscriptionChannel, sessionId: string, agentId?: string): string {
    return agentId ? `${channel}:${sessionId}:${agentId}` : `${channel}:${sessionId}`
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

  // Transcript cache: sessionId -> entries (ring buffer, max 500 per session)
  const MAX_TRANSCRIPT_ENTRIES = 500
  const transcriptCache = new Map<string, TranscriptEntry[]>()
  // Dirty tracking for transcript persistence: sessions modified since last flush
  const dirtyTranscripts = new Set<string>()
  // Deduplicate clipboard captures by tool_use_id (prevents re-processing on transcript re-reads)
  const processedClipboardIds = new Set<string>()

  // Subagent transcript cache: `${sessionId}:${agentId}` -> entries
  const subagentTranscriptCache = new Map<string, TranscriptEntry[]>()
  // Transcript kick tracking: sessionId -> last kick timestamp (debounce 60s)
  const lastTranscriptKick = new Map<string, number>()
  const TRANSCRIPT_KICK_DEBOUNCE_MS = 60_000
  const TRANSCRIPT_KICK_EVENT_THRESHOLD = 5
  // Background task output cache: taskId -> accumulated output string
  const bgTaskOutputCache = new Map<string, string>()

  // Traffic tracking: rolling window for messages/bytes per second
  const TRAFFIC_WINDOW_MS = 3000
  const trafficSamples: Array<{ t: number; dir: 'in' | 'out'; bytes: number }> = []

  function recordTraffic(direction: 'in' | 'out', bytes: number): void {
    const now = Date.now()
    trafficSamples.push({ t: now, dir: direction, bytes })
    // Prune old samples
    const cutoff = now - TRAFFIC_WINDOW_MS
    while (trafficSamples.length > 0 && trafficSamples[0].t < cutoff) {
      trafficSamples.shift()
    }
  }

  function getTrafficStats(): {
    in: { messagesPerSec: number; bytesPerSec: number }
    out: { messagesPerSec: number; bytesPerSec: number }
  } {
    const now = Date.now()
    const cutoff = now - TRAFFIC_WINDOW_MS
    // Prune stale
    while (trafficSamples.length > 0 && trafficSamples[0].t < cutoff) {
      trafficSamples.shift()
    }
    const windowSec = TRAFFIC_WINDOW_MS / 1000
    let inMsgs = 0
    let inBytes = 0
    let outMsgs = 0
    let outBytes = 0
    for (const s of trafficSamples) {
      if (s.dir === 'in') {
        inMsgs++
        inBytes += s.bytes
      } else {
        outMsgs++
        outBytes += s.bytes
      }
    }
    return {
      in: { messagesPerSec: +(inMsgs / windowSec).toFixed(1), bytesPerSec: Math.round(inBytes / windowSec) },
      out: { messagesPerSec: +(outMsgs / windowSec).toFixed(1), bytesPerSec: Math.round(outBytes / windowSec) },
    }
  }

  // Helper to create session summary for broadcasting
  function toSessionSummary(session: Session): SessionSummary {
    const wrappers = sessionSockets.get(session.id)
    return {
      id: session.id,
      cwd: session.cwd,
      model: session.model,
      capabilities: session.capabilities,
      version: session.version,
      buildTime: session.buildTime,
      claudeVersion: session.claudeVersion,
      claudeAuth: session.claudeAuth,
      spinnerVerbs: session.spinnerVerbs,
      autocompactPct: session.autocompactPct,
      maxBudgetUsd: session.maxBudgetUsd,
      wrapperIds: wrappers ? Array.from(wrappers.keys()) : [],
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
      lastError: session.lastError,
      rateLimit: session.rateLimit,
      planMode: session.planMode || undefined,
      pendingAttention: session.pendingAttention,
      hasNotification: session.hasNotification,
      summary: session.summary,
      title: session.title,
      agentName: session.agentName,
      prLinks: session.prLinks,
      linkedProjects: getLinkedProjects(session.id),
      tokenUsage: session.tokenUsage,
      cacheTtl: session.cacheTtl,
      lastTurnEndedAt: session.lastTurnEndedAt,
      stats: session.stats,
      costTimeline: session.costTimeline,
      gitBranch: session.gitBranch,
      adHocTaskId: session.adHocTaskId,
      adHocWorktree: session.adHocWorktree,
      resultText: session.resultText,
      recap: session.recap,
    }
  }

  // Broadcast to all dashboard subscribers (sequenced + buffered for sync catchup)
  function broadcast(message: DashboardMessage): void {
    const json = stampAndBuffer(message)
    for (const ws of dashboardSubscribers) {
      try {
        ws.send(json)
        recordTraffic('out', json.length)
      } catch (err) {
        const subInfo = subscriberRegistry.get(ws)
        console.error(
          `[broadcast] Send failed to ${subInfo?.id || 'unknown'}: ${err instanceof Error ? err.message : err}`,
        )
        dashboardSubscribers.delete(ws)
      }
    }
  }

  /** Broadcast a session message only to subscribers who have chat:read for that CWD */
  function broadcastSessionScoped(message: DashboardMessage, cwd: string): void {
    const json = stampAndBuffer(message)
    for (const ws of dashboardSubscribers) {
      try {
        const grants = (ws.data as { grants?: UserGrant[] }).grants
        if (grants) {
          const { permissions } = resolvePermissions(grants, cwd)
          if (!permissions.has('chat:read')) continue
        }
        ws.send(json)
        recordTraffic('out', json.length)
      } catch (err) {
        const subInfo = subscriberRegistry.get(ws)
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
            type: 'session_update',
            sessionId: id,
            session: toSessionSummary(session),
          },
          session.cwd,
        )
      }
    }
    pendingSessionUpdates.clear()
  }

  // Load persisted state on startup
  if (enablePersistence) {
    loadStateSync()
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

  // Debounced save - coalesces rapid mutations into a single write
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleSave(delayMs = 5000) {
    if (!enablePersistence) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveState().catch(() => {})
    }, delayMs)
  }

  // Also save periodically as a safety net
  if (enablePersistence) {
    setInterval(() => {
      saveState().catch(() => {})
    }, 60000)
  }

  function loadStateSync(): void {
    try {
      if (!existsSync(cachePath)) return

      const text = readFileSync(cachePath, 'utf-8')
      const state = JSON.parse(text) as PersistedState

      if (state.version !== 1) return

      // Restore sessions (without events, mark as ended since we don't know their state)
      for (const sessionData of state.sessions) {
        const session: Session = {
          ...sessionData,
          events: [],
          subagents: (sessionData.subagents || []).map(a => ({
            ...a,
            events: a.events || [],
            // Restored sessions are ended - all subagents must be stopped
            status: 'stopped' as const,
            stoppedAt: a.stoppedAt || a.startedAt,
          })),
          tasks: sessionData.tasks || [],
          archivedTasks: sessionData.archivedTasks || [],
          bgTasks: (sessionData.bgTasks || []).map(t => ({
            ...t,
            status: t.status === 'running' ? ('completed' as const) : t.status,
            completedAt: t.completedAt || t.startedAt,
          })),
          monitors: (sessionData.monitors || []).map(m => ({
            ...m,
            // Restored sessions are ended - all monitors must be stopped
            status: m.status === 'running' ? ('completed' as const) : m.status,
            stoppedAt: m.stoppedAt || m.startedAt,
          })),
          teammates: sessionData.teammates || [],
          team: sessionData.team,
          diagLog: sessionData.diagLog || [],
          // Mark restored sessions as ended unless they reconnect
          status: 'ended',
        }
        sessions.set(session.id, session)
      }

      console.log(`[cache] Loaded ${state.sessions.length} sessions from cache`)
    } catch {
      // Ignore load errors
    }
  }

  async function saveState(): Promise<void> {
    if (!enablePersistence) return

    try {
      // Ensure cache directory exists
      if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true })
      }

      // Persist sessions without events (to keep file size small)
      const sessionsToSave = Array.from(sessions.values()).map(s => ({
        id: s.id,
        cwd: s.cwd,
        model: s.model,
        args: s.args,
        capabilities: s.capabilities,
        transcriptPath: s.transcriptPath,
        startedAt: s.startedAt,
        lastActivity: s.lastActivity,
        status: s.status,
        eventCount: s.events.length,
        subagents: s.subagents,
        tasks: s.tasks,
        archivedTasks: s.archivedTasks,
        bgTasks: s.bgTasks,
        monitors: s.monitors,
        teammates: s.teammates,
        team: s.team,
        diagLog: [],
        stats: s.stats || {
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
        costTimeline: s.costTimeline,
        gitBranch: s.gitBranch,
        adHocTaskId: s.adHocTaskId,
        adHocWorktree: s.adHocWorktree,
        launchConfig: s.launchConfig,
        resultText: s.resultText,
        recap: s.recap,
        title: s.title,
        titleUserSet: s.titleUserSet,
        summary: s.summary,
        agentName: s.agentName,
        prLinks: s.prLinks?.length ? s.prLinks : undefined,
      }))

      const state: PersistedState = {
        version: 1,
        savedAt: Date.now(),
        sessions: sessionsToSave,
      }

      await Bun.write(cachePath, JSON.stringify(state, null, 2))
    } catch (error) {
      console.error(`[cache] Failed to save state: ${error}`)
    }
  }

  async function clearState(): Promise<void> {
    try {
      if (existsSync(cachePath)) {
        unlinkSync(cachePath)
        console.log(`[cache] Cleared cache at ${cachePath}`)
      }
      sessions.clear()
    } catch (error) {
      console.error(`[cache] Failed to clear state: ${error}`)
    }
  }

  // --- Transcript persistence ---

  function transcriptPath(sessionId: string): string {
    return join(transcriptsDir, `${sessionId}.jsonl`)
  }

  async function flushTranscripts(): Promise<void> {
    if (!enablePersistence || dirtyTranscripts.size === 0) return
    if (!existsSync(transcriptsDir)) {
      mkdirSync(transcriptsDir, { recursive: true })
    }
    const toFlush = [...dirtyTranscripts]
    dirtyTranscripts.clear()
    let flushed = 0
    for (const sessionId of toFlush) {
      const entries = transcriptCache.get(sessionId)
      if (!entries || entries.length === 0) continue
      try {
        const lines = `${entries.map(e => JSON.stringify(e)).join('\n')}\n`
        await Bun.write(transcriptPath(sessionId), lines)
        flushed++
      } catch (error) {
        console.error(`[transcript-persist] Failed to flush ${sessionId.slice(0, 8)}: ${error}`)
        // Re-mark dirty so next checkpoint retries
        dirtyTranscripts.add(sessionId)
      }
    }
    if (flushed > 0) {
      console.log(`[transcript-persist] Flushed ${flushed} session transcript(s) to disk`)
    }
  }

  function deleteTranscriptFile(sessionId: string): void {
    try {
      const path = transcriptPath(sessionId)
      if (existsSync(path)) {
        unlinkSync(path)
      }
    } catch {
      // Best effort
    }
    dirtyTranscripts.delete(sessionId)
  }

  function loadTranscripts(): void {
    if (!enablePersistence || !existsSync(transcriptsDir)) return
    const STALE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
    const now = Date.now()
    let loaded = 0
    let scavenged = 0
    try {
      const files = readdirSync(transcriptsDir)
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const sessionId = file.slice(0, -6) // strip .jsonl
        const filePath = join(transcriptsDir, file)

        // Scavenge: delete if session doesn't exist in store
        const session = sessions.get(sessionId)
        if (!session) {
          try {
            unlinkSync(filePath)
            scavenged++
          } catch {}
          continue
        }

        // Scavenge: delete stale transcripts for ended sessions
        if (session.status === 'ended' && now - session.lastActivity > STALE_MS) {
          try {
            unlinkSync(filePath)
            scavenged++
          } catch {}
          continue
        }

        // Load transcript into cache (only if cache is empty -- wrapper reconnect will replace)
        if (transcriptCache.has(sessionId)) continue
        try {
          const text = readFileSync(filePath, 'utf-8').trim()
          if (!text) continue
          const entries: TranscriptEntry[] = []
          for (const line of text.split('\n')) {
            if (!line.trim()) continue
            try {
              entries.push(JSON.parse(line))
            } catch {
              // Skip malformed lines
            }
          }
          if (entries.length > 0) {
            transcriptCache.set(sessionId, entries.slice(-MAX_TRANSCRIPT_ENTRIES))
            loaded++
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // transcripts dir unreadable -- not fatal
    }
    if (loaded > 0 || scavenged > 0) {
      console.log(`[transcript-persist] Loaded ${loaded} transcript(s), scavenged ${scavenged} orphan(s)`)
    }
  }

  // Load transcripts on startup (after sessions are loaded)
  loadTranscripts()

  // Checkpoint timer: flush dirty transcripts every 5 minutes
  if (enablePersistence) {
    setInterval(
      () => {
        flushTranscripts().catch(() => {})
      },
      5 * 60 * 1000,
    )
  }

  function createSession(
    id: string,
    cwd: string,
    model?: string,
    args?: string[],
    capabilities?: WrapperCapability[],
  ): Session {
    const session: Session = {
      id,
      cwd,
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
    }
    sessions.set(id, session)

    // Broadcast to dashboard subscribers (scoped by grants)
    broadcastSessionScoped(
      {
        type: 'session_created',
        sessionId: id,
        session: toSessionSummary(session),
      },
      session.cwd,
    )

    // Push per-session permissions to scoped subscribers so the client can
    // immediately include the new session in its filtered list.
    for (const ws of dashboardSubscribers) {
      try {
        const grants = (ws.data as { grants?: UserGrant[] }).grants
        if (!grants) continue // admins don't use sessionPermissions
        const { permissions } = resolvePermissions(grants, session.cwd)
        if (!permissions.has('chat:read')) continue
        ws.send(
          JSON.stringify({
            type: 'permissions',
            sessions: { [id]: resolvePermissionFlags(grants, session.cwd) },
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
          type: 'session_update',
          sessionId: id,
          session: toSessionSummary(session),
        },
        session.cwd,
      )
    }
  }

  // Re-key a session from oldId to newId (e.g. /clear changes Claude's session ID)
  // Preserves the session entry and wrapper socket, resets ephemeral state
  function rekeySession(
    oldId: string,
    newId: string,
    _wrapperId: string,
    newCwd: string,
    newModel?: string,
  ): Session | undefined {
    const session = sessions.get(oldId)
    if (!session) return undefined

    // Same-ID rekey: just update metadata, skip the destructive migration
    if (oldId === newId) {
      session.cwd = newCwd
      if (newModel) session.model = newModel
      session.lastActivity = Date.now()
      broadcastSessionScoped(
        { type: 'session_update', sessionId: newId, session: toSessionSummary(session) },
        session.cwd,
      )
      return session
    }

    // Re-key in sessions map
    sessions.delete(oldId)
    session.id = newId
    session.cwd = newCwd
    if (newModel) session.model = newModel
    session.status = 'idle'
    session.lastActivity = Date.now()
    sessions.set(newId, session)

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
    for (const bgTask of session.bgTasks) {
      if (bgTask.status === 'running') {
        bgTask.status = 'killed'
        bgTask.completedAt = Date.now()
      }
    }

    // Clear transcript caches for old session ID
    transcriptCache.delete(oldId)
    deleteTranscriptFile(oldId)
    // Clear subagent transcript caches (keyed as "sessionId:agentId")
    for (const key of subagentTranscriptCache.keys()) {
      if (key.startsWith(`${oldId}:`)) {
        subagentTranscriptCache.delete(key)
      }
    }

    // Re-key socket map
    const wrappers = sessionSockets.get(oldId)
    if (wrappers) {
      sessionSockets.delete(oldId)
      sessionSockets.set(newId, wrappers)
    }

    // Migrate channel subscriptions from oldId to newId
    const channelTypes: SubscriptionChannel[] = [
      'session:events',
      'session:transcript',
      'session:tasks',
      'session:bg_output',
    ]
    for (const channel of channelTypes) {
      const oldKey = channelKey(channel, oldId)
      const subs = channelSubscribers.get(oldKey)
      if (!subs || subs.size === 0) continue

      const newKey = channelKey(channel, newId)
      let newSubs = channelSubscribers.get(newKey)
      if (!newSubs) {
        newSubs = new Set()
        channelSubscribers.set(newKey, newSubs)
      }

      for (const ws of subs) {
        newSubs.add(ws)
        // Update reverse index
        const entry = subscriberRegistry.get(ws)
        if (entry) {
          const oldStats = entry.channels.get(oldKey)
          entry.channels.delete(oldKey)
          entry.channels.set(newKey, {
            channel,
            sessionId: newId,
            subscribedAt: oldStats?.subscribedAt || Date.now(),
            messagesSent: oldStats?.messagesSent || 0,
            bytesSent: oldStats?.bytesSent || 0,
            lastMessageAt: oldStats?.lastMessageAt || 0,
          })
        }
        // Notify dashboard of rollover
        try {
          ws.send(
            JSON.stringify({
              type: 'channel_ack',
              channel,
              sessionId: newId,
              status: 'subscribed',
              previousSessionId: oldId,
            }),
          )
        } catch {
          /* dead socket, will be cleaned up */
        }
      }
      channelSubscribers.delete(oldKey)
    }

    // Project links are CWD-based, no migration needed on rekey.

    // Clear subagent transcript subscriptions (subagents are reset on rekey)
    for (const key of channelSubscribers.keys()) {
      if (key.startsWith(`session:subagent_transcript:${oldId}:`)) {
        const subs = channelSubscribers.get(key)
        if (subs) {
          for (const ws of subs) {
            const entry = subscriberRegistry.get(ws)
            if (entry) entry.channels.delete(key)
          }
        }
        channelSubscribers.delete(key)
      }
    }

    // Broadcast update (not end+create) so dashboard stays on this session
    broadcastSessionScoped(
      {
        type: 'session_update',
        sessionId: newId,
        previousSessionId: oldId,
        session: toSessionSummary(session),
      },
      session.cwd,
    )

    // If compaction was in progress, re-inject the compacting marker into the new transcript.
    // Sent AFTER session_update so dashboard has already switched to newId and won't wipe it.
    // Sent AFTER channel migration so broadcastToChannel reaches the migrated subscribers.
    if (wasCompacting) {
      const marker = { type: 'compacting' as const, timestamp: new Date().toISOString() }
      addTranscriptEntries(newId, [marker], false)
      broadcastToChannel('session:transcript', newId, {
        type: 'transcript_entries',
        sessionId: newId,
        entries: [marker],
        isInitial: false,
      })
    }

    return session
  }

  function getSession(id: string): Session | undefined {
    return sessions.get(id)
  }

  function getAllSessions(): Session[] {
    return Array.from(sessions.values())
  }

  function getActiveSessions(): Session[] {
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
        cwd: session.cwd,
        model: session.model || '',
        account: (session.claudeAuth?.email as string) || '',
        projectLabel: getProjectSettings(session.cwd)?.label,
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
              // Delta computation handled inside recordTurnFromCumulatives
              recordTurnFromCumulatives({
                timestamp: event.timestamp,
                sessionId,
                cwd: session.cwd,
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
      // session.cwd stays as the launch directory (project identity).
      // session.currentCwd tracks where Claude is working right now.
      if (event.hookEvent === 'CwdChanged' && event.data) {
        const data = event.data as Record<string, unknown>
        if (data.cwd && typeof data.cwd === 'string') {
          session.currentCwd = data.cwd
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
        broadcastToChannel('session:transcript', sessionId, {
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
        broadcastToChannel('session:transcript', sessionId, {
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
        broadcastToChannel('session:transcript', sessionId, {
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
        const projectName = getProjectSettings(session.cwd)?.label || session.cwd.split('/').pop() || session.cwd
        broadcastSessionScoped(
          {
            type: 'toast',
            sessionId,
            title: projectName,
            message: `Permission denied: ${toolName || 'unknown tool'}`,
          },
          session.cwd,
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
        const projectName = getProjectSettings(session.cwd)?.label || session.cwd.split('/').pop() || session.cwd
        broadcastSessionScoped(
          {
            type: 'toast',
            sessionId,
            title: projectName,
            message,
          },
          session.cwd,
        )
      }

      // Broadcast event to dashboard subscribers (channel-filtered for v2)
      broadcastToChannel('session:events', sessionId, {
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
          type: 'session_ended',
          sessionId,
          session: toSessionSummary(session),
        },
        session.cwd,
      )

      // Persist immediately so ended sessions survive restarts
      scheduleSave(1000)
      // Flush transcript to disk so it survives concentrator restart
      dirtyTranscripts.add(sessionId)
      flushTranscripts().catch(() => {})
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
    pendingAgentDescriptions.delete(sessionId)
    lastTranscriptKick.delete(sessionId)
    deleteTranscriptFile(sessionId)
    for (const key of subagentTranscriptCache.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        subagentTranscriptCache.delete(key)
      }
    }
    scheduleSave(1000)
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

  function setSessionSocket(sessionId: string, wrapperId: string, ws: ServerWebSocket<unknown>): void {
    // Remove wrapperId from any OTHER session first (wrapper reconnected to different session)
    for (const [sid, wrappers] of sessionSockets.entries()) {
      if (sid !== sessionId && wrappers.has(wrapperId)) {
        wrappers.delete(wrapperId)
        if (wrappers.size === 0) sessionSockets.delete(sid)
        // Broadcast so dashboard drops the stale wrapperId from the old session
        broadcastSessionUpdate(sid)
      }
    }
    let wrappers = sessionSockets.get(sessionId)
    if (!wrappers) {
      wrappers = new Map()
      sessionSockets.set(sessionId, wrappers)
    }
    wrappers.set(wrapperId, ws)
  }

  function getSessionSocket(sessionId: string): ServerWebSocket<unknown> | undefined {
    const wrappers = sessionSockets.get(sessionId)
    if (!wrappers || wrappers.size === 0) return undefined
    // Return the most recently added wrapper socket
    let last: ServerWebSocket<unknown> | undefined
    for (const ws of wrappers.values()) last = ws
    return last
  }

  function getSessionSocketByWrapper(wrapperId: string): ServerWebSocket<unknown> | undefined {
    for (const wrappers of sessionSockets.values()) {
      const ws = wrappers.get(wrapperId)
      if (ws) return ws
    }
    return undefined
  }

  function getSessionByWrapper(wrapperId: string): Session | undefined {
    for (const [sessionId, wrappers] of sessionSockets.entries()) {
      if (wrappers.has(wrapperId)) return sessions.get(sessionId)
    }
    return undefined
  }

  function removeSessionSocket(sessionId: string, wrapperId: string): void {
    const wrappers = sessionSockets.get(sessionId)
    if (wrappers) {
      wrappers.delete(wrapperId)
      if (wrappers.size === 0) sessionSockets.delete(sessionId)
    }
  }

  function getActiveWrapperCount(sessionId: string): number {
    return sessionSockets.get(sessionId)?.size ?? 0
  }

  function getWrapperIds(sessionId: string): string[] {
    const wrappers = sessionSockets.get(sessionId)
    return wrappers ? Array.from(wrappers.keys()) : []
  }

  // Terminal viewer management (multiple viewers per session)
  function addTerminalViewer(wrapperId: string, ws: ServerWebSocket<unknown>): void {
    let viewers = terminalViewers.get(wrapperId)
    if (!viewers) {
      viewers = new Set()
      terminalViewers.set(wrapperId, viewers)
    }
    viewers.add(ws)
  }

  const EMPTY_VIEWER_SET: Set<ServerWebSocket<unknown>> = new Set()
  function getTerminalViewers(wrapperId: string): Set<ServerWebSocket<unknown>> {
    return terminalViewers.get(wrapperId) || EMPTY_VIEWER_SET
  }

  function removeTerminalViewer(wrapperId: string, ws: ServerWebSocket<unknown>): void {
    const viewers = terminalViewers.get(wrapperId)
    if (viewers) {
      viewers.delete(ws)
      if (viewers.size === 0) terminalViewers.delete(wrapperId)
    }
  }

  function removeTerminalViewerBySocket(ws: ServerWebSocket<unknown>): void {
    for (const [id, viewers] of terminalViewers) {
      viewers.delete(ws)
      if (viewers.size === 0) terminalViewers.delete(id)
    }
  }

  function hasTerminalViewers(wrapperId: string): boolean {
    const viewers = terminalViewers.get(wrapperId)
    return !!viewers && viewers.size > 0
  }

  // Dashboard subscriber management
  function addSubscriber(ws: ServerWebSocket<unknown>, protocolVersion = 1): void {
    dashboardSubscribers.add(ws)

    // Track v2 subscribers and create registry entry
    if (protocolVersion >= 2) {
      v2Subscribers.add(ws)
    }
    subscriberRegistry.set(ws, {
      id: `ws-${++subscriberIdCounter}`,
      protocolVersion,
      connectedAt: Date.now(),
      channels: new Map(),
      totals: { messagesSent: 0, bytesSent: 0, messagesReceived: 0, bytesReceived: 0 },
    })

    sendSessionsList(ws)

    // If this is a share viewer, notify admins about updated viewer counts
    if ((ws.data as { shareToken?: string }).shareToken) {
      broadcastSharesUpdate()
    }
  }

  /** Filter sessions by user's grants - only show sessions they have chat:read for */
  function filterSessionsByGrants(allSessions: SessionSummary[], grants?: UserGrant[]): SessionSummary[] {
    if (!grants) return allSessions // no grants = admin/secret auth = see everything
    return allSessions.filter(s => {
      const { permissions } = resolvePermissions(grants, s.cwd)
      return permissions.has('chat:read')
    })
  }

  function buildSessionsListMessage(grants?: UserGrant[]): string {
    const allSummaries = Array.from(sessions.values()).map(toSessionSummary)
    return JSON.stringify({
      type: 'sessions_list',
      sessions: filterSessionsByGrants(allSummaries, grants),
      serverVersion: BUILD_VERSION.gitHashShort,
      _epoch: SYNC_EPOCH,
      _seq: syncSeq,
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
    v2Subscribers.delete(ws)
    unsubscribeAllChannels(ws)
    subscriberRegistry.delete(ws)

    // If a share viewer disconnected, notify admins about updated viewer counts
    if (wasShareViewer) {
      broadcastSharesUpdate()
    }
  }

  // Channel subscription management (v2 pub/sub)
  function subscribeChannel(
    ws: ServerWebSocket<unknown>,
    channel: SubscriptionChannel,
    sessionId: string,
    agentId?: string,
  ): void {
    const key = channelKey(channel, sessionId, agentId)
    let subs = channelSubscribers.get(key)
    if (!subs) {
      subs = new Set()
      channelSubscribers.set(key, subs)
    }
    subs.add(ws)

    // Track in reverse index
    const entry = subscriberRegistry.get(ws)
    if (entry) {
      entry.channels.set(key, {
        channel,
        sessionId,
        agentId,
        subscribedAt: Date.now(),
        messagesSent: 0,
        bytesSent: 0,
        lastMessageAt: 0,
      })
    }
  }

  function unsubscribeChannel(
    ws: ServerWebSocket<unknown>,
    channel: SubscriptionChannel,
    sessionId: string,
    agentId?: string,
  ): void {
    const key = channelKey(channel, sessionId, agentId)
    const subs = channelSubscribers.get(key)
    if (subs) {
      subs.delete(ws)
      if (subs.size === 0) channelSubscribers.delete(key)
    }

    const entry = subscriberRegistry.get(ws)
    if (entry) entry.channels.delete(key)
  }

  function unsubscribeAllChannels(ws: ServerWebSocket<unknown>): void {
    const entry = subscriberRegistry.get(ws)
    if (!entry) return

    for (const key of entry.channels.keys()) {
      const subs = channelSubscribers.get(key)
      if (subs) {
        subs.delete(ws)
        if (subs.size === 0) channelSubscribers.delete(key)
      }
    }
    entry.channels.clear()
  }

  function getChannelSubscribers(
    channel: SubscriptionChannel,
    sessionId: string,
    agentId?: string,
  ): Set<ServerWebSocket<unknown>> {
    const key = channelKey(channel, sessionId, agentId)
    return channelSubscribers.get(key) || new Set()
  }

  function broadcastToChannel(
    channel: SubscriptionChannel,
    sessionId: string,
    message: unknown,
    agentId?: string,
  ): void {
    // Channel messages are per-session, not buffered for sync catchup.
    // Clients re-subscribe on reconnect and get fresh initial data.
    const json = syncStamp(message)
    const bytes = json.length
    const sent = new Set<ServerWebSocket<unknown>>()

    // Pre-compute filtered JSON for share viewers with hideUserInput
    // Only needed for transcript channels (user entries are in transcript_entries messages)
    let filteredJson: string | null = null
    let filteredBytes = 0
    function getFilteredJson(): string {
      if (filteredJson !== null) return filteredJson
      const msg = message as { entries?: Array<{ type?: string }> }
      if (msg.entries) {
        const filtered = { ...msg, entries: msg.entries.filter(e => e.type !== 'user') }
        // Skip sending if all entries were user messages
        filteredJson = filtered.entries.length > 0 ? syncStamp(filtered) : ''
        filteredBytes = filteredJson.length
      } else {
        filteredJson = json // no entries field, pass through
        filteredBytes = bytes
      }
      return filteredJson
    }

    // Send to v2 channel subscribers
    const key = channelKey(channel, sessionId, agentId)
    const subs = channelSubscribers.get(key)
    if (subs) {
      for (const ws of subs) {
        try {
          // Filter transcript entries for share viewers with hideUserInput
          const wsData = ws.data as { hideUserInput?: boolean }
          if (channel === 'session:transcript' && wsData.hideUserInput) {
            const fj = getFilteredJson()
            if (!fj) {
              sent.add(ws)
              continue // all entries were user messages, skip
            }
            ws.send(fj)
            sent.add(ws)
            recordTraffic('out', filteredBytes)
            const entry = subscriberRegistry.get(ws)
            if (entry) {
              entry.totals.messagesSent++
              entry.totals.bytesSent += filteredBytes
              const chStats = entry.channels.get(key)
              if (chStats) {
                chStats.messagesSent++
                chStats.bytesSent += filteredBytes
                chStats.lastMessageAt = Date.now()
              }
            }
            continue
          }
          ws.send(json)
          sent.add(ws)
          recordTraffic('out', bytes)
          // Track per-channel stats
          const entry = subscriberRegistry.get(ws)
          if (entry) {
            entry.totals.messagesSent++
            entry.totals.bytesSent += bytes
            const chStats = entry.channels.get(key)
            if (chStats) {
              chStats.messagesSent++
              chStats.bytesSent += bytes
              chStats.lastMessageAt = Date.now()
            }
          }
        } catch (err) {
          const subInfo = subscriberRegistry.get(ws)
          console.error(
            `[broadcast] Send failed to ${subInfo?.id || 'unknown'}: ${err instanceof Error ? err.message : err}`,
          )
          subs.delete(ws)
          if (subs.size === 0) channelSubscribers.delete(key)
        }
      }
    }

    // Also send to legacy (v1) subscribers that haven't received it
    for (const ws of dashboardSubscribers) {
      if (!sent.has(ws) && !v2Subscribers.has(ws)) {
        try {
          ws.send(json)
          recordTraffic('out', bytes)
          const entry = subscriberRegistry.get(ws)
          if (entry) {
            entry.totals.messagesSent++
            entry.totals.bytesSent += bytes
          }
        } catch (err) {
          const subInfo = subscriberRegistry.get(ws)
          console.error(
            `[broadcast] Send failed to ${subInfo?.id || 'unknown'}: ${err instanceof Error ? err.message : err}`,
          )
          dashboardSubscribers.delete(ws)
        }
      }
    }
  }

  function isV2Subscriber(ws: ServerWebSocket<unknown>): boolean {
    return v2Subscribers.has(ws)
  }

  function getSubscriptionsDiag(): SubscriptionsDiag {
    const subscribers: SubscriberDiag[] = []
    for (const [ws, entry] of subscriberRegistry) {
      const channels: ChannelStats[] = []
      for (const ch of entry.channels.values()) {
        channels.push({
          channel: ch.channel,
          sessionId: ch.sessionId,
          agentId: ch.agentId,
          subscribedAt: ch.subscribedAt,
          messagesSent: ch.messagesSent,
          bytesSent: ch.bytesSent,
          lastMessageAt: ch.lastMessageAt,
        })
      }
      const wsData = ws.data as { userName?: string } | undefined
      subscribers.push({
        id: entry.id,
        userName: wsData?.userName,
        protocolVersion: entry.protocolVersion,
        connectedAt: entry.connectedAt,
        channels,
        totals: { ...entry.totals },
      })
    }

    // Channel counts summary
    const channelCounts: Record<string, number> = {}
    for (const [key, subs] of channelSubscribers) {
      const channelName = key.split(':').slice(0, 2).join(':')
      channelCounts[channelName] = (channelCounts[channelName] || 0) + subs.size
    }

    let totalBytesSent = 0
    let totalMessagesSent = 0
    for (const entry of subscriberRegistry.values()) {
      totalBytesSent += entry.totals.bytesSent
      totalMessagesSent += entry.totals.messagesSent
    }

    return {
      subscribers,
      summary: {
        totalSubscribers: dashboardSubscribers.size,
        legacySubscribers: dashboardSubscribers.size - v2Subscribers.size,
        v2Subscribers: v2Subscribers.size,
        channelCounts,
        totalBytesSent,
        totalMessagesSent,
      },
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

  // Agent management (exclusive single connection)
  function setAgent(ws: ServerWebSocket<unknown>, info?: { machineId?: string; hostname?: string }): boolean {
    if (agentSocket) return false // reject - already connected
    agentSocket = ws
    agentInfo = info
    broadcast({ type: 'agent_status', connected: true, machineId: info?.machineId, hostname: info?.hostname })
    return true
  }

  function getAgent(): ServerWebSocket<unknown> | undefined {
    return agentSocket
  }

  function getAgentInfo(): { machineId?: string; hostname?: string } | undefined {
    return agentInfo
  }

  function removeAgent(ws: ServerWebSocket<unknown>): void {
    if (agentSocket === ws) {
      agentSocket = undefined
      agentInfo = undefined
      broadcast({ type: 'agent_status', connected: false })
    }
  }

  function hasAgent(): boolean {
    return !!agentSocket
  }

  // Agent diagnostics - capped ring buffer
  const agentDiagLog: Array<{ t: number; type: string; msg: string; args?: unknown }> = []
  const AGENT_DIAG_MAX = 200

  function pushAgentDiag(entry: { t: number; type: string; msg: string; args?: unknown }) {
    agentDiagLog.push(entry)
    if (agentDiagLog.length > AGENT_DIAG_MAX) {
      agentDiagLog.splice(0, agentDiagLog.length - AGENT_DIAG_MAX)
    }
  }

  function getAgentDiag() {
    return [...agentDiagLog]
  }

  // Plan usage data (from agent polling OAuth usage API)
  let currentUsage: import('../shared/protocol').UsageUpdate | undefined

  function setUsage(usage: import('../shared/protocol').UsageUpdate) {
    currentUsage = usage
    broadcast({ type: 'usage_update', usage } as unknown as DashboardMessage)
  }

  function getUsage(): import('../shared/protocol').UsageUpdate | undefined {
    return currentUsage
  }

  // Transcript cache methods
  function addTranscriptEntries(sessionId: string, entries: TranscriptEntry[], isInitial: boolean): void {
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
              broadcastToChannel('session:transcript', sessionId, {
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

        // Extract recap from away_summary transcript entries
        if (entry.type === 'system' && (entry as Record<string, unknown>).subtype === 'away_summary') {
          const content = (entry as Record<string, unknown>).content
          if (typeof content === 'string' && content.trim()) {
            session.recap = { content: content.trim(), timestamp: new Date(entry.timestamp || 0).getTime() }
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
                broadcastSessionScoped(capture, session.cwd)
                if (toolUseId) processedClipboardIds.add(toolUseId)
                // Persist to shared files log (per-CWD, survives restarts)
                const clipHash = `clip_${Date.now().toString(36)}_${base64.slice(0, 8)}`
                appendSharedFile({
                  type: 'clipboard',
                  hash: clipHash,
                  filename: mime ? `clipboard.${mime.split('/')[1]}` : 'clipboard.txt',
                  mediaType: mime || 'text/plain',
                  cwd: session.cwd,
                  sessionId,
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

        // Extract model + effort from assistant messages (more reliable than SessionStart).
        // CC writes `model: "<synthetic>"` on locally-generated assistant blocks
        // (auto-compact summaries, recap, hook-injected messages). Only accept it as
        // a fallback when we have nothing else -- never let it clobber a real model.
        const assistantModel = assistantEntry.message?.model
        if (assistantModel && typeof assistantModel === 'string') {
          if (assistantModel !== '<synthetic>' || !session.model) {
            session.model = assistantModel
          }
        }

        // Extract token usage (latest = context window, cumulative = totals).
        // Skip `<synthetic>` assistant blocks (auto-compact summaries, recap,
        // hook-injected messages). They aren't real API turns and carry zeroed
        // usage that would clobber the last real context-window snapshot.
        const usage = assistantEntry.message?.usage
        if (usage && typeof usage.input_tokens === 'number' && assistantModel !== '<synthetic>') {
          // Extract effort level from API 'speed' field
          if (usage.speed && typeof usage.speed === 'string') {
            session.effortLevel = usage.speed
          }
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
            'session:subagent_transcript',
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
      subagentTranscriptCache.set(key, entries.slice(-MAX_TRANSCRIPT_ENTRIES))
    } else {
      const existing = subagentTranscriptCache.get(key) || []
      // Deduplicate: agent entries arrive from both the subagent JSONL watcher
      // AND extracted from parent transcript progress entries. Use uuid to filter.
      const seen = new Set(existing.map(e => e.uuid).filter(Boolean))
      const fresh = entries.filter(e => !e.uuid || !seen.has(e.uuid))
      if (fresh.length === 0) return
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

  // Request-response listener maps for agent relay
  const spawnListeners = new Map<string, (result: unknown) => void>()
  const dirListeners = new Map<string, (result: unknown) => void>()

  function addSpawnListener(requestId: string, cb: (result: unknown) => void) {
    spawnListeners.set(requestId, cb)
  }
  function removeSpawnListener(requestId: string) {
    spawnListeners.delete(requestId)
  }
  function resolveSpawn(requestId: string, result: unknown) {
    const cb = spawnListeners.get(requestId)
    if (cb) {
      spawnListeners.delete(requestId)
      cb(result)
    }
  }
  function addDirListener(requestId: string, cb: (result: unknown) => void) {
    dirListeners.set(requestId, cb)
  }
  function removeDirListener(requestId: string) {
    dirListeners.delete(requestId)
  }
  function resolveDir(requestId: string, result: unknown) {
    const cb = dirListeners.get(requestId)
    if (cb) {
      dirListeners.delete(requestId)
      cb(result)
    }
  }

  // ─── Pending Launch Configs (wrapperId -> LaunchConfig) ─────────────
  // Stored at spawn time, consumed when the session connects (meta handler).
  const pendingLaunchConfigs = new Map<string, LaunchConfig>()

  function setPendingLaunchConfig(wrapperId: string, config: LaunchConfig) {
    pendingLaunchConfigs.set(wrapperId, config)
    // Auto-cleanup after 5 min in case session never connects
    setTimeout(() => pendingLaunchConfigs.delete(wrapperId), 5 * 60 * 1000)
  }

  function consumePendingLaunchConfig(wrapperId: string): LaunchConfig | undefined {
    const config = pendingLaunchConfigs.get(wrapperId)
    if (config) pendingLaunchConfigs.delete(wrapperId)
    return config
  }

  // ─── Launch Jobs (request-scoped event channels) ────────────────────
  // Dashboard subscribes to a jobId before spawning/reviving.
  // Agent sends launch_log events tagged with jobId.
  // Concentrator forwards to subscribers. Completes when session connects.
  //
  // We also accumulate events/state on the job so MCP callers (or any other
  // late subscriber) can fetch a full diagnostic snapshot via getJobDiagnostics
  // without having to tail the websocket in real time.
  interface LaunchJobEvent {
    type: string
    step?: string
    status?: string
    detail?: string | null
    t: number
  }
  interface LaunchJob {
    jobId: string
    wrapperId: string
    subscribers: Set<ServerWebSocket<unknown>>
    createdAt: number
    events: LaunchJobEvent[]
    completed: boolean
    failed: boolean
    error: string | null
    sessionId: string | null
    // Snapshot of the spawn request config (sans the heavy prompt). Recorded
    // via recordJobConfig() after dispatchSpawn resolves request defaults.
    config: Record<string, unknown> | null
    endedAt: number | null
  }
  const launchJobs = new Map<string, LaunchJob>() // jobId -> job
  const wrapperToJob = new Map<string, string>() // wrapperId -> jobId
  const JOB_EXPIRY_MS = 5 * 60 * 1000 // 5 minutes

  function createJob(jobId: string, wrapperId: string): void {
    const existing = launchJobs.get(jobId)
    if (existing) {
      // Dashboard pre-subscribed before spawn HTTP returned - update wrapperId
      existing.wrapperId = wrapperId
    } else {
      launchJobs.set(jobId, {
        jobId,
        wrapperId,
        subscribers: new Set(),
        createdAt: Date.now(),
        events: [],
        completed: false,
        failed: false,
        error: null,
        sessionId: null,
        config: null,
        endedAt: null,
      })
    }
    wrapperToJob.set(wrapperId, jobId)
  }

  function recordJobConfig(jobId: string, config: Record<string, unknown>): void {
    const job = launchJobs.get(jobId)
    if (!job) return
    job.config = config
  }

  function subscribeJob(jobId: string, ws: ServerWebSocket<unknown>): boolean {
    const job = launchJobs.get(jobId)
    if (!job) {
      // Job not created yet - create a placeholder (dashboard subscribes before HTTP spawn returns)
      launchJobs.set(jobId, {
        jobId,
        wrapperId: '',
        subscribers: new Set([ws]),
        createdAt: Date.now(),
        events: [],
        completed: false,
        failed: false,
        error: null,
        sessionId: null,
        config: null,
        endedAt: null,
      })
      return true
    }
    job.subscribers.add(ws)
    return true
  }

  function unsubscribeJob(jobId: string, ws: ServerWebSocket<unknown>): void {
    const job = launchJobs.get(jobId)
    if (job) {
      job.subscribers.delete(ws)
      // Don't delete the job - other subscribers may still be watching, and agent events may still arrive
    }
  }

  function forwardJobEvent(jobId: string, msg: Record<string, unknown>): void {
    const job = launchJobs.get(jobId)
    if (!job) return
    // Persist into the job so late subscribers (MCP get_spawn_diagnostics, etc.)
    // can fetch the full event history even after the live stream has moved on.
    const t = typeof msg.t === 'number' ? msg.t : Date.now()
    job.events.push({
      type: String(msg.type ?? 'unknown'),
      step: typeof msg.step === 'string' ? msg.step : undefined,
      status: typeof msg.status === 'string' ? msg.status : undefined,
      detail: typeof msg.detail === 'string' ? msg.detail : msg.detail === null ? null : undefined,
      t,
    })
    const payload = JSON.stringify(msg)
    for (const ws of job.subscribers) {
      try {
        ws.send(payload)
      } catch {}
    }
  }

  function completeJob(wrapperId: string, sessionId: string): void {
    const jobId = wrapperToJob.get(wrapperId)
    if (!jobId) return
    const job = launchJobs.get(jobId)
    if (!job) return

    job.completed = true
    job.sessionId = sessionId
    job.endedAt = Date.now()
    forwardJobEvent(jobId, { type: 'job_complete', jobId, sessionId, wrapperId })

    // Cleanup after a short delay (let dashboard process the completion)
    setTimeout(() => {
      launchJobs.delete(jobId)
      wrapperToJob.delete(wrapperId)
    }, 30_000)
  }

  function failJob(jobId: string, error: string): void {
    const job = launchJobs.get(jobId)
    if (job) {
      job.failed = true
      job.error = error
      job.endedAt = Date.now()
    }
    forwardJobEvent(jobId, { type: 'job_failed', jobId, error })
    // Cleanup after delay
    if (job) {
      setTimeout(() => {
        launchJobs.delete(jobId)
        if (job.wrapperId) wrapperToJob.delete(job.wrapperId)
      }, 30_000)
    }
  }

  /**
   * Return a diagnostics snapshot for a job, or null if the job is unknown /
   * already expired. Shape matches SpawnDiagnostics (built client-side via
   * buildSpawnDiagnostics) but left loose here so we don't import UI types.
   */
  function getJobDiagnostics(jobId: string): {
    jobId: string
    wrapperId: string
    sessionId: string | null
    completed: boolean
    failed: boolean
    error: string | null
    createdAt: number
    endedAt: number | null
    elapsedMs: number
    config: Record<string, unknown> | null
    events: LaunchJobEvent[]
  } | null {
    const job = launchJobs.get(jobId)
    if (!job) return null
    const now = Date.now()
    return {
      jobId: job.jobId,
      wrapperId: job.wrapperId,
      sessionId: job.sessionId,
      completed: job.completed,
      failed: job.failed,
      error: job.error,
      createdAt: job.createdAt,
      endedAt: job.endedAt,
      elapsedMs: (job.endedAt ?? now) - job.createdAt,
      config: job.config,
      events: job.events,
    }
  }

  function getJobByWrapper(wrapperId: string): string | undefined {
    return wrapperToJob.get(wrapperId)
  }

  function cleanupJobSubscriber(ws: ServerWebSocket<unknown>): void {
    for (const job of launchJobs.values()) {
      job.subscribers.delete(ws)
    }
  }

  // Periodic cleanup of expired jobs
  setInterval(() => {
    const now = Date.now()
    for (const [jobId, job] of launchJobs) {
      if (now - job.createdAt > JOB_EXPIRY_MS) {
        launchJobs.delete(jobId)
        if (job.wrapperId) wrapperToJob.delete(job.wrapperId)
      }
    }
  }, 60_000)

  // Session rendezvous: callers waiting for a session to connect at a specific wrapperId
  // Used by spawn/revive to notify the caller when the spawned session is ready
  interface SessionRendezvous {
    callerSessionId: string
    wrapperId: string
    cwd: string
    action: 'spawn' | 'revive' | 'restart'
    resolve: (session: SessionSummary) => void
    reject: (error: string) => void
    timer: ReturnType<typeof setTimeout>
    registeredAt: number
  }
  const RENDEZVOUS_TIMEOUT_MS = 120_000 // 2 minutes
  const sessionRendezvous = new Map<string, SessionRendezvous>() // keyed by wrapperId

  // Pending restarts: terminate target, revive on disconnect
  interface PendingRestart {
    callerSessionId: string
    targetSessionId: string
    cwd: string
    isSelfRestart: boolean
  }
  const pendingRestarts = new Map<string, PendingRestart>() // keyed by target wrapperId

  function addPendingRestart(wrapperId: string, info: PendingRestart): void {
    pendingRestarts.set(wrapperId, info)
    console.log(
      `[restart] PENDING: target=${wrapperId.slice(0, 8)} cwd=${info.cwd.split('/').pop()} self=${info.isSelfRestart}`,
    )
  }

  function consumePendingRestart(wrapperId: string): PendingRestart | undefined {
    const info = pendingRestarts.get(wrapperId)
    if (info) {
      pendingRestarts.delete(wrapperId)
      console.log(`[restart] CONSUMED: target=${wrapperId.slice(0, 8)} cwd=${info.cwd.split('/').pop()}`)
    }
    return info
  }

  function addRendezvous(
    wrapperId: string,
    callerSessionId: string,
    cwd: string,
    action: 'spawn' | 'revive' | 'restart',
  ): Promise<SessionSummary> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sessionRendezvous.delete(wrapperId)
        reject(`Session did not connect within ${RENDEZVOUS_TIMEOUT_MS / 1000}s`)
        console.log(
          `[rendezvous] TIMEOUT: ${action} wrapperId=${wrapperId.slice(0, 8)} cwd=${cwd.split('/').pop()} caller=${callerSessionId.slice(0, 8)}`,
        )
      }, RENDEZVOUS_TIMEOUT_MS)

      sessionRendezvous.set(wrapperId, {
        callerSessionId,
        wrapperId,
        cwd,
        action,
        resolve,
        reject,
        timer,
        registeredAt: Date.now(),
      })
      console.log(
        `[rendezvous] REGISTERED: ${action} wrapperId=${wrapperId.slice(0, 8)} cwd=${cwd.split('/').pop()} caller=${callerSessionId.slice(0, 8)}`,
      )
    })
  }

  function resolveRendezvous(wrapperId: string, sessionId: string): boolean {
    const rv = sessionRendezvous.get(wrapperId)
    if (!rv) return false
    sessionRendezvous.delete(wrapperId)
    clearTimeout(rv.timer)
    const session = sessions.get(sessionId)
    if (!session) {
      rv.reject('Session created but not found in store')
      return false
    }
    const summary = toSessionSummary(session)
    rv.resolve(summary)
    const elapsed = Date.now() - rv.registeredAt
    console.log(
      `[rendezvous] RESOLVED: ${rv.action} session=${sessionId.slice(0, 8)} wrapperId=${wrapperId.slice(0, 8)} elapsed=${elapsed}ms caller=${rv.callerSessionId.slice(0, 8)}`,
    )
    return true
  }

  function getRendezvousInfo(wrapperId: string): { callerSessionId: string; action: string } | undefined {
    const rv = sessionRendezvous.get(wrapperId)
    if (!rv) return undefined
    return { callerSessionId: rv.callerSessionId, action: rv.action }
  }

  // ─── Pending session names (set at spawn time, applied on connect) ──
  const pendingSessionNames = new Map<string, string>() // wrapperId -> name

  function setPendingSessionName(wrapperId: string, name: string): void {
    pendingSessionNames.set(wrapperId, name)
    // Auto-expire after 2 minutes (if wrapper never connects)
    setTimeout(() => pendingSessionNames.delete(wrapperId), 120_000)
  }

  function consumePendingSessionName(wrapperId: string): string | undefined {
    const name = pendingSessionNames.get(wrapperId)
    if (name) pendingSessionNames.delete(wrapperId)
    return name
  }

  const fileListeners = new Map<string, (result: unknown) => void>()
  function addFileListener(requestId: string, cb: (result: unknown) => void) {
    fileListeners.set(requestId, cb)
  }
  function removeFileListener(requestId: string) {
    fileListeners.delete(requestId)
  }
  function resolveFile(requestId: string, result: unknown): boolean {
    const cb = fileListeners.get(requestId)
    if (cb) {
      fileListeners.delete(requestId)
      cb(result)
      return true
    }
    return false
  }

  function broadcastSessionUpdate(sessionId: string): void {
    scheduleSessionUpdate(sessionId)
  }

  // ─── Inter-project link registry ────────────────────────────────────
  // Links are bidirectional. If A->B is approved, B->A is also approved.
  // Links are stored by CWD pair (project identity), not session ID.
  // Public functions accept session IDs and resolve to CWDs internally.
  const cwdLinks = new Set<string>() // "cwdA:cwdB" format (sorted)
  const cwdBlocks = new Map<string, number>() // "cwdA:cwdB" -> block timestamp
  const messageQueue = new Map<string, Array<Record<string, unknown>>>() // "cwdA:cwdB" -> queued messages

  function cwdLinkKey(cwdA: string, cwdB: string): string {
    return [cwdA, cwdB].sort().join(':')
  }

  function sessionToCwd(sessionId: string): string | undefined {
    return sessions.get(sessionId)?.cwd
  }

  function getLinkedProjects(sessionId: string): Array<{ cwd: string; name: string }> {
    const cwd = sessionToCwd(sessionId)
    if (!cwd) return []
    const result: Array<{ cwd: string; name: string }> = []
    for (const key of cwdLinks) {
      const [a, b] = key.split(':')
      const otherCwd = a === cwd ? b : b === cwd ? a : null
      if (!otherCwd) continue
      const name = getProjectSettings(otherCwd)?.label || otherCwd.split('/').pop() || otherCwd.slice(0, 8)
      result.push({ cwd: otherCwd, name })
    }
    return result
  }

  function unlinkProjects(a: string, b: string): void {
    const cwdA = sessionToCwd(a)
    const cwdB = sessionToCwd(b)
    if (cwdA && cwdB) cwdLinks.delete(cwdLinkKey(cwdA, cwdB))
  }

  function unlinkProjectsByCwd(cwdA: string, cwdB: string): void {
    cwdLinks.delete(cwdLinkKey(cwdA, cwdB))
  }

  function checkProjectLink(from: string, to: string): 'linked' | 'blocked' | 'unknown' {
    const cwdFrom = sessionToCwd(from)
    const cwdTo = sessionToCwd(to)
    if (!cwdFrom || !cwdTo) return 'unknown'
    const key = cwdLinkKey(cwdFrom, cwdTo)
    if (cwdLinks.has(key)) return 'linked'
    const blockTs = cwdBlocks.get(key)
    if (blockTs && Date.now() - blockTs < 60_000) return 'blocked' // 1 min debounce
    if (blockTs) cwdBlocks.delete(key) // expired
    return 'unknown'
  }

  function linkProjects(a: string, b: string): void {
    const cwdA = sessionToCwd(a)
    const cwdB = sessionToCwd(b)
    if (!cwdA || !cwdB) return
    cwdLinks.add(cwdLinkKey(cwdA, cwdB))
    cwdBlocks.delete(cwdLinkKey(cwdA, cwdB))
  }

  function blockProject(blocker: string, blocked: string): void {
    const cwdA = sessionToCwd(blocker)
    const cwdB = sessionToCwd(blocked)
    if (!cwdA || !cwdB) return
    const key = cwdLinkKey(cwdA, cwdB)
    cwdLinks.delete(key)
    cwdBlocks.set(key, Date.now())
  }

  function queueProjectMessage(from: string, to: string, message: Record<string, unknown>): void {
    const cwdFrom = sessionToCwd(from)
    const cwdTo = sessionToCwd(to)
    if (!cwdFrom || !cwdTo) return
    const key = cwdLinkKey(cwdFrom, cwdTo)
    const queue = messageQueue.get(key) || []
    queue.push(message)
    messageQueue.set(key, queue)
  }

  function drainProjectMessages(from: string, to: string): Array<Record<string, unknown>> {
    const cwdFrom = sessionToCwd(from)
    const cwdTo = sessionToCwd(to)
    if (!cwdFrom || !cwdTo) return []
    const key = cwdLinkKey(cwdFrom, cwdTo)
    const msgs = messageQueue.get(key) || []
    messageQueue.delete(key)
    return msgs
  }

  function broadcastForProjectCwd(cwd: string): void {
    for (const [id, s] of sessions) {
      if (s.cwd === cwd) scheduleSessionUpdate(id)
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
    getSessionSocketByWrapper,
    getSessionByWrapper,
    removeSessionSocket,
    getActiveWrapperCount,
    getWrapperIds,
    addTerminalViewer,
    getTerminalViewers,
    removeTerminalViewer,
    removeTerminalViewerBySocket,
    hasTerminalViewers,
    addSubscriber,
    sendSessionsList,
    handleSyncCheck,
    getSyncState: () => ({ epoch: SYNC_EPOCH, seq: syncSeq }),
    removeSubscriber,
    getSubscriberCount,
    getSubscribers,
    getShareViewerCount,
    broadcastSessionScoped: (message: Record<string, unknown>, cwd: string) =>
      broadcastSessionScoped(message as unknown as DashboardMessage, cwd),
    broadcastSharesUpdate,
    subscribeChannel,
    unsubscribeChannel,
    unsubscribeAllChannels,
    getChannelSubscribers,
    broadcastToChannel,
    isV2Subscriber,
    getSubscriptionsDiag,
    setAgent,
    getAgent,
    getAgentInfo,
    removeAgent,
    hasAgent,
    pushAgentDiag,
    getAgentDiag,
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
    getJobByWrapper,
    getJobDiagnostics,
    cleanupJobSubscriber,
    addSpawnListener,
    removeSpawnListener,
    resolveSpawn,
    addDirListener,
    removeDirListener,
    resolveDir,
    addFileListener,
    removeFileListener,
    resolveFile,
    checkProjectLink,
    getLinkedProjects,
    linkProjects,
    unlinkProjects,
    unlinkProjectsByCwd,
    blockProject,
    queueProjectMessage,
    drainProjectMessages,
    broadcastForProjectCwd,
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
