/**
 * Session Store
 * In-memory session registry with event storage and optional persistence
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import type {
  HookEvent,
  Session,
  SessionSummary,
  TaskInfo,
  TranscriptEntry,
  WrapperCapability,
} from '../shared/protocol'
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
  addSubscriber: (ws: ServerWebSocket<unknown>) => void
  removeSubscriber: (ws: ServerWebSocket<unknown>) => void
  getSubscriberCount: () => number
  getSubscribers: () => Set<ServerWebSocket<unknown>>
  // Agent methods (exclusive single agent connection)
  setAgent: (ws: ServerWebSocket<unknown>) => boolean
  getAgent: () => ServerWebSocket<unknown> | undefined
  removeAgent: (ws: ServerWebSocket<unknown>) => void
  hasAgent: () => boolean
  // Request-response listeners for agent relay (spawn, dir listing)
  addSpawnListener: (requestId: string, cb: (result: any) => void) => void
  removeSpawnListener: (requestId: string) => void
  resolveSpawn: (requestId: string, result: any) => void
  addDirListener: (requestId: string, cb: (result: any) => void) => void
  removeDirListener: (requestId: string) => void
  resolveDir: (requestId: string, result: any) => void
  addFileListener: (requestId: string, cb: (result: any) => void) => void
  removeFileListener: (requestId: string) => void
  resolveFile: (requestId: string, result: any) => boolean
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
  let agentSocket: ServerWebSocket<unknown> | undefined

  // Pending agent descriptions: PreToolUse(Agent) pushes, SubagentStart pops
  const pendingAgentDescriptions = new Map<string, string[]>()

  // Hooks that don't indicate Claude is actively working (hoisted to avoid per-call allocation)
  const PASSIVE_HOOKS = new Set(['Stop', 'Notification', 'TeammateIdle', 'TaskCompleted', 'SessionEnd'])
  const MAX_EVENTS = 1000

  // Transcript cache: sessionId -> entries (ring buffer, max 500 per session)
  const MAX_TRANSCRIPT_ENTRIES = 500
  const transcriptCache = new Map<string, TranscriptEntry[]>()
  // Subagent transcript cache: `${sessionId}:${agentId}` -> entries
  const subagentTranscriptCache = new Map<string, TranscriptEntry[]>()
  // Background task output cache: taskId -> accumulated output string
  const bgTaskOutputCache = new Map<string, string>()

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
      tokenUsage: session.tokenUsage,
      stats: session.stats,
      gitBranch: session.gitBranch,
    }
  }

  // Broadcast message to all dashboard subscribers
  function broadcast(message: DashboardMessage): void {
    const json = JSON.stringify(message)
    for (const ws of dashboardSubscribers) {
      try {
        ws.send(json)
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
  const EVICTION_TTL_MS = 60 * 60 * 1000 // 1 hour after ending
  const MAX_ENDED_SESSIONS = 50 // hard cap on ended sessions in memory

  setInterval(() => {
    const now = Date.now()
    const STALE_AGENT_MS = 10 * 60 * 1000 // 10 minutes
    const LIVENESS_MS = 30_000 // 30s without hooks = not "actively receiving"
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

  // Auto-save state periodically (every 30 seconds)
  if (enablePersistence) {
    setInterval(() => {
      saveState().catch(() => {})
    }, 30000)
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
          subagents: ((sessionData as any).subagents || []).map((a: any) => ({
            ...a,
            events: a.events || [],
            // Restored sessions are ended - all subagents must be stopped
            status: 'stopped',
            stoppedAt: a.stoppedAt || a.startedAt,
          })),
          tasks: (sessionData as any).tasks || [],
          archivedTasks: (sessionData as any).archivedTasks || [],
          bgTasks: ((sessionData as any).bgTasks || []).map((t: any) => ({
            ...t,
            status: t.status === 'running' ? 'completed' : t.status,
            completedAt: t.completedAt || t.startedAt,
          })),
          teammates: (sessionData as any).teammates || [],
          team: (sessionData as any).team,
          diagLog: (sessionData as any).diagLog || [],
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
      status: 'idle',
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
      session.status = 'idle'
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

    // Reset ephemeral state
    session.events = []
    session.subagents = []
    session.teammates = []
    session.team = undefined
    session.compacting = false
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

    // Broadcast update (not end+create) so dashboard stays on this session
    broadcast({
      type: 'session_update',
      sessionId: newId,
      previousSessionId: oldId,
      session: toSessionSummary(session),
    })

    return session
  }

  function getSession(id: string): Session | undefined {
    return sessions.get(id)
  }

  function getAllSessions(): Session[] {
    return Array.from(sessions.values())
  }

  function getActiveSessions(): Session[] {
    return Array.from(sessions.values()).filter(s => s.status === 'active' || s.status === 'idle')
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
      if (event.hookEvent === 'Stop') {
        session.status = 'idle'
      } else if (!PASSIVE_HOOKS.has(event.hookEvent) && session.status !== 'ended') {
        session.status = 'active'
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

      // Track compacting state + inject synthetic transcript markers
      if (event.hookEvent === 'PreCompact') {
        session.compacting = true
        const marker = { type: 'compacting', timestamp: new Date().toISOString() }
        addTranscriptEntries(sessionId, [marker], false)
        broadcast({
          type: 'transcript_entries',
          sessionId,
          entries: [marker],
          isInitial: false,
        } as any)
      } else if (session.compacting && event.hookEvent === 'SessionStart') {
        session.compacting = false
        session.compactedAt = Date.now()
        const marker = { type: 'compacted', timestamp: new Date().toISOString() }
        addTranscriptEntries(sessionId, [marker], false)
        broadcast({
          type: 'transcript_entries',
          sessionId,
          entries: [marker],
          isInitial: false,
        } as any)
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

      // Broadcast event to dashboard subscribers
      broadcast({
        type: 'event',
        sessionId,
        event,
      })

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
    for (const key of subagentTranscriptCache.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        subagentTranscriptCache.delete(key)
      }
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
  function addSubscriber(ws: ServerWebSocket<unknown>): void {
    dashboardSubscribers.add(ws)

    // Send current sessions list immediately upon subscription
    const sessionsList = Array.from(sessions.values()).map(toSessionSummary)
    try {
      ws.send(
        JSON.stringify({
          type: 'sessions_list',
          sessions: sessionsList,
        }),
      )
    } catch {
      dashboardSubscribers.delete(ws)
    }
  }

  function removeSubscriber(ws: ServerWebSocket<unknown>): void {
    dashboardSubscribers.delete(ws)
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
  function setAgent(ws: ServerWebSocket<unknown>): boolean {
    if (agentSocket) return false // reject - already connected
    agentSocket = ws
    broadcast({ type: 'agent_status', connected: true })
    return true
  }

  function getAgent(): ServerWebSocket<unknown> | undefined {
    return agentSocket
  }

  function removeAgent(ws: ServerWebSocket<unknown>): void {
    if (agentSocket === ws) {
      agentSocket = undefined
      broadcast({ type: 'agent_status', connected: false })
    }
  }

  function hasAgent(): boolean {
    return !!agentSocket
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
      if (!session.stats) {
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
        // Extract git branch from any entry
        if (!session.gitBranch && (entry as any).gitBranch) {
          session.gitBranch = (entry as any).gitBranch
          sessionChanged = true
        }

        // Count user turns
        if (entry.type === 'user') {
          const content = (entry as any).message?.content
          // Only count actual user messages, not tool results
          if (typeof content === 'string' || (Array.isArray(content) && content.some((c: any) => c.type === 'text'))) {
            if (!Array.isArray(content) || !content.some((c: any) => c.type === 'tool_result')) {
              session.stats.turnCount++
            }
          }
        }

        // Count compactions
        if (entry.type === 'compacted') {
          session.stats.compactionCount++
        }

        if (entry.type !== 'assistant') continue

        // Count tool calls
        const content = (entry as any).message?.content
        if (Array.isArray(content)) {
          session.stats.toolCallCount += content.filter((c: any) => c.type === 'tool_use').length
        }

        // Extract token usage (latest = context window, cumulative = totals)
        const usage = (entry as any).message?.usage
        if (usage && typeof usage.input_tokens === 'number') {
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
    if (session && session.bgTasks.some(t => t.status === 'running')) {
      for (const entry of entries) {
        if (entry.type !== 'user') continue
        const msg = entry.message as Record<string, unknown> | undefined
        const content = msg?.content
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .filter((c: any) => c.type === 'text')
                  .map((c: any) => c.text)
                  .join('')
              : ''
        if (!text.includes('<task-notification>')) continue

        // Extract task IDs and statuses
        const re = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g
        let match: RegExpExecArray | null
        while ((match = re.exec(text)) !== null) {
          const taskId = match[1]
          const status = match[2]
          const bgTask = session.bgTasks.find(t => t.taskId === taskId && t.status === 'running')
          if (bgTask) {
            bgTask.status = status === 'completed' ? 'completed' : 'killed'
            bgTask.completedAt = Date.now()
            sessionChanged = true
          }
        }
      }
    }

    // Extract live subagent transcript entries from parent transcript
    // During runtime, agent progress is embedded in parent transcript with data.agentId
    if (session) {
      const agentEntries = new Map<string, TranscriptEntry[]>()
      for (const entry of entries) {
        const agentId = (entry as any).agentId || (entry as any).data?.agentId
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
        broadcast({
          type: 'subagent_transcript',
          sessionId,
          agentId,
          entries: agentBatch,
          isInitial: false,
        } as any)
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
      existing.push(...entries)
      if (existing.length > MAX_TRANSCRIPT_ENTRIES) {
        subagentTranscriptCache.set(key, existing.slice(-MAX_TRANSCRIPT_ENTRIES))
      } else {
        subagentTranscriptCache.set(key, existing)
      }
    }
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
  const spawnListeners = new Map<string, (result: any) => void>()
  const dirListeners = new Map<string, (result: any) => void>()

  function addSpawnListener(requestId: string, cb: (result: any) => void) {
    spawnListeners.set(requestId, cb)
  }
  function removeSpawnListener(requestId: string) {
    spawnListeners.delete(requestId)
  }
  function resolveSpawn(requestId: string, result: any) {
    const cb = spawnListeners.get(requestId)
    if (cb) {
      spawnListeners.delete(requestId)
      cb(result)
    }
  }
  function addDirListener(requestId: string, cb: (result: any) => void) {
    dirListeners.set(requestId, cb)
  }
  function removeDirListener(requestId: string) {
    dirListeners.delete(requestId)
  }
  function resolveDir(requestId: string, result: any) {
    const cb = dirListeners.get(requestId)
    if (cb) {
      dirListeners.delete(requestId)
      cb(result)
    }
  }

  const fileListeners = new Map<string, (result: any) => void>()
  function addFileListener(requestId: string, cb: (result: any) => void) {
    fileListeners.set(requestId, cb)
  }
  function removeFileListener(requestId: string) {
    fileListeners.delete(requestId)
  }
  function resolveFile(requestId: string, result: any): boolean {
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
    removeSubscriber,
    getSubscriberCount,
    getSubscribers,
    setAgent,
    getAgent,
    removeAgent,
    hasAgent,
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
    saveState,
    clearState,
  }
}
