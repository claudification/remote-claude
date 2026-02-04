/**
 * REST API for Concentrator
 * Provides endpoints for querying session data
 */

import type { SessionStore } from "./session-store";
import type { Session, SendInput } from "../shared/protocol";
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

    // Get session transcript (tail)
    const transcriptMatch = path.match(/^\/sessions\/([^/]+)\/transcript$/);
    if (transcriptMatch && req.method === "GET") {
      const sessionId = transcriptMatch[1];
      const session = sessionStore.getSession(sessionId);

      if (!session) {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!session.transcriptPath) {
        return new Response(JSON.stringify({ error: "No transcript path available" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      try {
        const file = Bun.file(session.transcriptPath);
        if (!(await file.exists())) {
          return new Response(JSON.stringify({ error: "Transcript file not found" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const text = await file.text();
        const lines = text.trim().split("\n").filter(Boolean);

        // Parse JSONL - get last N entries
        const limit = parseInt(url.searchParams.get("limit") || "20", 10);
        const entries = lines.slice(-limit).map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        }).filter(Boolean);

        return new Response(JSON.stringify(entries, null, 2), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: `Failed to read transcript: ${error}` }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Send input to session
    const inputMatch = path.match(/^\/sessions\/([^/]+)\/input$/);
    if (inputMatch && req.method === "POST") {
      const sessionId = inputMatch[1];
      const session = sessionStore.getSession(sessionId);

      if (!session) {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (session.status === "ended") {
        return new Response(JSON.stringify({ error: "Session has ended" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const ws = sessionStore.getSessionSocket(sessionId);
      if (!ws) {
        return new Response(JSON.stringify({ error: "Session not connected" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      try {
        const body = await req.json() as { input: string };
        if (!body.input || typeof body.input !== "string") {
          return new Response(JSON.stringify({ error: "Missing input field" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const inputMsg: SendInput = {
          type: "input",
          sessionId,
          input: body.input,
        };
        ws.send(JSON.stringify(inputMsg));

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: `Failed to send input: ${error}` }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  };
}
