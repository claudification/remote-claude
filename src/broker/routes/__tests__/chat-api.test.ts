/**
 * Tests for Chat API routes -- connection registry CRUD + test + conversation proxy
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createChatApiRouter } from '../chat-api'
import { createMemoryDriver } from '../../store/memory/driver'
import { createConversationStore, type ConversationStore } from '../../conversation-store'
import { createRouteHelpers, type RouteHelpers } from '../shared'
import { setRclaudeSecret } from '../../auth-routes'
import type { StoreDriver } from '../../store/types'

const TEST_SECRET = 'test-secret-chat-api-42'

// biome-ignore lint/suspicious/noExplicitAny: test helper
async function json(res: Response): Promise<any> {
  return res.json()
}

let app: Hono
let store: StoreDriver
let conversationStore: ConversationStore
let helpers: RouteHelpers

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_SECRET}` }
}

function jsonHeaders(): Record<string, string> {
  return { ...authHeaders(), 'Content-Type': 'application/json' }
}

beforeEach(() => {
  store = createMemoryDriver()
  store.init()
  conversationStore = createConversationStore({ store, enablePersistence: false })
  setRclaudeSecret(TEST_SECRET)
  helpers = createRouteHelpers(TEST_SECRET)

  app = new Hono()
  app.route('/', createChatApiRouter(conversationStore, store.kv, helpers))
})

// --- Connection Registry CRUD ------------------------------------------------

describe('GET /api/chat/connections', () => {
  it('returns empty list initially', async () => {
    const res = await app.request('/api/chat/connections', { headers: authHeaders() })
    expect(res.status).toBe(200)
    const data = await json(res)
    expect(data.connections).toEqual([])
  })

  it('returns 403 without auth', async () => {
    const res = await app.request('/api/chat/connections')
    expect(res.status).toBe(403)
  })
})

describe('POST /api/chat/connections', () => {
  it('creates a connection with required fields', async () => {
    const res = await app.request('/api/chat/connections', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'Test Connection',
        url: 'http://localhost:8642',
        apiKey: 'test-key',
      }),
    })
    expect(res.status).toBe(201)
    const data = await json(res)
    expect(data.connection.name).toBe('Test Connection')
    expect(data.connection.url).toBe('http://localhost:8642')
    expect(data.connection.enabled).toBe(true)
    expect(data.connection.id).toBeTruthy()
  })

  it('strips trailing slashes from URL', async () => {
    const res = await app.request('/api/chat/connections', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'Connection',
        url: 'http://localhost:8642///',
        apiKey: 'key',
      }),
    })
    const data = await json(res)
    expect(data.connection.url).toBe('http://localhost:8642')
  })

  it('rejects missing required fields', async () => {
    const res = await app.request('/api/chat/connections', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Connection' }),
    })
    expect(res.status).toBe(400)
  })

  it('stores optional fields', async () => {
    const res = await app.request('/api/chat/connections', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'Connection',
        url: 'http://localhost:8642',
        apiKey: 'key',
        model: 'gpt-4o',
      }),
    })
    const data = await json(res)
    expect(data.connection.model).toBe('gpt-4o')
  })
})

describe('PUT /api/chat/connections/:id', () => {
  it('updates an existing connection', async () => {
    // Create first
    const createRes = await app.request('/api/chat/connections', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Original', url: 'http://localhost:8642', apiKey: 'key' }),
    })
    const { connection } = await json(createRes)

    // Update
    const updateRes = await app.request(`/api/chat/connections/${connection.id}`, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Updated' }),
    })
    expect(updateRes.status).toBe(200)
    const data = await json(updateRes)
    expect(data.connection.name).toBe('Updated')
    expect(data.connection.url).toBe('http://localhost:8642')
  })

  it('returns 404 for unknown id', async () => {
    const res = await app.request('/api/chat/connections/nonexistent', {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'X' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/chat/connections/:id', () => {
  it('deletes an existing connection', async () => {
    const createRes = await app.request('/api/chat/connections', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'ToDelete', url: 'http://localhost:8642', apiKey: 'key' }),
    })
    const { connection } = await json(createRes)

    const deleteRes = await app.request(`/api/chat/connections/${connection.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(deleteRes.status).toBe(200)

    // Verify it's gone
    const listRes = await app.request('/api/chat/connections', { headers: authHeaders() })
    const data = await json(listRes)
    expect(data.connections).toEqual([])
  })

  it('returns 404 for unknown id', async () => {
    const res = await app.request('/api/chat/connections/nonexistent', {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(res.status).toBe(404)
  })
})

describe('connection listing', () => {
  it('lists connections sorted by creation time', async () => {
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      await app.request('/api/chat/connections', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, url: 'http://localhost:8642', apiKey: 'key' }),
      })
    }

    const res = await app.request('/api/chat/connections', { headers: authHeaders() })
    const data = await json(res)
    expect(data.connections).toHaveLength(3)
    expect(data.connections[0].name).toBe('Alpha')
    expect(data.connections[2].name).toBe('Gamma')
  })
})

// --- Conversation Proxy ------------------------------------------------------

describe('POST /api/chat/conversations/:id/chat', () => {
  it('returns 404 for unknown conversation', async () => {
    const res = await app.request('/api/chat/conversations/unknown/chat', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ input: 'hello' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 for non-proxy conversation (Claude backend)', async () => {
    const conv = conversationStore.createConversation('conv-1', 'claude://test', undefined, [], ['headless'])
    conv.status = 'active'

    const res = await app.request('/api/chat/conversations/conv-1/chat', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ input: 'hello' }),
    })
    expect(res.status).toBe(400)
    const data = await json(res)
    expect(data.error).toContain('Not a proxy-backed conversation')
  })

  it('returns 502 when chatConnectionId references unknown connection', async () => {
    const conv = conversationStore.createConversation('conv-2', 'chat://test', undefined, [], ['headless'])
    conv.status = 'active'
    conv.agentHostType = 'chat-api'
    conv.agentHostMeta = { chatConnectionId: 'nonexistent', backend: 'chat-api' }

    const res = await app.request('/api/chat/conversations/conv-2/chat', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ input: 'hello' }),
    })
    expect(res.status).toBe(502)
    const data = await json(res)
    expect(data.error).toContain('connection not found')
  })

  it('returns 502 when connection is disabled', async () => {
    const createRes = await app.request('/api/chat/connections', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Disabled', url: 'http://localhost:8642', apiKey: 'key' }),
    })
    const { connection } = await json(createRes)
    await app.request(`/api/chat/connections/${connection.id}`, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ enabled: false }),
    })

    const conv = conversationStore.createConversation('conv-3', 'chat://test', undefined, [], ['headless'])
    conv.status = 'active'
    conv.agentHostType = 'chat-api'
    conv.agentHostMeta = { chatConnectionId: connection.id, backend: 'chat-api' }

    const res = await app.request('/api/chat/conversations/conv-3/chat', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ input: 'hello' }),
    })
    expect(res.status).toBe(502)
    const data = await json(res)
    expect(data.error).toContain('disabled')
  })

  it('returns 400 for missing input', async () => {
    const createRes = await app.request('/api/chat/connections', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Connection', url: 'http://localhost:8642', apiKey: 'key' }),
    })
    const { connection } = await json(createRes)

    const conv = conversationStore.createConversation('conv-4', 'chat://test', undefined, [], ['headless'])
    conv.status = 'active'
    conv.agentHostType = 'chat-api'
    conv.agentHostMeta = { chatConnectionId: connection.id, backend: 'chat-api' }

    const res = await app.request('/api/chat/conversations/conv-4/chat', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const data = await json(res)
    expect(data.error).toContain('Missing input')
  })
})
