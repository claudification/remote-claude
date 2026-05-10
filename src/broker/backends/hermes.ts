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
import { generateConversationName } from '../../shared/conversation-names'
import type { Conversation, TranscriptUserEntry } from '../../shared/protocol'
import { deriveConversationName } from '../../shared/spawn-naming'
import type { SpawnRequest } from '../../shared/spawn-schema'
import type { BackendDeps, ConversationBackend, InputResult, SpawnDeps, SpawnResult } from './types'

const GATEWAY_TYPE = 'hermes'

export const hermesBackend: ConversationBackend = {
  type: 'hermes',
  scheme: 'hermes',
  requiresAgentSocket: false,

  async spawn(req: SpawnRequest, deps: SpawnDeps): Promise<SpawnResult> {
    return spawnHermes(req, deps)
  },

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

// --- Spawn ----------------------------------------------------------------

/**
 * Spawn a Hermes gateway conversation -- no sentinel, no process.
 * Creates the conversation record and relies on the Hermes gateway adapter
 * (connected via gateway_register) to handle input when it arrives.
 *
 * Moved here from spawn-dispatch.ts as part of the pluggable-backends refactor.
 */
function spawnHermes(req: SpawnRequest, deps: SpawnDeps): SpawnResult {
  const conversationId = randomUUID()
  const jobId = req.jobId ?? randomUUID()
  const project = 'hermes://gateway'

  deps.conversationStore.createJob(jobId, conversationId)

  const gatewayWs = deps.conversationStore.getGatewaySocket(GATEWAY_TYPE)
  if (!gatewayWs) {
    deps.conversationStore.failJob(jobId, 'Hermes gateway not connected')
    return { ok: false, error: 'Hermes gateway not connected', statusCode: 503 }
  }

  const conv = deps.conversationStore.createConversation(
    conversationId,
    project,
    req.model,
    [],
    ['headless', 'channel'],
  )
  conv.status = 'idle'
  conv.agentHostType = 'hermes'
  conv.agentHostMeta = { backend: 'hermes' }
  conv.title =
    req.name ||
    deriveConversationName(req) ||
    generateConversationName(
      new Set(
        deps.conversationStore
          .getAllConversations()
          .map((s: Conversation) => s.title)
          .filter(Boolean) as string[],
      ),
    )
  if (req.description) conv.description = req.description

  deps.conversationStore.persistConversationById(conversationId)
  deps.conversationStore.broadcastConversationUpdate(conversationId)
  deps.conversationStore.forwardJobEvent(jobId, {
    type: 'launch_progress',
    jobId,
    step: 'session_connected',
    status: 'done',
    t: Date.now(),
    conversationId,
  })

  return { ok: true, conversationId, jobId }
}
