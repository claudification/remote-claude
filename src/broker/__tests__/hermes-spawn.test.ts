/**
 * Tests for Hermes gateway spawn and backend
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { hermesBackend } from '../backends/hermes'
import { type ConversationStore, createConversationStore } from '../conversation-store'
import { dispatchSpawn, type SpawnDispatchDeps } from '../spawn-dispatch'
import { createMemoryDriver } from '../store/memory/driver'
import type { StoreDriver } from '../store/types'

let conversationStore: ConversationStore
let store: StoreDriver

function makeDeps(overrides: Partial<SpawnDispatchDeps> = {}): SpawnDispatchDeps {
  return {
    conversationStore,
    getProjectSettings: () => null,
    getGlobalSettings: () => ({}) as ReturnType<SpawnDispatchDeps['getGlobalSettings']>,
    callerContext: {
      kind: 'http',
      hasSpawnPermission: true,
      trustLevel: 'trusted',
      callerProject: null,
    },
    ...overrides,
  }
}

function makeGatewaySocket() {
  return {
    send: mock(),
    readyState: WebSocket.OPEN,
    data: { isGateway: true, gatewayType: 'hermes' },
  } as unknown as import('bun').ServerWebSocket<unknown>
}

beforeEach(() => {
  store = createMemoryDriver()
  store.init()
  conversationStore = createConversationStore({ store, enablePersistence: false })
})

describe('Hermes gateway spawn', () => {
  it('fails when no gateway is connected', async () => {
    const req: SpawnRequest = { cwd: '~', backend: 'hermes' }
    const result = await dispatchSpawn(req, makeDeps())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('gateway not connected')
    expect(result.statusCode).toBe(503)
  })

  it('creates conversation when gateway is connected', async () => {
    const ws = makeGatewaySocket()
    conversationStore.setGatewaySocket('hermes', ws)

    const req: SpawnRequest = { cwd: '~', backend: 'hermes' }
    const result = await dispatchSpawn(req, makeDeps())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const conv = conversationStore.getConversation(result.conversationId)
    expect(conv).toBeDefined()
    expect(conv?.status).toBe('idle')
    expect(conv?.agentHostType).toBe('hermes')
    expect(conv?.agentHostMeta?.backend).toBe('hermes')
    expect(conv?.project).toBe('hermes://gateway')
  })

  it('uses provided name as conversation title', async () => {
    const ws = makeGatewaySocket()
    conversationStore.setGatewaySocket('hermes', ws)

    const req: SpawnRequest = { cwd: '~', backend: 'hermes', name: 'Research Chat' }
    const result = await dispatchSpawn(req, makeDeps())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const conv = conversationStore.getConversation(result.conversationId)
    expect(conv?.title).toBe('Research Chat')
  })
})

describe('Hermes backend handleInput', () => {
  it('returns error when conversation not found', async () => {
    const result = await hermesBackend.handleInput('nonexistent', 'hello', {
      conversationStore,
      kv: store.kv,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('returns error when gateway not connected', async () => {
    const conv = conversationStore.createConversation('conv-1', 'hermes://gateway')
    conv.agentHostType = 'hermes'

    const result = await hermesBackend.handleInput('conv-1', 'hello', {
      conversationStore,
      kv: store.kv,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('gateway not connected')
  })

  it('forwards input to gateway socket and creates user entry', async () => {
    const ws = makeGatewaySocket()
    conversationStore.setGatewaySocket('hermes', ws)

    const conv = conversationStore.createConversation('conv-1', 'hermes://gateway')
    conv.agentHostType = 'hermes'

    const broadcastToChannel = mock()
    const result = await hermesBackend.handleInput('conv-1', 'hello world', {
      conversationStore,
      kv: store.kv,
      broadcastToChannel,
    })

    expect(result.ok).toBe(true)

    // Should have sent input to gateway
    expect(ws.send).toHaveBeenCalledTimes(1)
    const sent = JSON.parse((ws.send as ReturnType<typeof mock>).mock.calls[0][0])
    expect(sent.type).toBe('input')
    expect(sent.conversationId).toBe('conv-1')
    expect(sent.input).toBe('hello world')

    // Should have created user transcript entry
    const transcript = conversationStore.getTranscriptEntries('conv-1')
    expect(transcript.length).toBe(1)
    expect(transcript[0].type).toBe('user')

    // Should have broadcast transcript entry
    expect(broadcastToChannel).toHaveBeenCalledWith(
      'conversation:transcript',
      'conv-1',
      expect.objectContaining({ type: 'transcript_entries' }),
    )

    // Conversation should be active
    expect(conv.status).toBe('active')
  })
})

describe('Gateway socket management', () => {
  it('stores and retrieves gateway socket', () => {
    const ws = makeGatewaySocket()
    conversationStore.setGatewaySocket('hermes', ws)
    expect(conversationStore.getGatewaySocket('hermes')).toBe(ws)
  })

  it('returns undefined for unknown type', () => {
    expect(conversationStore.getGatewaySocket('hermes')).toBeUndefined()
  })

  it('removes gateway socket by ref', () => {
    const ws = makeGatewaySocket()
    conversationStore.setGatewaySocket('hermes', ws)

    const removed = conversationStore.removeGatewaySocketByRef(ws)
    expect(removed).toBe('hermes')
    expect(conversationStore.getGatewaySocket('hermes')).toBeUndefined()
  })

  it('returns undefined when removing unknown socket', () => {
    const ws = makeGatewaySocket()
    const removed = conversationStore.removeGatewaySocketByRef(ws)
    expect(removed).toBeUndefined()
  })

  it('prunes dead gateway sockets', () => {
    const ws = {
      send: mock(),
      readyState: WebSocket.CLOSED,
      data: {},
    } as unknown as import('bun').ServerWebSocket<unknown>

    conversationStore.setGatewaySocket('hermes', ws)
    expect(conversationStore.getGatewaySocket('hermes')).toBeUndefined()
  })
})
