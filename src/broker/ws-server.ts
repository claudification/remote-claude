/**
 * WebSocket Server
 * Accepts connections from wrapper instances
 */

import type { Server, ServerWebSocket } from 'bun'
import { parseProjectUri } from '../shared/project-uri'
import type { Ack, AgentHostMessage, BrokerError, ConversationMeta, HookEvent, SessionEnd } from '../shared/protocol'
import type { ConversationStore } from './session-store'

interface WsData {
  sessionId?: string
}

export interface WsServerOptions {
  port: number
  sessionStore: ConversationStore
  onSessionStart?: (sessionId: string, meta: ConversationMeta) => void
  onSessionEnd?: (sessionId: string, reason: string) => void
  onHookEvent?: (sessionId: string, event: HookEvent) => void
}

type WsServer = Server<WsData>

/**
 * Create WebSocket server for broker
 */
export function createWsServer(options: WsServerOptions): WsServer {
  const { port, sessionStore, onSessionStart, onSessionEnd, onHookEvent } = options

  const server = Bun.serve<WsData>({
    port,
    fetch(req, server) {
      const url = new URL(req.url)

      // Upgrade WebSocket connections
      if (url.pathname === '/ws' || url.pathname === '/') {
        const success = server.upgrade(req, {
          data: {} as WsData,
        })
        if (success) {
          return undefined
        }
        return new Response('WebSocket upgrade failed', { status: 500 })
      }

      return new Response('Not found', { status: 404 })
    },
    websocket: {
      open(_ws: ServerWebSocket<WsData>) {
        // Connection established, waiting for session meta
      },
      message(ws: ServerWebSocket<WsData>, message) {
        try {
          const data = JSON.parse(message.toString()) as AgentHostMessage

          switch (data.type) {
            case 'meta': {
              const meta = data as ConversationMeta
              ws.data.sessionId = meta.sessionId

              // Check if session already exists (resume case)
              const existingSession = sessionStore.getSession(meta.sessionId)
              if (existingSession) {
                // Resume existing session
                sessionStore.resumeSession(meta.sessionId)
                if (meta.configuredModel) existingSession.configuredModel = meta.configuredModel
              } else {
                // Create new session
                const session = sessionStore.createSession(
                  meta.sessionId,
                  parseProjectUri(meta.project).path,
                  meta.model,
                  meta.args,
                )
                if (meta.configuredModel) session.configuredModel = meta.configuredModel
              }

              // Track socket for this session (for sending input)
              sessionStore.setSessionSocket(meta.sessionId, meta.conversationId || meta.sessionId, ws)

              onSessionStart?.(meta.sessionId, meta)

              // Send ack
              const ack: Ack = { type: 'ack', eventId: meta.sessionId }
              ws.send(JSON.stringify(ack))
              break
            }

            case 'hook': {
              const event = data as HookEvent
              const sessionId = ws.data.sessionId || event.conversationId

              if (sessionId) {
                sessionStore.addEvent(sessionId, event)
                onHookEvent?.(sessionId, event)
              }
              break
            }

            case 'heartbeat': {
              // Heartbeats keep the WS alive but do NOT count as activity.
              // Only hook events and transcript entries reset lastActivity.
              break
            }

            case 'end': {
              const end = data as SessionEnd
              const sessionId = ws.data.sessionId || end.sessionId

              if (sessionId) {
                sessionStore.endSession(sessionId, end.reason)
                onSessionEnd?.(sessionId, end.reason)
              }
              break
            }
          }
        } catch (error) {
          const errorMsg: BrokerError = {
            type: 'error',
            message: `Failed to process message: ${error}`,
          }
          ws.send(JSON.stringify(errorMsg))
        }
      },
      close(ws: ServerWebSocket<WsData>) {
        const sessionId = ws.data.sessionId
        if (sessionId) {
          const session = sessionStore.getSession(sessionId)
          if (session && session.status !== 'ended') {
            sessionStore.endSession(sessionId, 'connection_closed')
            onSessionEnd?.(sessionId, 'connection_closed')
          }
        }
      },
    },
  })

  return server
}
