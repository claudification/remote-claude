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

function makeGatewaySocket(gatewayId = 'gw-1') {
  return {
    send: mock(),
    readyState: WebSocket.OPEN,
    data: { isGateway: true, gatewayType: 'hermes', gatewayId },
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

  it('creates conversation when single gateway is connected (auto-pick)', async () => {
    const ws = makeGatewaySocket('gw-1')
    conversationStore.setGatewaySocket('gw-1', 'hermes', 'prod', ws)

    const req: SpawnRequest = { cwd: '~', backend: 'hermes' }
    const result = await dispatchSpawn(req, makeDeps())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const conv = conversationStore.getConversation(result.conversationId)
    expect(conv).toBeDefined()
    expect(conv?.status).toBe('idle')
    expect(conv?.agentHostType).toBe('hermes')
    expect(conv?.agentHostMeta?.backend).toBe('hermes')
    expect(conv?.agentHostMeta?.gatewayId).toBe('gw-1')
    expect(conv?.agentHostMeta?.gatewayAlias).toBe('prod')
    expect(conv?.project).toBe('hermes://prod')
  })

  it('uses provided name as conversation title', async () => {
    const ws = makeGatewaySocket('gw-1')
    conversationStore.setGatewaySocket('gw-1', 'hermes', 'prod', ws)

    const req: SpawnRequest = { cwd: '~', backend: 'hermes', name: 'Research Chat' }
    const result = await dispatchSpawn(req, makeDeps())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const conv = conversationStore.getConversation(result.conversationId)
    expect(conv?.title).toBe('Research Chat')
    expect(conv?.project).toBe('hermes://prod/research-chat')
  })

  it('rejects when multiple gateways connected and no gatewayId given', async () => {
    conversationStore.setGatewaySocket('gw-1', 'hermes', 'prod', makeGatewaySocket('gw-1'))
    conversationStore.setGatewaySocket('gw-2', 'hermes', 'staging', makeGatewaySocket('gw-2'))

    const req: SpawnRequest = { cwd: '~', backend: 'hermes' }
    const result = await dispatchSpawn(req, makeDeps())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Multiple Hermes')
  })

  it('routes to specific gateway when gatewayId is provided', async () => {
    conversationStore.setGatewaySocket('gw-1', 'hermes', 'prod', makeGatewaySocket('gw-1'))
    conversationStore.setGatewaySocket('gw-2', 'hermes', 'staging', makeGatewaySocket('gw-2'))

    const req: SpawnRequest = { cwd: '~', backend: 'hermes', gatewayId: 'gw-2' }
    const result = await dispatchSpawn(req, makeDeps())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const conv = conversationStore.getConversation(result.conversationId)
    expect(conv?.agentHostMeta?.gatewayId).toBe('gw-2')
    expect(conv?.agentHostMeta?.gatewayAlias).toBe('staging')
    expect(conv?.project).toBe('hermes://staging')
  })

  it('rejects when requested gatewayId is not connected', async () => {
    conversationStore.setGatewaySocket('gw-1', 'hermes', 'prod', makeGatewaySocket('gw-1'))

    const req: SpawnRequest = { cwd: '~', backend: 'hermes', gatewayId: 'gw-missing' }
    const result = await dispatchSpawn(req, makeDeps())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('not connected')
    expect(result.statusCode).toBe(503)
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
    const conv = conversationStore.createConversation('conv-1', 'hermes://prod')
    conv.agentHostType = 'hermes'

    const result = await hermesBackend.handleInput('conv-1', 'hello', {
      conversationStore,
      kv: store.kv,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('gateway not connected')
  })

  it("forwards input to the conversation's stored gateway, not just any", async () => {
    const wsProd = makeGatewaySocket('gw-1')
    const wsStaging = makeGatewaySocket('gw-2')
    conversationStore.setGatewaySocket('gw-1', 'hermes', 'prod', wsProd)
    conversationStore.setGatewaySocket('gw-2', 'hermes', 'staging', wsStaging)

    const conv = conversationStore.createConversation('conv-1', 'hermes://staging')
    conv.agentHostType = 'hermes'
    conv.agentHostMeta = { backend: 'hermes', gatewayId: 'gw-2', gatewayAlias: 'staging' }

    const broadcastToChannel = mock()
    const result = await hermesBackend.handleInput('conv-1', 'hello world', {
      conversationStore,
      kv: store.kv,
      broadcastToChannel,
    })

    expect(result.ok).toBe(true)
    expect(wsStaging.send).toHaveBeenCalledTimes(1)
    expect(wsProd.send).not.toHaveBeenCalled()
  })

  it('falls back to type-lookup when conv has no gatewayId (legacy)', async () => {
    const ws = makeGatewaySocket('gw-1')
    conversationStore.setGatewaySocket('gw-1', 'hermes', 'prod', ws)

    const conv = conversationStore.createConversation('conv-1', 'hermes://prod')
    conv.agentHostType = 'hermes'
    // no agentHostMeta.gatewayId -- simulates legacy conv that survived migration

    const result = await hermesBackend.handleInput('conv-1', 'hello', {
      conversationStore,
      kv: store.kv,
      broadcastToChannel: mock(),
    })
    expect(result.ok).toBe(true)
    expect(ws.send).toHaveBeenCalledTimes(1)
  })
})

describe('Gateway socket management', () => {
  it('stores and retrieves gateway socket by id', () => {
    const ws = makeGatewaySocket('gw-1')
    conversationStore.setGatewaySocket('gw-1', 'hermes', 'prod', ws)
    expect(conversationStore.getGatewaySocketById('gw-1')).toBe(ws)
  })

  it('returns undefined for unknown id', () => {
    expect(conversationStore.getGatewaySocketById('gw-missing')).toBeUndefined()
  })

  it('lists gateways by type with alias info', () => {
    conversationStore.setGatewaySocket('gw-1', 'hermes', 'prod', makeGatewaySocket('gw-1'))
    conversationStore.setGatewaySocket('gw-2', 'hermes', 'staging', makeGatewaySocket('gw-2'))
    const list = conversationStore.getGatewaysByType('hermes')
    expect(list.length).toBe(2)
    expect(list.map(g => g.alias).sort()).toEqual(['prod', 'staging'])
  })

  it('removes gateway socket by ref and returns its type', () => {
    const ws = makeGatewaySocket('gw-1')
    conversationStore.setGatewaySocket('gw-1', 'hermes', 'prod', ws)

    const removed = conversationStore.removeGatewaySocketByRef(ws)
    expect(removed).toBe('hermes')
    expect(conversationStore.getGatewaySocketById('gw-1')).toBeUndefined()
  })

  it('returns undefined when removing unknown socket', () => {
    const ws = makeGatewaySocket('gw-other')
    const removed = conversationStore.removeGatewaySocketByRef(ws)
    expect(removed).toBeUndefined()
  })

  it('prunes dead gateway sockets on lookup', () => {
    const ws = {
      send: mock(),
      readyState: WebSocket.CLOSED,
      data: { gatewayId: 'gw-dead' },
    } as unknown as import('bun').ServerWebSocket<unknown>

    conversationStore.setGatewaySocket('gw-dead', 'hermes', 'prod', ws)
    expect(conversationStore.getGatewaySocketById('gw-dead')).toBeUndefined()
  })
})
