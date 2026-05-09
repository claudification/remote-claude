/**
 * Tests for Hermes routes -- agent registry CRUD + test + conversation proxy
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createHermesRouter } from '../hermes'
import { createMemoryDriver } from '../../store/memory/driver'
import { createConversationStore, type ConversationStore } from '../../conversation-store'
import { createRouteHelpers, type RouteHelpers } from '../shared'
import { setRclaudeSecret } from '../../auth-routes'
import type { StoreDriver } from '../../store/types'

const TEST_SECRET = 'test-secret-hermes-42'

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
  app.route('/', createHermesRouter(conversationStore, store.kv, helpers))
})

// ─── Agent Registry CRUD ──────────────────────────────────────────────

describe('GET /api/hermes/agents', () => {
  it('returns empty list initially', async () => {
    const res = await app.request('/api/hermes/agents', { headers: authHeaders() })
    expect(res.status).toBe(200)
    const data = await json(res)
    expect(data.agents).toEqual([])
  })

  it('returns 403 without auth', async () => {
    const res = await app.request('/api/hermes/agents')
    expect(res.status).toBe(403)
  })
})

describe('POST /api/hermes/agents', () => {
  it('creates an agent with required fields', async () => {
    const res = await app.request('/api/hermes/agents', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'Test Agent',
        url: 'http://hermes:8642',
        apiKey: 'test-key',
      }),
    })
    expect(res.status).toBe(201)
    const data = await json(res)
    expect(data.agent.name).toBe('Test Agent')
    expect(data.agent.url).toBe('http://hermes:8642')
    expect(data.agent.enabled).toBe(true)
    expect(data.agent.id).toBeTruthy()
  })

  it('strips trailing slashes from URL', async () => {
    const res = await app.request('/api/hermes/agents', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'Agent',
        url: 'http://hermes:8642///',
        apiKey: 'key',
      }),
    })
    const data = await json(res)
    expect(data.agent.url).toBe('http://hermes:8642')
  })

  it('rejects missing required fields', async () => {
    const res = await app.request('/api/hermes/agents', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Agent' }),
    })
    expect(res.status).toBe(400)
  })

  it('stores optional fields', async () => {
    const res = await app.request('/api/hermes/agents', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'Agent',
        url: 'http://hermes:8642',
        apiKey: 'key',
        model: 'gpt-4o',
        icon: '~',
        color: '#8B5CF6',
      }),
    })
    const data = await json(res)
    expect(data.agent.model).toBe('gpt-4o')
    expect(data.agent.icon).toBe('~')
    expect(data.agent.color).toBe('#8B5CF6')
  })
})

describe('PUT /api/hermes/agents/:id', () => {
  it('updates an existing agent', async () => {
    // Create first
    const createRes = await app.request('/api/hermes/agents', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Original', url: 'http://hermes:8642', apiKey: 'key' }),
    })
    const { agent } = await json(createRes)

    // Update
    const updateRes = await app.request(`/api/hermes/agents/${agent.id}`, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Updated', icon: '~' }),
    })
    expect(updateRes.status).toBe(200)
    const data = await json(updateRes)
    expect(data.agent.name).toBe('Updated')
    expect(data.agent.icon).toBe('~')
    expect(data.agent.url).toBe('http://hermes:8642')
  })

  it('returns 404 for unknown id', async () => {
    const res = await app.request('/api/hermes/agents/nonexistent', {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'X' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/hermes/agents/:id', () => {
  it('deletes an existing agent', async () => {
    const createRes = await app.request('/api/hermes/agents', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'ToDelete', url: 'http://hermes:8642', apiKey: 'key' }),
    })
    const { agent } = await json(createRes)

    const deleteRes = await app.request(`/api/hermes/agents/${agent.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(deleteRes.status).toBe(200)

    // Verify it's gone
    const listRes = await app.request('/api/hermes/agents', { headers: authHeaders() })
    const data = await json(listRes)
    expect(data.agents).toEqual([])
  })

  it('returns 404 for unknown id', async () => {
    const res = await app.request('/api/hermes/agents/nonexistent', {
      method: 'DELETE',
      headers: authHeaders(),
    })
    expect(res.status).toBe(404)
  })
})

describe('agent listing', () => {
  it('lists agents sorted by creation time', async () => {
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      await app.request('/api/hermes/agents', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, url: 'http://hermes:8642', apiKey: 'key' }),
      })
    }

    const res = await app.request('/api/hermes/agents', { headers: authHeaders() })
    const data = await json(res)
    expect(data.agents).toHaveLength(3)
    expect(data.agents[0].name).toBe('Alpha')
    expect(data.agents[2].name).toBe('Gamma')
  })
})

// ─── Conversation Proxy ───────────────────────────────────────────────

describe('POST /api/hermes/conversations/:id/chat', () => {
  it('returns 404 for unknown conversation', async () => {
    const res = await app.request('/api/hermes/conversations/unknown/chat', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ input: 'hello' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 for non-Hermes conversation', async () => {
    const conv = conversationStore.createConversation('conv-1', 'claude://test', undefined, [], ['headless'])
    conv.status = 'active'

    const res = await app.request('/api/hermes/conversations/conv-1/chat', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ input: 'hello' }),
    })
    expect(res.status).toBe(400)
    const data = await json(res)
    expect(data.error).toContain('Not a Hermes conversation')
  })

  it('returns 404 when hermesAgentId references unknown agent', async () => {
    const conv = conversationStore.createConversation('conv-2', 'hermes://test', undefined, [], ['headless'])
    conv.status = 'active'
    conv.agentHostMeta = { hermesAgentId: 'nonexistent', backend: 'hermes' }

    const res = await app.request('/api/hermes/conversations/conv-2/chat', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ input: 'hello' }),
    })
    expect(res.status).toBe(404)
    const data = await json(res)
    expect(data.error).toContain('Hermes agent not found')
  })

  it('returns 400 when agent is disabled', async () => {
    // Create agent, then disable it
    const createRes = await app.request('/api/hermes/agents', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Disabled', url: 'http://hermes:8642', apiKey: 'key' }),
    })
    const { agent } = await json(createRes)
    await app.request(`/api/hermes/agents/${agent.id}`, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ enabled: false }),
    })

    const conv = conversationStore.createConversation('conv-3', 'hermes://test', undefined, [], ['headless'])
    conv.status = 'active'
    conv.agentHostMeta = { hermesAgentId: agent.id, backend: 'hermes' }

    const res = await app.request('/api/hermes/conversations/conv-3/chat', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ input: 'hello' }),
    })
    expect(res.status).toBe(400)
    const data = await json(res)
    expect(data.error).toContain('disabled')
  })

  it('returns 400 for missing input', async () => {
    const createRes = await app.request('/api/hermes/agents', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Agent', url: 'http://hermes:8642', apiKey: 'key' }),
    })
    const { agent } = await json(createRes)

    const conv = conversationStore.createConversation('conv-4', 'hermes://test', undefined, [], ['headless'])
    conv.status = 'active'
    conv.agentHostMeta = { hermesAgentId: agent.id, backend: 'hermes' }

    const res = await app.request('/api/hermes/conversations/conv-4/chat', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const data = await json(res)
    expect(data.error).toContain('Missing input')
  })
})
