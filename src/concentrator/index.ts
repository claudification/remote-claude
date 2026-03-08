#!/usr/bin/env bun
/**
 * Claude Code Session Concentrator
 * Aggregates sessions from multiple rclaude instances
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { createSessionStore } from "./session-store";
import { createWsServer } from "./ws-server";
import { createApiHandler } from "./api";
import { DEFAULT_CONCENTRATOR_PORT } from "../shared/protocol";
import { addAllowedRoot, addPathMapping, getAllowedRoots } from "./path-jail";
import { initAuth, reloadState } from "./auth";
import { requireAuth, handleAuthRoute, setRclaudeSecret } from "./auth-routes";

interface Args {
  port: number;
  apiPort?: number;
  verbose: boolean;
  cacheDir?: string;
  clearCache: boolean;
  noPersistence: boolean;
  webDir?: string;
  allowedRoots: string[];
  pathMaps: Array<{ from: string; to: string }>;
  rpId?: string;
  origins: string[];
  rclaudeSecret?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let port = DEFAULT_CONCENTRATOR_PORT;
  let apiPort: number | undefined;
  let verbose = false;
  let cacheDir: string | undefined;
  let clearCache = false;
  let noPersistence = false;
  let webDir: string | undefined;
  const allowedRoots: string[] = [];
  const pathMaps: Array<{ from: string; to: string }> = [];
  let rpId: string | undefined;
  const origins: string[] = [];
  let rclaudeSecret: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--port" || arg === "-p") {
      port = parseInt(args[++i], 10);
    } else if (arg === "--api-port") {
      apiPort = parseInt(args[++i], 10);
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--cache-dir") {
      cacheDir = args[++i];
    } else if (arg === "--clear-cache") {
      clearCache = true;
    } else if (arg === "--no-persistence") {
      noPersistence = true;
    } else if (arg === "--web-dir" || arg === "-w") {
      webDir = args[++i];
    } else if (arg === "--allow-root") {
      allowedRoots.push(args[++i]);
    } else if (arg === "--rp-id") {
      rpId = args[++i];
    } else if (arg === "--origin") {
      origins.push(args[++i]);
    } else if (arg === "--rclaude-secret") {
      rclaudeSecret = args[++i];
    } else if (arg === "--path-map") {
      const mapping = args[++i];
      const sep = mapping.indexOf(":");
      if (sep > 0) {
        pathMaps.push({ from: mapping.slice(0, sep), to: mapping.slice(sep + 1) });
      }
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  // Env fallback for secret
  if (!rclaudeSecret) rclaudeSecret = process.env.RCLAUDE_SECRET;

  return { port, apiPort, verbose, cacheDir, clearCache, noPersistence, webDir, allowedRoots, pathMaps, rpId, origins, rclaudeSecret };
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
  -w, --web-dir <dir>    Serve web dashboard from directory
  --cache-dir <dir>      Session cache directory (default: ~/.cache/concentrator)
  --clear-cache          Clear session cache and exit
  --no-persistence       Disable session persistence
  --allow-root <dir>     Add allowed filesystem root (repeatable)
  --rp-id <domain>       WebAuthn relying party ID (default: localhost)
  --origin <url>         Allowed WebAuthn origin (repeatable, default: http://localhost:PORT)
  --rclaude-secret <s>   Shared secret for rclaude WebSocket auth (or RCLAUDE_SECRET env)
  -h, --help             Show this help message

ENDPOINTS:
  WebSocket:
    ws://localhost:${DEFAULT_CONCENTRATOR_PORT}/      Connect session

  REST API:
    GET  /sessions                List all sessions
    GET  /sessions?active=true    List active sessions only
    GET  /sessions/:id            Get session details
    GET  /sessions/:id/events     Get session events
    POST /sessions/:id/input      Send input to session
    GET  /health                  Health check

EXAMPLES:
  concentrator                   # Start on default port
  concentrator -p 8080           # Start on port 8080
  concentrator -v                # Start with verbose logging
  concentrator --clear-cache     # Clear cached sessions
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

async function main() {
  const { port, apiPort, verbose, cacheDir, clearCache, noPersistence, webDir, allowedRoots: extraRoots, pathMaps, rpId, origins, rclaudeSecret } = parseArgs();

  // rclaude secret is required - no open WebSocket ingest
  if (!rclaudeSecret) {
    console.error("ERROR: --rclaude-secret or RCLAUDE_SECRET is required");
    process.exit(1);
  }
  setRclaudeSecret(rclaudeSecret);

  // Configure path jail - register allowed filesystem roots
  // Auto-detect ~/.claude for transcript access
  const homeDir = process.env.HOME || process.env.USERPROFILE || "/root";
  const claudeDir = `${homeDir}/.claude`;
  addAllowedRoot(claudeDir);

  // Add web dir if specified
  if (webDir) addAllowedRoot(webDir);

  // Add any extra roots from --allow-root flags
  for (const root of extraRoots) {
    addAllowedRoot(root);
  }

  // Register path mappings (host path -> container path)
  for (const { from, to } of pathMaps) {
    addPathMapping(from, to);
  }

  if (verbose) {
    console.log(`[jail] Allowed roots: ${getAllowedRoots().join(", ")}`);
    if (pathMaps.length > 0) {
      console.log(`[jail] Path mappings: ${pathMaps.map(m => `${m.from} -> ${m.to}`).join(", ")}`);
    }
  }

  // Initialize passkey auth
  const authCacheDir = cacheDir || `${homeDir}/.cache/concentrator`;
  const defaultOrigins = [`http://localhost:${port}`];
  initAuth({
    cacheDir: authCacheDir,
    rpId: rpId || "localhost",
    expectedOrigins: origins.length > 0 ? origins : defaultOrigins,
  });

  const sessionStore = createSessionStore({
    cacheDir,
    enablePersistence: !noPersistence,
  });

  // Handle --clear-cache
  if (clearCache) {
    await sessionStore.clearState();
    console.log("Cache cleared.");
    process.exit(0);
  }

  // Save state on shutdown
  process.on("SIGINT", async () => {
    console.log("\n[shutdown] Saving state...");
    await sessionStore.saveState();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await sessionStore.saveState();
    process.exit(0);
  });
  process.on("SIGHUP", () => {
    reloadState();
    console.log("[auth] Reloaded auth state from disk (SIGHUP)");
  });

  // Write PID file so CLI can send signals
  if (cacheDir) {
    const pidFile = join(cacheDir, "concentrator.pid");
    writeFileSync(pidFile, String(process.pid));
  }

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
  const apiHandler = createApiHandler({ sessionStore, webDir });

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
      isDashboard?: boolean;
      isAgent?: boolean;
    }

    Bun.serve<WsData>({
      port,
      async fetch(req, server) {
        // Auth routes first (login, register, status)
        const authResponse = await handleAuthRoute(req);
        if (authResponse) return authResponse;

        // Auth middleware (blocks unauthenticated access when users exist)
        const authBlock = requireAuth(req);
        if (authBlock) return authBlock;

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

                // Check if session exists (resume case)
                const existingSession = sessionStore.getSession(data.sessionId);
                if (existingSession) {
                  sessionStore.resumeSession(data.sessionId);
                  if (verbose) {
                    console.log(
                      `[~] Session resumed: ${data.sessionId.slice(0, 8)}... (${data.cwd})`
                    );
                  }
                } else {
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
                }

                // Track socket for input forwarding
                sessionStore.setSessionSocket(data.sessionId, ws);

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
              case "subscribe": {
                // Dashboard client subscribing to updates
                ws.data.isDashboard = true;
                sessionStore.addSubscriber(ws);
                // Send current agent status
                ws.send(JSON.stringify({ type: "agent_status", connected: sessionStore.hasAgent() }));
                if (verbose) {
                  console.log(`[dashboard] Subscriber connected (total: ${sessionStore.getSubscriberCount()})`);
                }
                break;
              }
              case "agent_identify": {
                // Host agent connecting (exclusive - only one allowed)
                const accepted = sessionStore.setAgent(ws);
                if (accepted) {
                  ws.data.isAgent = true;
                  ws.send(JSON.stringify({ type: "ack", eventId: "agent" }));
                  if (verbose) {
                    console.log("[agent] Host agent connected");
                  }
                } else {
                  ws.send(JSON.stringify({ type: "agent_reject", reason: "Another agent is already connected" }));
                  ws.close(4409, "Agent already connected");
                }
                break;
              }
              case "revive_result": {
                // Agent reporting result of a revive command
                if (verbose) {
                  const ok = data.success ? "OK" : "FAIL";
                  console.log(`[agent] Revive ${data.sessionId?.slice(0, 8)}... ${ok}${data.error ? ` (${data.error})` : ""}`);
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
          // Handle agent disconnection
          if (ws.data.isAgent) {
            sessionStore.removeAgent(ws);
            if (verbose) {
              console.log("[agent] Host agent disconnected");
            }
            return;
          }

          // Handle dashboard subscriber disconnection
          if (ws.data.isDashboard) {
            sessionStore.removeSubscriber(ws);
            if (verbose) {
              console.log(`[dashboard] Subscriber disconnected (total: ${sessionStore.getSubscriberCount()})`);
            }
            return;
          }

          // Handle rclaude session disconnection
          const sessionId = ws.data.sessionId;
          if (sessionId) {
            // Remove socket tracking
            sessionStore.removeSessionSocket(sessionId);

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

  const webDirDisplay = webDir ? webDir.padEnd(55) : "Built-in UI".padEnd(55);
  console.log(`
┌─────────────────────────────────────────────────────────────────────────────┐
│  CLAUDE CONCENTRATOR                                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  WebSocket:  ws://localhost:${String(port).padEnd(5)}                                          │
│  REST API:   http://localhost:${String(apiPort || port).padEnd(5)}                                        │
│  Dashboard:  ${webDirDisplay} │
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
