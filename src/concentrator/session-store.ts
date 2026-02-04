/**
 * Session Store
 * In-memory session registry with event storage
 */

import type { Session, HookEvent } from "../shared/protocol";
import { IDLE_TIMEOUT_MS } from "../shared/protocol";

export interface SessionStore {
  createSession: (
    id: string,
    cwd: string,
    model?: string,
    args?: string[]
  ) => Session;
  getSession: (id: string) => Session | undefined;
  getAllSessions: () => Session[];
  getActiveSessions: () => Session[];
  addEvent: (sessionId: string, event: HookEvent) => void;
  updateActivity: (sessionId: string) => void;
  endSession: (sessionId: string, reason: string) => void;
  removeSession: (sessionId: string) => void;
  getSessionEvents: (sessionId: string, limit?: number) => HookEvent[];
}

/**
 * Create an in-memory session store
 */
export function createSessionStore(): SessionStore {
  const sessions = new Map<string, Session>();

  // Periodically mark idle sessions
  setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.status === "active" && now - session.lastActivity > IDLE_TIMEOUT_MS) {
        session.status = "idle";
      }
    }
  }, 10000);

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
    return session;
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
    }
  }

  function removeSession(sessionId: string): void {
    sessions.delete(sessionId);
  }

  function getSessionEvents(sessionId: string, limit?: number): HookEvent[] {
    const session = sessions.get(sessionId);
    if (!session) return [];

    if (limit) {
      return session.events.slice(-limit);
    }
    return session.events;
  }

  return {
    createSession,
    getSession,
    getAllSessions,
    getActiveSessions,
    addEvent,
    updateActivity,
    endSession,
    removeSession,
    getSessionEvents,
  };
}
