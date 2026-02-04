/**
 * Session Store
 * In-memory session registry with event storage and optional persistence
 */

import type { ServerWebSocket } from "bun";
import type { Session, HookEvent } from "../shared/protocol";
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
  type: "session_update" | "session_created" | "session_ended" | "event" | "sessions_list";
  sessionId?: string;
  session?: SessionSummary;
  sessions?: SessionSummary[];
  event?: HookEvent;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  model?: string;
  startedAt: number;
  lastActivity: number;
  status: Session["status"];
  eventCount: number;
}

export interface SessionStore {
  createSession: (
    id: string,
    cwd: string,
    model?: string,
    args?: string[]
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
  setSessionSocket: (sessionId: string, ws: ServerWebSocket<unknown>) => void;
  getSessionSocket: (sessionId: string) => ServerWebSocket<unknown> | undefined;
  removeSessionSocket: (sessionId: string) => void;
  // Dashboard subscriber methods
  addSubscriber: (ws: ServerWebSocket<unknown>) => void;
  removeSubscriber: (ws: ServerWebSocket<unknown>) => void;
  getSubscriberCount: () => number;
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
  const dashboardSubscribers = new Set<ServerWebSocket<unknown>>();

  // Helper to create session summary for broadcasting
  function toSessionSummary(session: Session): SessionSummary {
    return {
      id: session.id,
      cwd: session.cwd,
      model: session.model,
      startedAt: session.startedAt,
      lastActivity: session.lastActivity,
      status: session.status,
      eventCount: session.events.length,
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

  // Periodically mark idle sessions and save state
  setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.status === "active" && now - session.lastActivity > IDLE_TIMEOUT_MS) {
        session.status = "idle";
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
        transcriptPath: s.transcriptPath,
        startedAt: s.startedAt,
        lastActivity: s.lastActivity,
        status: s.status,
        eventCount: s.events.length,
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
    args?: string[]
  ): Session {
    const session: Session = {
      id,
      cwd,
      model,
      args,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      status: "active",
      events: [],
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

  function getSubscriberCount(): number {
    return dashboardSubscribers.size;
  }

  return {
    createSession,
    resumeSession,
    getSession,
    getAllSessions,
    getActiveSessions,
    addEvent,
    updateActivity,
    endSession,
    removeSession,
    getSessionEvents,
    setSessionSocket,
    getSessionSocket,
    removeSessionSocket,
    addSubscriber,
    removeSubscriber,
    getSubscriberCount,
    saveState,
    clearState,
  };
}
