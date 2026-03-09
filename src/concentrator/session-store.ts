/**
 * Session Store
 * In-memory session registry with event storage and optional persistence
 */

import type { ServerWebSocket } from "bun";
import type { Session, HookEvent, TaskInfo, TeamInfo, TeammateInfo, WrapperCapability } from "../shared/protocol";
import { IDLE_TIMEOUT_MS } from "../shared/protocol";
import { existsSync, mkdirSync, unlinkSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "concentrator");
const CACHE_FILENAME = "sessions.json";

export interface SessionStoreOptions {
  cacheDir?: string;
  enablePersistence?: boolean;
}

// Message types for dashboard subscribers
export interface DashboardMessage {
  type: "session_update" | "session_created" | "session_ended" | "event" | "sessions_list" | "agent_status";
  sessionId?: string;
  session?: SessionSummary;
  sessions?: SessionSummary[];
  event?: HookEvent;
  connected?: boolean;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  model?: string;
  capabilities?: WrapperCapability[];
  startedAt: number;
  lastActivity: number;
  status: Session["status"];
  eventCount: number;
  activeSubagentCount: number;
  totalSubagentCount: number;
  taskCount: number;
  pendingTaskCount: number;
  activeTasks: Array<{ id: string; subject: string }>;
  runningBgTaskCount: number;
  bgTasks: Array<{ taskId: string; command: string; description: string; startedAt: number; completedAt?: number; status: "running" | "completed" | "killed" }>;
  teammates: Array<{ name: string; status: TeammateInfo["status"]; currentTaskSubject?: string; completedTaskCount: number }>;
  team?: TeamInfo;
}

export interface SessionStore {
  createSession: (
    id: string,
    cwd: string,
    model?: string,
    args?: string[],
    capabilities?: WrapperCapability[]
  ) => Session;
  resumeSession: (id: string) => void;
  getSession: (id: string) => Session | undefined;
  getAllSessions: () => Session[];
  getActiveSessions: () => Session[];
  addEvent: (sessionId: string, event: HookEvent) => void;
  updateActivity: (sessionId: string) => void;
  endSession: (sessionId: string, reason: string) => void;
  removeSession: (sessionId: string) => void;
  getSessionEvents: (sessionId: string, limit?: number, since?: number) => HookEvent[];
  updateTasks: (sessionId: string, tasks: TaskInfo[]) => void;
  setSessionSocket: (sessionId: string, ws: ServerWebSocket<unknown>) => void;
  getSessionSocket: (sessionId: string) => ServerWebSocket<unknown> | undefined;
  removeSessionSocket: (sessionId: string) => void;
  // Terminal viewer methods
  setTerminalViewer: (sessionId: string, ws: ServerWebSocket<unknown>) => void;
  getTerminalViewer: (sessionId: string) => ServerWebSocket<unknown> | undefined;
  clearTerminalViewer: (sessionId: string) => void;
  clearTerminalViewerBySocket: (ws: ServerWebSocket<unknown>) => void;
  // Dashboard subscriber methods
  addSubscriber: (ws: ServerWebSocket<unknown>) => void;
  removeSubscriber: (ws: ServerWebSocket<unknown>) => void;
  getSubscriberCount: () => number;
  // Agent methods (exclusive single agent connection)
  setAgent: (ws: ServerWebSocket<unknown>) => boolean;
  getAgent: () => ServerWebSocket<unknown> | undefined;
  removeAgent: (ws: ServerWebSocket<unknown>) => void;
  hasAgent: () => boolean;
  saveState: () => Promise<void>;
  clearState: () => Promise<void>;
}

interface PersistedState {
  version: number;
  savedAt: number;
  sessions: Array<Omit<Session, "events"> & { eventCount: number }>;
}

/**
 * Create a session store with optional persistence
 */
