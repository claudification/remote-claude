/**
 * Hermes backend -- real Hermes gateway integration via WebSocket adapter.
 *
 * The Hermes adapter (a Python plugin running inside the Hermes container)
 * connects to the broker via a single "gateway" WebSocket. When user input
 * arrives for a Hermes conversation, this backend forwards it to the gateway
 * socket. The adapter dispatches to the Hermes agent, then sends back
 * transcript entries, status updates, and stream deltas over the same socket.
 *
 * requiresAgentSocket is false because the gateway socket is managed
 * separately from per-conversation sockets -- it serves ALL Hermes
 * conversations on a single connection.
 */

import { randomUUID } from 'node:crypto'
import type { TranscriptUserEntry } from '../../shared/protocol'
import type { BackendDeps, ConversationBackend, InputResult } from './types'

const GATEWAY_TYPE = 'hermes'

export const hermesBackend: ConversationBackend = {
  type: 'hermes',
  requiresAgentSocket: false,

  async handleInput(conversationId: string, input: string, deps: BackendDeps): Promise<InputResult> {
    const { conversationStore } = deps

    const conv = conversationStore.getConversation(conversationId)
    if (!conv) return { ok: false, error: 'Conversation not found' }

    const gatewayWs = conversationStore.getGatewaySocket(GATEWAY_TYPE)
    if (!gatewayWs) return { ok: false, error: 'Hermes gateway not connected' }

    const userEntry: TranscriptUserEntry = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: input },
    }
    conversationStore.addTranscriptEntries(conversationId, [userEntry], false)
    deps.broadcastToChannel?.('conversation:transcript', conversationId, {
      type: 'transcript_entries',
      conversationId,
      entries: [userEntry],
      isInitial: false,
    })

    conv.status = 'active'
    conv.lastActivity = Date.now()
    conversationStore.broadcastConversationUpdate(conversationId)

    try {
      gatewayWs.send(
        JSON.stringify({
          type: 'input',
          conversationId,
          input,
        }),
      )
      return { ok: true }
    } catch {
      return { ok: false, error: 'Failed to send to Hermes gateway' }
    }
  },
}
