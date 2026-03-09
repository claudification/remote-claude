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
  TaskInfo,
  TeamInfo,
  TeammateInfo,
  TranscriptEntry,
  WrapperCapability,
} from '../shared/protocol'
import { IDLE_TIMEOUT_MS } from '../shared/protocol'

const DEFAULT_CACHE_DIR = join(homedir(), '.cache', 'concentrator')
const CACHE_FILENAME = 'sessions.json'

export interface SessionStoreOptions {
  cacheDir?: string
  enablePersistence?: boolean
}

// Message types for dashboard subscribers
export interface DashboardMessage {
  type: 'session_update' | 'session_created' | 'session_ended' | 'event' | 'sessions_list' | 'agent_status'
  sessionId?: string
  session?: SessionSummary
  sessions?: SessionSummary[]
  event?: HookEvent
  connected?: boolean
}

export interface SessionSummary {
  id: string
  cwd: string
  model?: string
  capabilities?: WrapperCapability[]
  version?: string
  buildTime?: string
  startedAt: number
  lastActivity: number
  status: Session['status']
  compacting?: boolean
  compactedAt?: number
  eventCount: number
  activeSubagentCount: number
  totalSubagentCount: number
  subagents: Array<{
    agentId: string
    agentType: string
    description?: string
    status: 'running' | 'stopped'
    startedAt: number
    stoppedAt?: number
    eventCount: number
  }>
  taskCount: number
  pendingTaskCount: number
  activeTasks: Array<{ id: string; subject: string }>
  pendingTasks: Array<{ id: string; subject: string }>
  runningBgTaskCount: number
  bgTasks: Array<{
    taskId: string
    command: string
    description: string
    startedAt: number
    completedAt?: number
    status: 'running' | 'completed' | 'killed'
  }>
  teammates: Array<{
    name: string
    status: TeammateInfo['status']
    currentTaskSubject?: string
    completedTaskCount: number
  }>
  team?: TeamInfo
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
  getSession: (id: string) => Session | undefined
  getAllSessions: () => Session[]
  getActiveSessions: () => Session[]
  addEvent: (sessionId: string, event: HookEvent) => void
  updateActivity: (sessionId: string) => void
  endSession: (sessionId: string, reason: string) => void
  removeSession: (sessionId: string) => void
  getSessionEvents: (sessionId: string, limit?: number, since?: number) => HookEvent[]
  updateTasks: (sessionId: string, tasks: TaskInfo[]) => void
  setSessionSocket: (sessionId: string, ws: ServerWebSocket<unknown>) => void
  getSessionSocket: (sessionId: string) => ServerWebSocket<unknown> | undefined
  removeSessionSocket: (sessionId: string) => void
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
  // Terminal viewer methods (multiple viewers per session)
  addTerminalViewer: (sessionId: string, ws: ServerWebSocket<unknown>) => void
  getTerminalViewers: (sessionId: string) => Set<ServerWebSocket<unknown>>
  removeTerminalViewer: (sessionId: string, ws: ServerWebSocket<unknown>) => void
  removeTerminalViewerBySocket: (ws: ServerWebSocket<unknown>) => void
  hasTerminalViewers: (sessionId: string) => boolean
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
  const sessionSockets = new Map<string, ServerWebSocket<unknown>>()
  const terminalViewers = new Map<string, Set<ServerWebSocket<unknown>>>()
  const dashboardSubscribers = new Set<ServerWebSocket<unknown>>()
  let agentSocket: ServerWebSocket<unknown> | undefined

  // Pending agent descriptions: PreToolUse(Agent) pushes, SubagentStart pops
  const pendingAgentDescriptions = new Map<string, string[]>()

  // Transcript cache: sessionId -> entries (ring buffer, max 500 per session)
  const MAX_TRANSCRIPT_ENTRIES = 500
  const transcriptCache = new Map<string, TranscriptEntry[]>()
  // Subagent transcript cache: `${sessionId}:${agentId}` -> entries
  const subagentTranscriptCache = new Map<string, TranscriptEntry[]>()

