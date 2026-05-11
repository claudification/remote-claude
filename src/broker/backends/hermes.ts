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

    // Route to the specific gateway this conversation was spawned with.
    // Falls back to type-lookup when conv has no gatewayId (legacy data not yet
    // wiped by the migration, or handcrafted test rows).
    const storedGatewayId = (conv.agentHostMeta as { gatewayId?: string } | undefined)?.gatewayId
    const gatewayWs = storedGatewayId
      ? conversationStore.getGatewaySocketById(storedGatewayId)
      : conversationStore.getGatewaySocket(GATEWAY_TYPE)
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

  deps.conversationStore.createJob(jobId, conversationId)

  // Resolve which Hermes gateway to use:
  //  - explicit gatewayId from request (multi-gateway case)
  //  - else: auto-pick the only connected one
  //  - else: error -- no gateway available, or ambiguous when >1 connected
  const connectedGateways = deps.conversationStore.getGatewaysByType(GATEWAY_TYPE)
  let chosen: { gatewayId: string; alias: string } | undefined
  if (req.gatewayId) {
    const found = connectedGateways.find(g => g.gatewayId === req.gatewayId)
    if (!found) {
      deps.conversationStore.failJob(jobId, 'Requested Hermes gateway not connected')
      return { ok: false, error: 'Requested Hermes gateway not connected', statusCode: 503 }
    }
    chosen = { gatewayId: found.gatewayId, alias: found.alias }
  } else if (connectedGateways.length === 1) {
    chosen = { gatewayId: connectedGateways[0].gatewayId, alias: connectedGateways[0].alias }
  } else if (connectedGateways.length === 0) {
    deps.conversationStore.failJob(jobId, 'Hermes gateway not connected')
    return { ok: false, error: 'Hermes gateway not connected', statusCode: 503 }
  } else {
    deps.conversationStore.failJob(jobId, 'Multiple Hermes gateways connected; gatewayId required')
    return {
      ok: false,
      error: 'Multiple Hermes gateways connected; specify gatewayId',
      statusCode: 400,
    }
  }

  // URI authority is the gateway alias so each gateway gets its own sidebar
  // bucket. Named conversations get a path-suffix so they group separately
  // within their gateway.
  const nameSlug = (req.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const project = nameSlug ? `hermes://${chosen.alias}/${nameSlug}` : `hermes://${chosen.alias}`

  const conv = deps.conversationStore.createConversation(
    conversationId,
    project,
    req.model,
    [],
    ['headless', 'channel'],
  )
  conv.status = 'idle'
  conv.agentHostType = 'hermes'
  conv.agentHostMeta = { backend: 'hermes', gatewayId: chosen.gatewayId, gatewayAlias: chosen.alias }
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
    step: 'conversation_connected',
    status: 'done',
    t: Date.now(),
    conversationId,
  })

  return { ok: true, conversationId, jobId }
}