export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  const { cacheDir = DEFAULT_CACHE_DIR, enablePersistence = true } = options;
  const cachePath = join(cacheDir, CACHE_FILENAME);

  const sessions = new Map<string, Session>();
  const sessionSockets = new Map<string, ServerWebSocket<unknown>>();
  const terminalViewers = new Map<string, ServerWebSocket<unknown>>();
  const dashboardSubscribers = new Set<ServerWebSocket<unknown>>();
  let agentSocket: ServerWebSocket<unknown> | undefined;

  // Helper to create session summary for broadcasting
  function toSessionSummary(session: Session): SessionSummary {
    return {
      id: session.id,
      cwd: session.cwd,
      model: session.model,
      capabilities: session.capabilities,
      startedAt: session.startedAt,
      lastActivity: session.lastActivity,
      status: session.status,
      eventCount: session.events.length,
      activeSubagentCount: session.subagents.filter(a => a.status === "running").length,
      totalSubagentCount: session.subagents.length,
      taskCount: session.tasks.length,
      pendingTaskCount: session.tasks.filter(t => t.status === "pending" || t.status === "in_progress").length,
      activeTasks: session.tasks
        .filter(t => t.status === "in_progress")
        .map(t => ({ id: t.id, subject: t.subject })),
      runningBgTaskCount: session.bgTasks.filter(t => t.status === "running").length,
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
    };
  }

  // Broadcast message to all dashboard subscribers
  function broadcast(message: DashboardMessage): void {
    const json = JSON.stringify(message);
    for (const ws of dashboardSubscribers) {
      try {
        ws.send(json);
      } catch {
        // Remove dead connections
        dashboardSubscribers.delete(ws);
      }
    }
  }

  // Load persisted state on startup
  if (enablePersistence) {
    loadStateSync();
  }

  // Periodically mark idle sessions, clean stale agents, and save state
  setInterval(() => {
    const now = Date.now();
    const STALE_AGENT_MS = 10 * 60 * 1000; // 10 minutes
    for (const session of sessions.values()) {
      let changed = false;

      if (session.status === "active" && now - session.lastActivity > IDLE_TIMEOUT_MS) {
        session.status = "idle";
        changed = true;
      }

      // Clean up stale "running" agents (SubagentStop may have been missed)
      for (const agent of session.subagents) {
        if (agent.status === "running" && now - agent.startedAt > STALE_AGENT_MS && now - session.lastActivity > STALE_AGENT_MS) {
          agent.status = "stopped";
          agent.stoppedAt = now;
          changed = true;
        }
      }

      if (changed) {
        broadcast({
          type: "session_update",
          sessionId: session.id,
          session: toSessionSummary(session),
        });
      }
    }
  }, 10000);

  // Auto-save state periodically (every 30 seconds)
  if (enablePersistence) {
    setInterval(() => {
      saveState().catch(() => {});
    }, 30000);
  }

  function loadStateSync(): void {
    try {
      if (!existsSync(cachePath)) return;

      const text = readFileSync(cachePath, "utf-8");
      const state = JSON.parse(text) as PersistedState;

      if (state.version !== 1) return;

      // Restore sessions (without events, mark as ended since we don't know their state)
      for (const sessionData of state.sessions) {
        const session: Session = {
          ...sessionData,
          events: [],
          subagents: ((sessionData as any).subagents || []).map((a: any) => ({ ...a, events: a.events || [] })),
          tasks: (sessionData as any).tasks || [],
          bgTasks: (sessionData as any).bgTasks || [],
          teammates: (sessionData as any).teammates || [],
          team: (sessionData as any).team,
          // Mark restored sessions as ended unless they reconnect
          status: "ended",
        };
        sessions.set(session.id, session);
      }

      console.log(`[cache] Loaded ${state.sessions.length} sessions from cache`);
    } catch {
      // Ignore load errors
    }
  }

  async function saveState(): Promise<void> {
    if (!enablePersistence) return;

    try {
      // Ensure cache directory exists
      if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true });
      }

      // Persist sessions without events (to keep file size small)
      const sessionsToSave = Array.from(sessions.values()).map((s) => ({
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
      }));

      const state: PersistedState = {
        version: 1,
        savedAt: Date.now(),
        sessions: sessionsToSave,
      };

      await Bun.write(cachePath, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error(`[cache] Failed to save state: ${error}`);
    }
  }

  async function clearState(): Promise<void> {
    try {
      if (existsSync(cachePath)) {
        unlinkSync(cachePath);
        console.log(`[cache] Cleared cache at ${cachePath}`);
      }
      sessions.clear();
    } catch (error) {
      console.error(`[cache] Failed to clear state: ${error}`);
    }
  }

  function createSession(
    id: string,
    cwd: string,
    model?: string,
    args?: string[],
    capabilities?: WrapperCapability[]
  ): Session {
    const session: Session = {
      id,
      cwd,
      model,
      args,
      capabilities,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      status: "active",
      events: [],
      subagents: [],
      tasks: [],
      bgTasks: [],
      teammates: [],
    };
    sessions.set(id, session);

    // Broadcast to dashboard subscribers
    broadcast({
      type: "session_created",
      sessionId: id,
      session: toSessionSummary(session),
    });

    return session;
  }

  function resumeSession(id: string): void {
    const session = sessions.get(id);
    if (session) {
      session.status = "active";
      session.lastActivity = Date.now();
      // Reset subagents - restarted session won't have old agents
      session.subagents = [];
    }
  }

  function getSession(id: string): Session | undefined {
    return sessions.get(id);
  }

  function getAllSessions(): Session[] {
    return Array.from(sessions.values());
  }

  function getActiveSessions(): Session[] {
    return Array.from(sessions.values()).filter(
      (s) => s.status === "active" || s.status === "idle"
    );
  }

  function addEvent(sessionId: string, event: HookEvent): void {
    const session = sessions.get(sessionId);
    if (session) {
      session.events.push(event);
      session.lastActivity = Date.now();
      if (session.status === "idle") {
        session.status = "active";
      }

      // Correlate hook events to subagents: if the hook's session_id differs
      // from the parent session ID, it came from a subagent context
      const hookSessionId = (event.data as Record<string, unknown>)?.session_id;
      if (typeof hookSessionId === "string" && hookSessionId !== session.id) {
        const subagent = session.subagents.find(
          a => a.agentId === hookSessionId && a.status === "running"
        );
        if (subagent) {
          subagent.events.push(event);
        }
      }

      // Extract transcript_path and model from SessionStart events
      if (event.hookEvent === "SessionStart" && event.data) {
        const data = event.data as Record<string, unknown>;
        if (data.transcript_path && typeof data.transcript_path === "string") {
          session.transcriptPath = data.transcript_path;
        }
        if (data.model && typeof data.model === "string" && !session.model) {
          session.model = data.model;
        }
      }

      // Track sub-agent lifecycle
      if (event.hookEvent === "SubagentStart" && event.data) {
        const data = event.data as Record<string, unknown>;
        const agentId = String(data.agent_id || "");
        if (agentId) {
          session.subagents.push({
            agentId,
            agentType: String(data.agent_type || "unknown"),
            startedAt: event.timestamp,
            status: "running",
            events: [],
          });
        }
      }

      if (event.hookEvent === "SubagentStop" && event.data) {
        const data = event.data as Record<string, unknown>;
        const agentId = String(data.agent_id || "");
        const agent = session.subagents.find(a => a.agentId === agentId);
        if (agent) {
          agent.stoppedAt = event.timestamp;
          agent.status = "stopped";
          if (data.agent_transcript_path && typeof data.agent_transcript_path === "string") {
            agent.transcriptPath = data.agent_transcript_path;
          }
        }
      }

      // Track background Bash commands
      if (event.hookEvent === "PostToolUse" && event.data) {
        const data = event.data as Record<string, unknown>;
        const toolName = data.tool_name as string;
        const input = (data.tool_input || {}) as Record<string, unknown>;
        const responseObj = data.tool_response;
        // tool_response can be a string OR an object - normalize to string for pattern matching
        const response = typeof responseObj === "object" && responseObj !== null
          ? JSON.stringify(responseObj)
          : String(responseObj || "");

        if (toolName === "Bash") {
          // Detect background commands - tool_response is an object with backgroundTaskId
          const bgTaskId = typeof responseObj === "object" && responseObj !== null
            ? (responseObj as Record<string, unknown>).backgroundTaskId as string | undefined
            : undefined;
          // Fallback: match "with ID: xxx" in string response (user Ctrl+B backgrounded)
          const idMatch = !bgTaskId ? response.match(/with ID: (\S+)/) : null;
          const taskId = bgTaskId || idMatch?.[1];

          if (taskId) {
            session.bgTasks.push({
              taskId,
              command: String(input.command || "").slice(0, 100),
              description: String(input.description || ""),
              startedAt: event.timestamp,
              status: "running",
            });
          }
        }

        // Detect TaskOutput/TaskStop to mark bg tasks as completed
        if (toolName === "TaskOutput" || toolName === "TaskStop") {
          const taskId = String(input.task_id || input.taskId || "");
          const bgTask = session.bgTasks.find(t => t.taskId === taskId);
          if (bgTask && bgTask.status === "running") {
            bgTask.completedAt = event.timestamp;
            bgTask.status = toolName === "TaskStop" ? "killed" : "completed";
          }
        }
      }

      // Detect team membership from TeammateIdle events
      if (event.hookEvent === "TeammateIdle" && event.data) {
        const data = event.data as Record<string, unknown>;
        const teamName = String(data.team_name || "");
        const agentId = String(data.agent_id || "");
        const agentName = String(data.agent_name || agentId.slice(0, 8));

        if (teamName && !session.team) {
          session.team = { teamName, role: "lead" };
        }

        if (agentId) {
          let teammate = session.teammates.find(t => t.agentId === agentId);
          if (!teammate) {
            teammate = {
              agentId,
              name: agentName,
              teamName,
              status: "idle",
              startedAt: event.timestamp,
              completedTaskCount: 0,
            };
            session.teammates.push(teammate);
          }
          teammate.status = "idle";
          teammate.currentTaskId = undefined;
          teammate.currentTaskSubject = undefined;
        }
      }

      // Track teammate work from SubagentStart (teammates are agents)
      if (event.hookEvent === "SubagentStart" && event.data) {
        const data = event.data as Record<string, unknown>;
        const agentId = String(data.agent_id || "");
        const teammate = session.teammates.find(t => t.agentId === agentId);
        if (teammate) {
          teammate.status = "working";
        }
      }

      // Track teammate stop
      if (event.hookEvent === "SubagentStop" && event.data) {
        const data = event.data as Record<string, unknown>;
        const agentId = String(data.agent_id || "");
        const teammate = session.teammates.find(t => t.agentId === agentId);
        if (teammate) {
          teammate.status = "stopped";
          teammate.stoppedAt = event.timestamp;
        }
      }

      // Track task completion by teammates
      if (event.hookEvent === "TaskCompleted" && event.data) {
        const data = event.data as Record<string, unknown>;
        const owner = String(data.owner || "");
        const teamName = String(data.team_name || "");

        if (teamName && !session.team) {
          session.team = { teamName, role: "lead" };
        }

        // Find teammate by name match (owner is the agent name)
        const teammate = session.teammates.find(t => t.name === owner);
        if (teammate) {
          teammate.completedTaskCount++;
          teammate.currentTaskId = undefined;
          teammate.currentTaskSubject = undefined;
          // Back to idle after completing
          teammate.status = "idle";
        }
      }

      // Broadcast event to dashboard subscribers
      broadcast({
        type: "event",
        sessionId,
        event,
      });

      // Also broadcast session update (for lastActivity, eventCount changes)
      broadcast({
        type: "session_update",
        sessionId,
        session: toSessionSummary(session),
      });
    }
  }

  function updateActivity(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
      if (session.status === "idle") {
        session.status = "active";
      }
    }
  }

  function endSession(sessionId: string, _reason: string): void {
    const session = sessions.get(sessionId);
    if (session) {
      session.status = "ended";

      // Mark all running subagents as stopped (SubagentStop hook may not fire)
      for (const agent of session.subagents) {
        if (agent.status === "running") {
          agent.status = "stopped";
          agent.stoppedAt = Date.now();
        }
      }

      // Mark all teammates as stopped
      for (const teammate of session.teammates) {
        if (teammate.status !== "stopped") {
          teammate.status = "stopped";
          teammate.stoppedAt = Date.now();
        }
      }

      // Mark all running bg tasks as killed
      for (const bgTask of session.bgTasks) {
        if (bgTask.status === "running") {
          bgTask.status = "killed";
          bgTask.completedAt = Date.now();
        }
      }

      // Broadcast to dashboard subscribers
      broadcast({
        type: "session_ended",
        sessionId,
        session: toSessionSummary(session),
      });
    }
  }

  function removeSession(sessionId: string): void {
    sessions.delete(sessionId);
  }

  function getSessionEvents(sessionId: string, limit?: number, since?: number): HookEvent[] {
    const session = sessions.get(sessionId);
    if (!session) return [];

    let events = session.events;

    // Filter by timestamp if since is provided
    if (since) {
      events = events.filter(e => e.timestamp > since);
    }

    // Apply limit (from the end)
    if (limit && events.length > limit) {
      return events.slice(-limit);
    }
    return events;
  }

  function setSessionSocket(sessionId: string, ws: ServerWebSocket<unknown>): void {
    sessionSockets.set(sessionId, ws);
  }

  function getSessionSocket(sessionId: string): ServerWebSocket<unknown> | undefined {
    return sessionSockets.get(sessionId);
  }

  function removeSessionSocket(sessionId: string): void {
    sessionSockets.delete(sessionId);
  }

  // Terminal viewer management
  function setTerminalViewer(sessionId: string, ws: ServerWebSocket<unknown>): void {
    terminalViewers.set(sessionId, ws);
  }

  function getTerminalViewer(sessionId: string): ServerWebSocket<unknown> | undefined {
    return terminalViewers.get(sessionId);
  }

  function clearTerminalViewer(sessionId: string): void {
    terminalViewers.delete(sessionId);
  }

  function clearTerminalViewerBySocket(ws: ServerWebSocket<unknown>): void {
    for (const [sessionId, viewer] of terminalViewers) {
      if (viewer === ws) {
        terminalViewers.delete(sessionId);
      }
    }
  }

  // Dashboard subscriber management
  function addSubscriber(ws: ServerWebSocket<unknown>): void {
    dashboardSubscribers.add(ws);

    // Send current sessions list immediately upon subscription
    const sessionsList = Array.from(sessions.values()).map(toSessionSummary);
    try {
      ws.send(JSON.stringify({
        type: "sessions_list",
        sessions: sessionsList,
      }));
    } catch {
      dashboardSubscribers.delete(ws);
    }
  }

  function removeSubscriber(ws: ServerWebSocket<unknown>): void {
    dashboardSubscribers.delete(ws);
  }

  function updateTasks(sessionId: string, tasks: TaskInfo[]): void {
    const session = sessions.get(sessionId);
    if (!session) return;

    session.tasks = tasks;
    // Broadcast updated session summary
    broadcast({
      type: "session_update",
      sessionId,
      session: toSessionSummary(session),
    });
  }

  function getSubscriberCount(): number {
    return dashboardSubscribers.size;
  }

  // Agent management (exclusive single connection)
  function setAgent(ws: ServerWebSocket<unknown>): boolean {
    if (agentSocket) return false; // reject - already connected
    agentSocket = ws;
    broadcast({ type: "agent_status", connected: true });
    return true;
  }

  function getAgent(): ServerWebSocket<unknown> | undefined {
    return agentSocket;
  }

  function removeAgent(ws: ServerWebSocket<unknown>): void {
    if (agentSocket === ws) {
      agentSocket = undefined;
      broadcast({ type: "agent_status", connected: false });
    }
  }

  function hasAgent(): boolean {
    return !!agentSocket;
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
    setTerminalViewer,
    getTerminalViewer,
    clearTerminalViewer,
    clearTerminalViewerBySocket,
    addSubscriber,
    removeSubscriber,
    getSubscriberCount,
    setAgent,
    getAgent,
    removeAgent,
    hasAgent,
    saveState,
    clearState,
  };
}
