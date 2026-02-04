/**
 * Local HTTP Server
 * Receives hook callbacks from claude via curl POST
 */

import type { Server } from "bun";
import type { HookEvent, HookEventType, HookEventData } from "../shared/protocol";

type HttpServer = Server<unknown>;

export interface LocalServerOptions {
  sessionId: string;
  onHookEvent: (event: HookEvent) => void;
}

/**
 * Find an available port starting from the given port
 */
async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    try {
      const server = Bun.serve({
        port,
        fetch() {
          return new Response("test");
        },
      });
      server.stop();
      return port;
    } catch {
      // Port in use, try next
    }
  }
  throw new Error("No available port found");
}

/**
 * Create and start the local HTTP server for hook callbacks
 */
export async function startLocalServer(
  options: LocalServerOptions
): Promise<{ server: HttpServer; port: number }> {
  const { sessionId, onHookEvent } = options;

  const port = await findAvailablePort(19000 + Math.floor(Math.random() * 1000));

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // Health check endpoint
      if (url.pathname === "/health") {
        return new Response("ok", { status: 200 });
      }

      // Hook event endpoint: POST /hook/:eventType
      if (req.method === "POST" && url.pathname.startsWith("/hook/")) {
        const eventType = url.pathname.slice(6) as HookEventType; // Remove "/hook/"
        const reqSessionId = req.headers.get("X-Session-Id");

        // Validate session ID
        if (reqSessionId && reqSessionId !== sessionId) {
          return new Response("Session ID mismatch", { status: 403 });
        }

        try {
          const body = await req.text();
          let data: HookEventData;

          if (body.trim()) {
            data = JSON.parse(body) as HookEventData;
          } else {
            data = { session_id: sessionId };
          }

          const event: HookEvent = {
            type: "hook",
            sessionId,
            hookEvent: eventType,
            timestamp: Date.now(),
            data,
          };

          onHookEvent(event);

          return new Response("ok", { status: 200 });
        } catch (error) {
          console.error(`Error processing hook ${eventType}:`, error);
          return new Response("Error processing hook", { status: 500 });
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return { server, port };
}

/**
 * Stop the local server
 */
export function stopLocalServer(server: HttpServer): void {
  server.stop(true);
}
