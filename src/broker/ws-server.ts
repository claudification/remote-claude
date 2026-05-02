/**
 * WebSocket Server
 * Accepts connections from wrapper instances
 */

import type { Server, ServerWebSocket } from 'bun'
import { parseProjectUri } from '../shared/project-uri'
import type {
  Ack,
  AgentHostMessage,
  BrokerError,
  ConversationEnd,
  ConversationMeta,
  HookEvent,
} from '../shared/protocol'
import type { ConversationStore } from './conversation-store'

interface WsData {
  conversationId?: string
}

export interface WsServerOptions {
  port: number
  conversationStore: ConversationStore
  onSessionStart?: (conversationId: string, meta: ConversationMeta) => void
  onSessionEnd?: (conversationId: string, reason: string) => void
  onHookEvent?: (conversationId: string, event: HookEvent) => void
}

type WsServer = Server<WsData>

/**
 * Create WebSocket server for broker
 */
export function createWsServer(options: WsServerOptions): WsServer {
  const { port, conversationStore, onSessionStart, onSessionEnd, onHookEvent } = options

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
              const conversationId = meta.conversationId || meta.ccSessionId
              ws.data.conversationId = conversationId

              // Check if conversation already exists (resume case)
              const existingConversation = conversationStore.getConversation(conversationId)
              if (existingConversation) {
                // Resume existing conversation
                conversationStore.resumeConversation(conversationId)
                if (meta.configuredModel) existingConversation.configuredModel = meta.configuredModel
              } else {
                // Create new conversation
                const conversation = conversationStore.createConversation(
                  conversationId,
                  parseProjectUri(meta.project).path,
                  meta.model,
                  meta.args,
                )
                if (meta.configuredModel) conversation.configuredModel = meta.configuredModel
              }

              // Track socket for this conversation (for sending input)
              conversationStore.setConversationSocket(conversationId, meta.conversationId || meta.ccSessionId, ws)

              onSessionStart?.(conversationId, meta)

              // Send ack
              const ack: Ack = { type: 'ack', eventId: conversationId }
              ws.send(JSON.stringify(ack))
              break
            }

            case 'hook': {
              const event = data as HookEvent
              const conversationId = ws.data.conversationId || event.conversationId

              if (conversationId) {
                conversationStore.addEvent(conversationId, event)
                onHookEvent?.(conversationId, event)
              }
              break
            }

            case 'heartbeat': {
              // Heartbeats keep the WS alive but do NOT count as activity.
              // Only hook events and transcript entries reset lastActivity.
              break
            }

            case 'end': {
              const end = data as ConversationEnd
              const conversationId = ws.data.conversationId || end.ccSessionId

              if (conversationId) {
                conversationStore.endConversation(conversationId, end.reason)
                onSessionEnd?.(conversationId, end.reason)
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
        const conversationId = ws.data.conversationId
        if (conversationId) {
          const conversation = conversationStore.getConversation(conversationId)
          if (conversation && conversation.status !== 'ended') {
            conversationStore.endConversation(conversationId, 'connection_closed')
            onSessionEnd?.(conversationId, 'connection_closed')
          }
        }
      },
    },
  })

  return server
}
