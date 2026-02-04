#!/usr/bin/env bun
/**
 * Claude Code Session Concentrator
 * Aggregates sessions from multiple rclaude instances
 */

import { createSessionStore } from "./session-store";
import { createWsServer } from "./ws-server";
import { createApiHandler } from "./api";
import { DEFAULT_CONCENTRATOR_PORT } from "../shared/protocol";

interface Args {
  port: number;
  apiPort?: number;
  verbose: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let port = DEFAULT_CONCENTRATOR_PORT;
  let apiPort: number | undefined;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--port" || arg === "-p") {
      port = parseInt(args[++i], 10);
    } else if (arg === "--api-port") {
      apiPort = parseInt(args[++i], 10);
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return { port, apiPort, verbose };
}

function printHelp() {
  console.log(`
concentrator - Claude Code Session Aggregator

Receives session events from rclaude instances and provides a unified view.

USAGE:
  concentrator [OPTIONS]

OPTIONS:
  -p, --port <port>      WebSocket port (default: ${DEFAULT_CONCENTRATOR_PORT})
  --api-port <port>      REST API port (default: same as WebSocket)
  -v, --verbose          Enable verbose logging
  -h, --help             Show this help message

ENDPOINTS:
  WebSocket:
    ws://localhost:${DEFAULT_CONCENTRATOR_PORT}/      Connect session

  REST API:
    GET /sessions                List all sessions
    GET /sessions?active=true    List active sessions only
    GET /sessions/:id            Get session details
    GET /sessions/:id/events     Get session events
    GET /health                  Health check

EXAMPLES:
  concentrator                   # Start on default port
  concentrator -p 8080           # Start on port 8080
  concentrator -v                # Start with verbose logging
`);
}

function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function main() {
  const { port, apiPort, verbose } = parseArgs();

  const sessionStore = createSessionStore();

  // Create WebSocket server
  const wsServer = createWsServer({
    port,
    sessionStore,
    onSessionStart(sessionId, meta) {
      if (verbose) {
        console.log(
          `[+] Session started: ${sessionId.slice(0, 8)}... (${meta.cwd})`
        );
      }
    },
    onSessionEnd(sessionId, reason) {
      if (verbose) {
        console.log(`[-] Session ended: ${sessionId.slice(0, 8)}... (${reason})`);
      }
    },
    onHookEvent(sessionId, event) {
      if (verbose) {
        const toolName =
          "tool_name" in event.data ? (event.data.tool_name as string) : "";
        const suffix = toolName ? ` (${toolName})` : "";
        console.log(
          `[*] ${sessionId.slice(0, 8)}... ${event.hookEvent}${suffix}`
        );
      }
    },
  });

  // Create REST API server (on same or different port)
  const apiHandler = createApiHandler({ sessionStore });

  if (apiPort && apiPort !== port) {
    // Separate API server
    Bun.serve({
      port: apiPort,
      fetch: apiHandler,
    });
    console.log(`REST API listening on http://localhost:${apiPort}`);
  } else {
    // Combine API with WebSocket server - need to create new combined server
    wsServer.stop();

    interface WsData {
      sessionId?: string;
    }

    Bun.serve<WsData>({
      port,
      fetch(req, server) {
        const url = new URL(req.url);

        // WebSocket upgrade for /ws or /
        if (
          req.headers.get("upgrade")?.toLowerCase() === "websocket" &&
          (url.pathname === "/" || url.pathname === "/ws")
        ) {
          const success = server.upgrade(req, {
            data: {} as WsData,
          });
          if (success) {
            return undefined;
          }
          return new Response("WebSocket upgrade failed", { status: 500 });
        }

        // REST API for other routes
        return apiHandler(req);
      },
      websocket: {
        open(_ws) {
          // Connection established
        },
        message(ws, message) {
          try {
            const data = JSON.parse(message.toString());

            switch (data.type) {
              case "meta": {
                ws.data.sessionId = data.sessionId;
                sessionStore.createSession(
                  data.sessionId,
                  data.cwd,
                  data.model,
                  data.args
                );
                if (verbose) {
                  console.log(
                    `[+] Session started: ${data.sessionId.slice(0, 8)}... (${data.cwd})`
                  );
                }
                ws.send(JSON.stringify({ type: "ack", eventId: data.sessionId }));
                break;
              }
              case "hook": {
                const sessionId = ws.data.sessionId || data.sessionId;
                if (sessionId) {
                  sessionStore.addEvent(sessionId, data);
                  if (verbose) {
                    const toolName = data.data?.tool_name || "";
                    const suffix = toolName ? ` (${toolName})` : "";
                    console.log(
                      `[*] ${sessionId.slice(0, 8)}... ${data.hookEvent}${suffix}`
                    );
                  }
                }
                break;
              }
              case "heartbeat": {
                const sessionId = ws.data.sessionId || data.sessionId;
                if (sessionId) {
                  sessionStore.updateActivity(sessionId);
                }
                break;
              }
              case "end": {
                const sessionId = ws.data.sessionId || data.sessionId;
                if (sessionId) {
                  sessionStore.endSession(sessionId, data.reason);
                  if (verbose) {
                    console.log(
                      `[-] Session ended: ${sessionId.slice(0, 8)}... (${data.reason})`
                    );
                  }
                }
                break;
              }
            }
          } catch (error) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: `Failed to process message: ${error}`,
              })
            );
          }
        },
        close(ws) {
          const sessionId = ws.data.sessionId;
          if (sessionId) {
            const session = sessionStore.getSession(sessionId);
            if (session && session.status !== "ended") {
              sessionStore.endSession(sessionId, "connection_closed");
              if (verbose) {
                console.log(
                  `[-] Session ended: ${sessionId.slice(0, 8)}... (connection_closed)`
                );
              }
            }
          }
        },
      },
    });
  }

  console.log(`
┌─────────────────────────────────────────────────────────────────────────────┐
│  CLAUDE CONCENTRATOR                                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  WebSocket:  ws://localhost:${String(port).padEnd(5)}                                          │
│  REST API:   http://localhost:${String(apiPort || port).padEnd(5)}                                        │
│  Verbose:    ${verbose ? "ON " : "OFF"}                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
`);

  // Print status periodically
  if (verbose) {
    setInterval(() => {
      const sessions = sessionStore.getActiveSessions();
      if (sessions.length > 0) {
        console.log(`\n[i] Active sessions: ${sessions.length}`);
        for (const session of sessions) {
          const age = formatTime(Date.now() - session.startedAt);
          const idle = formatTime(Date.now() - session.lastActivity);
          console.log(
            `    ${session.id.slice(0, 8)}... [${session.status.toUpperCase()}] age=${age} idle=${idle} events=${session.events.length}`
          );
        }
      }
    }, 60000);
  }
}

main();
