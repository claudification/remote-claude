/**
 * REST API for Concentrator
 * Provides endpoints for querying session data
 */

import type { SessionStore } from "./session-store";
import type { Session } from "../shared/protocol";
import { UI_HTML } from "./ui";

export interface ApiOptions {
  sessionStore: SessionStore;
}

interface SessionSummary {
  id: string;
  cwd: string;
  model?: string;
  status: Session["status"];
  startedAt: number;
  lastActivity: number;
  eventCount: number;
  lastEvent?: {
    hookEvent: string;
    timestamp: number;
  };
}

/**
 * Create API request handler
 */
export function createApiHandler(options: ApiOptions) {
  const { sessionStore } = options;

  function sessionToSummary(session: Session): SessionSummary {
    const lastEvent = session.events[session.events.length - 1];
    return {
      id: session.id,
      cwd: session.cwd,
      model: session.model,
      status: session.status,
      startedAt: session.startedAt,
      lastActivity: session.lastActivity,
      eventCount: session.events.length,
      lastEvent: lastEvent
        ? {
            hookEvent: lastEvent.hookEvent,
            timestamp: lastEvent.timestamp,
          }
        : undefined,
    };
  }

  return async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Serve UI at root
    if ((path === "/" || path === "/ui") && req.method === "GET") {
      return new Response(UI_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Health check
    if (path === "/health") {
      return new Response("ok", {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "text/plain" },
      });
    }

    // List all sessions
    if (path === "/sessions" && req.method === "GET") {
      const activeOnly = url.searchParams.get("active") === "true";
      const sessions = activeOnly
        ? sessionStore.getActiveSessions()
        : sessionStore.getAllSessions();

      const summaries = sessions.map(sessionToSummary);

      return new Response(JSON.stringify(summaries, null, 2), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get session by ID
    const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      const sessionId = sessionMatch[1];
      const session = sessionStore.getSession(sessionId);

      if (!session) {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify(sessionToSummary(session), null, 2), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get session events
    const eventsMatch = path.match(/^\/sessions\/([^/]+)\/events$/);
    if (eventsMatch && req.method === "GET") {
      const sessionId = eventsMatch[1];
      const limit = parseInt(url.searchParams.get("limit") || "0", 10);
      const events = sessionStore.getSessionEvents(sessionId, limit || undefined);

      if (events.length === 0 && !sessionStore.getSession(sessionId)) {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify(events, null, 2), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  };
}
