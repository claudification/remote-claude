/**
 * WebSocket Server
 * Accepts connections from wrapper instances
 */

import type { Server, ServerWebSocket } from "bun";
import type {
  WrapperMessage,
  SessionMeta,
  HookEvent,
  SessionEnd,
  Heartbeat,
  Ack,
  ConcentratorError,
} from "../shared/protocol";
import type { SessionStore } from "./session-store";

interface WsData {
  sessionId?: string;
}

export interface WsServerOptions {
  port: number;
  sessionStore: SessionStore;
  onSessionStart?: (sessionId: string, meta: SessionMeta) => void;
  onSessionEnd?: (sessionId: string, reason: string) => void;
  onHookEvent?: (sessionId: string, event: HookEvent) => void;
}

type WsServer = Server<WsData>;

/**
 * Create WebSocket server for concentrator
 */
export function createWsServer(options: WsServerOptions): WsServer {
  const { port, sessionStore, onSessionStart, onSessionEnd, onHookEvent } = options;

  const server = Bun.serve<WsData>({
    port,
    fetch(req, server) {
      const url = new URL(req.url);

      // Upgrade WebSocket connections
      if (url.pathname === "/ws" || url.pathname === "/") {
        const success = server.upgrade(req, {
          data: {} as WsData,
        });
        if (success) {
          return undefined;
        }
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(_ws: ServerWebSocket<WsData>) {
        // Connection established, waiting for session meta
      },
      message(ws: ServerWebSocket<WsData>, message) {
        try {
          const data = JSON.parse(message.toString()) as WrapperMessage;

          switch (data.type) {
            case "meta": {
              const meta = data as SessionMeta;
              ws.data.sessionId = meta.sessionId;

              // Create session in store
              sessionStore.createSession(
                meta.sessionId,
                meta.cwd,
                meta.model,
                meta.args
              );

              onSessionStart?.(meta.sessionId, meta);

              // Send ack
              const ack: Ack = { type: "ack", eventId: meta.sessionId };
              ws.send(JSON.stringify(ack));
              break;
            }

            case "hook": {
              const event = data as HookEvent;
              const sessionId = ws.data.sessionId || event.sessionId;

              if (sessionId) {
                sessionStore.addEvent(sessionId, event);
                onHookEvent?.(sessionId, event);
              }
              break;
            }

            case "heartbeat": {
              const heartbeat = data as Heartbeat;
              const sessionId = ws.data.sessionId || heartbeat.sessionId;

              if (sessionId) {
                sessionStore.updateActivity(sessionId);
              }
              break;
            }

            case "end": {
              const end = data as SessionEnd;
              const sessionId = ws.data.sessionId || end.sessionId;

              if (sessionId) {
                sessionStore.endSession(sessionId, end.reason);
                onSessionEnd?.(sessionId, end.reason);
              }
              break;
            }
          }
        } catch (error) {
          const errorMsg: ConcentratorError = {
            type: "error",
            message: `Failed to process message: ${error}`,
          };
          ws.send(JSON.stringify(errorMsg));
        }
      },
      close(ws: ServerWebSocket<WsData>) {
        const sessionId = ws.data.sessionId;
        if (sessionId) {
          const session = sessionStore.getSession(sessionId);
          if (session && session.status !== "ended") {
            sessionStore.endSession(sessionId, "connection_closed");
            onSessionEnd?.(sessionId, "connection_closed");
          }
        }
      },
    },
  });

  return server;
}
