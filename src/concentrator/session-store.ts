/**
 * Session Store
 * In-memory session registry with event storage and optional persistence
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import type {
  ChannelStats,
  HookEvent,
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
import { getProjectSettings } from './project-settings'

export type { SessionSummary }

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
  handleSyncCheck: (ws: ServerWebSocket<unknown>, clientEpoch: string, clientSeq: number) => void
  getSyncState: () => { epoch: string; seq: number }
  removeSubscriber: (ws: ServerWebSocket<unknown>) => void
  getSubscriberCount: () => number
  getSubscribers: () => Set<ServerWebSocket<unknown>>
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
  // Inter-session messaging
  checkSessionLink: (from: string, to: string) => 'linked' | 'blocked' | 'unknown'
  getLinkedSessions: (sessionId: string) => string[]
  linkSessions: (a: string, b: string) => void
  unlinkSessions: (a: string, b: string) => void
  blockSession: (blocker: string, blocked: string) => void
  queueInterSessionMessage: (from: string, to: string, message: Record<string, unknown>) => void
  drainQueuedMessages: (from: string, to: string) => Array<Record<string, unknown>>
  recordTraffic: (direction: 'in' | 'out', bytes: number) => void
  getTrafficStats: () => {
    in: { messagesPerSec: number; bytesPerSec: number }
    out: { messagesPerSec: number; bytesPerSec: number }
  }
  saveState: () => Promise<void>
  clearState: () => Promise<void>
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

  function handleSyncCheck(ws: ServerWebSocket<unknown>, clientEpoch: string, clientSeq: number): void {
    if (clientEpoch !== SYNC_EPOCH) {
      sendSyncResponse(ws, 'sync_stale', { reason: 'epoch_changed' })
      return
    }
    if (clientSeq >= syncSeq) {
      sendSyncResponse(ws, 'sync_ok')
      return
    }
    // Find oldest buffered seq
    if (syncBufferCount === 0) {
      sendSyncResponse(ws, 'sync_ok')
      return
    }
    const oldestIdx = (syncBufferHead - syncBufferCount + SYNC_BUFFER_SIZE) % SYNC_BUFFER_SIZE
    const oldestSeq = syncBuffer[oldestIdx].seq
    if (clientSeq < oldestSeq) {
      sendSyncResponse(ws, 'sync_stale', { reason: 'gap_too_large', missed: syncSeq - clientSeq })
      return
    }
    // Direct index arithmetic: seqs are monotonic, offset = clientSeq - oldestSeq + 1
    const startOffset = clientSeq - oldestSeq + 1
    const count = syncBufferCount - startOffset
    sendSyncResponse(ws, 'sync_catchup', { count })
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
  ])
  const MAX_EVENTS = 1000

  // Transcript cache: sessionId -> entries (ring buffer, max 500 per session)
  const MAX_TRANSCRIPT_ENTRIES = 500
  const transcriptCache = new Map<string, TranscriptEntry[]>()
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
      runningBgTaskCount: session.bgTasks.filter(t => t.status === 'running').length,
      bgTasks: session.bgTasks.map(t => ({
        taskId: t.taskId,
        command: t.command,
        description: t.description,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        status: t.status,
      })),
      teammates: session.teammates.map(t => ({
        name: t.name,
        status: t.status,
        currentTaskSubject: t.currentTaskSubject,
        completedTaskCount: t.completedTaskCount,
      })),
      team: session.team,
      effortLevel: session.effortLevel,
      lastError: session.lastError,
      pendingAttention: session.pendingAttention,
      summary: session.summary,
      title: session.title,
      agentName: session.agentName,
      prLinks: session.prLinks,
      linkedSessions: getLinkedSessions(session.id).map(id => {
        const s = sessions.get(id)
        return {
          id,
          name: s?.title || getProjectSettings(s?.cwd || '')?.label || s?.cwd?.split('/').pop() || id.slice(0, 8),
        }
      }),
      tokenUsage: session.tokenUsage,
      stats: session.stats,
      gitBranch: session.gitBranch,
    }
  }

  // Broadcast to all dashboard subscribers (sequenced + buffered for sync catchup)
  function broadcast(message: DashboardMessage): void {
    const json = stampAndBuffer(message)
    for (const ws of dashboardSubscribers) {
      try {
        ws.send(json)
        recordTraffic('out', json.length)
      } catch {
        // Remove dead connections
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
        broadcast({
          type: 'session_update',
          sessionId: id,
          session: toSessionSummary(session),
        })
      }
    }
    pendingSessionUpdates.clear()
  }

  // Load persisted state on startup
  if (enablePersistence) {
    loadStateSync()
  }

  // Periodically mark idle sessions, clean stale agents, evict old sessions, and save state
  const EVICTION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours after ending
  const MAX_ENDED_SESSIONS = 50 // hard cap on ended sessions in memory

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
      if (session.status === 'ended' && now - session.lastActivity > EVICTION_TTL_MS) {
        toEvict.push(session.id)
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
        teammates: s.teammates,
        team: s.team,
        diagLog: [],
        stats: s.stats || {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreation: 0,
          totalCacheRead: 0,
          turnCount: 0,
          toolCallCount: 0,
          compactionCount: 0,
        },
        gitBranch: s.gitBranch,
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
      diagLog: [],
      teammates: [],
      stats: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreation: 0,
        totalCacheRead: 0,
        turnCount: 0,
        toolCallCount: 0,
        compactionCount: 0,
      },
    }
    sessions.set(id, session)

    // Broadcast to dashboard subscribers
    broadcast({
      type: 'session_created',
      sessionId: id,
      session: toSessionSummary(session),
    })

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
      // Mark stale bg tasks as killed
      for (const bgTask of session.bgTasks) {
        if (bgTask.status === 'running') {
          bgTask.status = 'killed'
          bgTask.completedAt = Date.now()
        }
      }
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
    for (const bgTask of session.bgTasks) {
      if (bgTask.status === 'running') {
        bgTask.status = 'killed'
        bgTask.completedAt = Date.now()
      }
    }

    // Clear transcript caches for old session ID
    transcriptCache.delete(oldId)
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
    broadcast({
      type: 'session_update',
      sessionId: newId,
      previousSessionId: oldId,
      session: toSessionSummary(session),
    })

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

      // Status transitions based on actual Claude hooks (not artificial timers)
      if (event.hookEvent === 'Stop' || event.hookEvent === 'StopFailure') {
        session.status = 'idle'
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
      } else if (!PASSIVE_HOOKS.has(event.hookEvent) && session.status !== 'ended') {
        session.status = 'active'
        // Clear error when session resumes working
        if (session.lastError) session.lastError = undefined
      }

      // Correlate hook events to subagents: if the hook's session_id differs
      // from the parent session ID, it came from a subagent context
      const hookSessionId = (event.data as Record<string, unknown>)?.session_id
      if (typeof hookSessionId === 'string' && hookSessionId !== session.id) {
        const subagent = session.subagents.find(a => a.agentId === hookSessionId && a.status === 'running')
        if (subagent) {
          subagent.events.push(event)
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
      }

      // Update CWD when Claude changes directory
      if (event.hookEvent === 'CwdChanged' && event.data) {
        const data = event.data as Record<string, unknown>
        if (data.cwd && typeof data.cwd === 'string') {
          session.cwd = data.cwd
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

      // Elicitation - Claude is asking a structured question
      if (event.hookEvent === 'Elicitation' && event.data) {
        const data = event.data as Record<string, unknown>
        session.pendingAttention = {
          type: 'elicitation',
          question: data.message as string | undefined,
          timestamp: event.timestamp,
        }
      }

      // Clear pendingAttention on resolution events
      if (
        event.hookEvent === 'PostToolUse' ||
        event.hookEvent === 'PostToolUseFailure' ||
        event.hookEvent === 'ElicitationResult'
      ) {
        if (session.pendingAttention) {
          session.pendingAttention = undefined
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

      // Notification hook -> toast to all dashboards
      if (event.hookEvent === 'Notification') {
        const data = event.data as Record<string, unknown>
        const message = typeof data.message === 'string' ? data.message : 'Needs attention'
        const projectName = getProjectSettings(session.cwd)?.label || session.cwd.split('/').pop() || session.cwd
        broadcast({
          type: 'toast',
          sessionId,
          title: projectName,
          message,
        })
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

      // Broadcast to dashboard subscribers
      broadcast({
        type: 'session_ended',
        sessionId,
        session: toSessionSummary(session),
      })

      // Persist immediately so ended sessions survive restarts
      scheduleSave(1000)
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
  }

  function buildSessionsListMessage(): string {
    return JSON.stringify({
      type: 'sessions_list',
      sessions: Array.from(sessions.values()).map(toSessionSummary),
      serverVersion: BUILD_VERSION.gitHashShort,
      _epoch: SYNC_EPOCH,
      _seq: syncSeq,
    })
  }

  function sendSessionsList(ws: ServerWebSocket<unknown>): void {
    try {
      ws.send(buildSessionsListMessage())
    } catch {}
  }

  function removeSubscriber(ws: ServerWebSocket<unknown>): void {
    dashboardSubscribers.delete(ws)
    v2Subscribers.delete(ws)
    unsubscribeAllChannels(ws)
    subscriberRegistry.delete(ws)
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

    // Send to v2 channel subscribers
    const key = channelKey(channel, sessionId, agentId)
    const subs = channelSubscribers.get(key)
    if (subs) {
      for (const ws of subs) {
        try {
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
        } catch {
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
        } catch {
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

  // Transcript cache methods
  function addTranscriptEntries(sessionId: string, entries: TranscriptEntry[], isInitial: boolean): void {
    if (isInitial) {
      // Initial batch replaces everything (watcher read the full file)
      transcriptCache.set(sessionId, entries.slice(-MAX_TRANSCRIPT_ENTRIES))
    } else {
      const existing = transcriptCache.get(sessionId) || []
      existing.push(...entries)
      // Trim to max
      if (existing.length > MAX_TRANSCRIPT_ENTRIES) {
        transcriptCache.set(sessionId, existing.slice(-MAX_TRANSCRIPT_ENTRIES))
      } else {
        transcriptCache.set(sessionId, existing)
      }
    }

    // Extract stats from transcript entries
    const session = sessions.get(sessionId)
    let sessionChanged = false
    if (session) {
      // Ensure stats object exists (sessions created before this feature)
      if (!session.stats || isInitial) {
        // Reset stats + metadata on initial load to avoid double-counting when
        // transcript watcher re-reads the full file (restart, reconnect, truncation recovery)
        session.summary = undefined
        session.title = undefined
        session.agentName = undefined
        session.prLinks = undefined
        session.stats = {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreation: 0,
          totalCacheRead: 0,
          turnCount: 0,
          toolCallCount: 0,
          compactionCount: 0,
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

        // Count compactions
        if (entry.type === 'compacted') {
          session.stats.compactionCount++
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

        if (entry.type !== 'assistant') continue
        const assistantEntry = entry as TranscriptAssistantEntry

        // Count tool calls
        const content = assistantEntry.message?.content
        if (Array.isArray(content)) {
          session.stats.toolCallCount += content.filter(c => c.type === 'tool_use').length
        }

        // Extract model + effort from assistant messages (more reliable than SessionStart)
        const assistantModel = assistantEntry.message?.model
        if (assistantModel && typeof assistantModel === 'string') {
          session.model = assistantModel
        }

        // Extract token usage (latest = context window, cumulative = totals)
        const usage = assistantEntry.message?.usage
        if (usage && typeof usage.input_tokens === 'number') {
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
          session.stats.totalInputTokens +=
            (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
          session.stats.totalOutputTokens += usage.output_tokens || 0
          session.stats.totalCacheCreation += usage.cache_creation_input_tokens || 0
          session.stats.totalCacheRead += usage.cache_read_input_tokens || 0
          sessionChanged = true
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
      // Push to subagent transcript cache + broadcast
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

  // ─── Inter-session link registry ──────────────────────────────────────
  // Links are bidirectional. If A->B is approved, B->A is also approved.
  const sessionLinks = new Set<string>() // "a:b" format (sorted)
  const sessionBlocks = new Map<string, number>() // "a:b" -> block timestamp
  const messageQueue = new Map<string, Array<Record<string, unknown>>>() // "from:to" -> queued messages

  function linkKey(a: string, b: string): string {
    return [a, b].sort().join(':')
  }

  function getLinkedSessions(sessionId: string): string[] {
    const linked: string[] = []
    for (const key of sessionLinks) {
      const [a, b] = key.split(':')
      if (a === sessionId) linked.push(b)
      else if (b === sessionId) linked.push(a)
    }
    return linked
  }

  function unlinkSessions(a: string, b: string): void {
    sessionLinks.delete(linkKey(a, b))
  }

  function checkSessionLink(from: string, to: string): 'linked' | 'blocked' | 'unknown' {
    const key = linkKey(from, to)
    if (sessionLinks.has(key)) return 'linked'
    const blockTs = sessionBlocks.get(key)
    if (blockTs && Date.now() - blockTs < 60_000) return 'blocked' // 1 min debounce
    if (blockTs) sessionBlocks.delete(key) // expired
    return 'unknown'
  }

  function linkSessions(a: string, b: string): void {
    sessionLinks.add(linkKey(a, b))
    sessionBlocks.delete(linkKey(a, b))
  }

  function blockSession(blocker: string, blocked: string): void {
    const key = linkKey(blocker, blocked)
    sessionLinks.delete(key)
    sessionBlocks.set(key, Date.now())
  }

  function queueInterSessionMessage(from: string, to: string, message: Record<string, unknown>): void {
    const key = `${from}:${to}`
    const queue = messageQueue.get(key) || []
    queue.push(message)
    messageQueue.set(key, queue)
  }

  function drainQueuedMessages(from: string, to: string): Array<Record<string, unknown>> {
    const key = `${from}:${to}`
    const msgs = messageQueue.get(key) || []
    messageQueue.delete(key)
    return msgs
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
    addTranscriptEntries,
    getTranscriptEntries,
    hasTranscriptCache,
    addSubagentTranscriptEntries,
    getSubagentTranscriptEntries,
    hasSubagentTranscriptCache,
    addBgTaskOutput,
    getBgTaskOutput,
    broadcastSessionUpdate,
    addSpawnListener,
    removeSpawnListener,
    resolveSpawn,
    addDirListener,
    removeDirListener,
    resolveDir,
    addFileListener,
    removeFileListener,
    resolveFile,
    checkSessionLink,
    getLinkedSessions,
    linkSessions,
    unlinkSessions,
    blockSession,
    queueInterSessionMessage,
    drainQueuedMessages,
    recordTraffic,
    getTrafficStats,
    saveState,
    clearState,
  }
}