  // Helper to create session summary for broadcasting
  function toSessionSummary(session: Session): SessionSummary {
    return {
      id: session.id,
      cwd: session.cwd,
      model: session.model,
      capabilities: session.capabilities,
      version: session.version,
      buildTime: session.buildTime,
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

  // Load persisted state on startup
  if (enablePersistence) {
    loadStateSync()
  }

  // Periodically mark idle sessions, clean stale agents, and save state
  setInterval(() => {
    const now = Date.now()
    const STALE_AGENT_MS = 10 * 60 * 1000 // 10 minutes
    for (const session of sessions.values()) {
      let changed = false

      if (session.status === 'active' && now - session.lastActivity > IDLE_TIMEOUT_MS) {
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

      if (changed) {
        broadcast({
          type: 'session_update',
          sessionId: session.id,
          session: toSessionSummary(session),
        })
      }
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
        bgTasks: s.bgTasks,
        teammates: s.teammates,
        team: s.team,
        diagLog: [],
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
      status: 'active',
      events: [],
      subagents: [],
      tasks: [],
      bgTasks: [],
      diagLog: [],
      teammates: [],
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
      session.status = 'active'
      session.lastActivity = Date.now()
      // Reset subagents - restarted session won't have old agents
      session.subagents = []
    }
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
      session.lastActivity = Date.now()
      if (session.status === 'idle') {
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

      // Track compacting state
      if (event.hookEvent === 'PreCompact') {
        session.compacting = true
      } else if (session.compacting) {
        session.compacting = false
        session.compactedAt = Date.now()
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

      // Broadcast event to dashboard subscribers
      broadcast({
        type: 'event',
        sessionId,
        event,
      })

      // Also broadcast session update (for lastActivity, eventCount changes)
      broadcast({
        type: 'session_update',
        sessionId,
        session: toSessionSummary(session),
      })
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
    sessions.delete(sessionId)
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

  function setSessionSocket(sessionId: string, ws: ServerWebSocket<unknown>): void {
    sessionSockets.set(sessionId, ws)
  }

  function getSessionSocket(sessionId: string): ServerWebSocket<unknown> | undefined {
    return sessionSockets.get(sessionId)
  }

  function removeSessionSocket(sessionId: string): void {
    sessionSockets.delete(sessionId)
  }

  // Terminal viewer management (multiple viewers per session)
  function addTerminalViewer(sessionId: string, ws: ServerWebSocket<unknown>): void {
    let viewers = terminalViewers.get(sessionId)
    if (!viewers) {
      viewers = new Set()
      terminalViewers.set(sessionId, viewers)
    }
    viewers.add(ws)
  }

  function getTerminalViewers(sessionId: string): Set<ServerWebSocket<unknown>> {
    return terminalViewers.get(sessionId) || new Set()
  }

  function removeTerminalViewer(sessionId: string, ws: ServerWebSocket<unknown>): void {
    const viewers = terminalViewers.get(sessionId)
    if (viewers) {
      viewers.delete(ws)
      if (viewers.size === 0) terminalViewers.delete(sessionId)
    }
  }

  function removeTerminalViewerBySocket(ws: ServerWebSocket<unknown>): void {
    for (const [sessionId, viewers] of terminalViewers) {
      viewers.delete(ws)
      if (viewers.size === 0) terminalViewers.delete(sessionId)
    }
  }

  function hasTerminalViewers(sessionId: string): boolean {
    const viewers = terminalViewers.get(sessionId)
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

    session.tasks = tasks
    // Broadcast updated session summary
    broadcast({
      type: 'session_update',
      sessionId,
      session: toSessionSummary(session),
    })
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

    // Detect bg task completions from <task-notification> in user transcript entries
    const session = sessions.get(sessionId)
    if (session && session.bgTasks.some(t => t.status === 'running')) {
      for (const entry of entries) {
        if (entry.type !== 'user') continue
        const msg = entry.message as Record<string, unknown> | undefined
        const content = msg?.content
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
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
          }
        }
      }
      // Broadcast updated session if any bg tasks changed
      broadcast({ type: 'session_update', sessionId, session: toSessionSummary(session) })
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

  return {
    createSession,
    resumeSession,
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
    removeSessionSocket,
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
    saveState,
    clearState,
  }
}
