/**
 * Hermes routes -- agent registry CRUD + connection test + conversation proxy
 */

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { HermesAgent, HermesAgentCreate, HermesAgentUpdate } from '../../shared/hermes-types'
import { resolveBackend } from '../backends'
import type { ConversationStore } from '../conversation-store'
import type { KVStore } from '../store/types'
import type { RouteHelpers } from './shared'

const KV_PREFIX = 'hermes:agent:'

function agentKey(id: string): string {
  return `${KV_PREFIX}${id}`
}

function listAgents(kv: KVStore): HermesAgent[] {
  return kv
    .keys(KV_PREFIX)
    .map(k => kv.get<HermesAgent>(k))
    .filter((a): a is HermesAgent => a !== null)
    .sort((a, b) => a.createdAt - b.createdAt)
}

function getAgent(kv: KVStore, id: string): HermesAgent | null {
  return kv.get<HermesAgent>(agentKey(id))
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

export function createHermesRouter(conversationStore: ConversationStore, kv: KVStore, helpers: RouteHelpers): Hono {
  const { httpHasPermission, httpIsAdmin } = helpers
  const app = new Hono()

  // ─── Agent Registry CRUD ───────────────────────────────────────────

  app.get('/api/hermes/agents', c => {
    if (!httpHasPermission(c.req.raw, 'chat:read', '*')) return c.json({ error: 'Forbidden' }, 403)
    return c.json({ agents: listAgents(kv) })
  })

  app.post('/api/hermes/agents', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)

    const body = await c.req.json<HermesAgentCreate>()
    if (!body.name || !body.url || !body.apiKey) {
      return c.json({ error: 'name, url, and apiKey are required' }, 400)
    }

    const agent: HermesAgent = {
      id: randomUUID().slice(0, 12),
      name: body.name,
      url: normalizeUrl(body.url),
      apiKey: body.apiKey,
      model: body.model,
      enabled: true,
      createdAt: Date.now(),
    }
    kv.set(agentKey(agent.id), agent)
    return c.json({ agent }, 201)
  })

  app.put('/api/hermes/agents/:id', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)

    const id = c.req.param('id')
    const existing = getAgent(kv, id)
    if (!existing) return c.json({ error: 'Agent not found' }, 404)

    const patch = await c.req.json<HermesAgentUpdate>()
    const updated: HermesAgent = {
      ...existing,
      ...Object.fromEntries(Object.entries(patch).filter(([_, v]) => v !== undefined)),
    }
    if (patch.url) updated.url = normalizeUrl(patch.url)
    kv.set(agentKey(id), updated)
    return c.json({ agent: updated })
  })

  app.delete('/api/hermes/agents/:id', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)

    const id = c.req.param('id')
    if (!getAgent(kv, id)) return c.json({ error: 'Agent not found' }, 404)
    kv.delete(agentKey(id))
    return c.json({ success: true })
  })

  // ─── Test Connection ───────────────────────────────────────────────

  app.post('/api/hermes/agents/:id/test', async c => {
    if (!httpHasPermission(c.req.raw, 'chat:read', '*')) return c.json({ error: 'Forbidden' }, 403)

    const id = c.req.param('id')
    const agent = getAgent(kv, id)
    if (!agent) return c.json({ error: 'Agent not found' }, 404)

    try {
      const resp = await fetch(`${agent.url}/v1/models`, {
        headers: { Authorization: `Bearer ${agent.apiKey}` },
        signal: AbortSignal.timeout(5000),
      })
      if (!resp.ok) {
        return c.json({ ok: false, status: resp.status, error: await resp.text() })
      }
      const data = await resp.json()
      return c.json({ ok: true, models: data })
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ─── Conversation Proxy (delegates to backend) ─────────────────────

  app.post('/api/hermes/conversations/:conversationId/chat', async c => {
    const conversationId = c.req.param('conversationId')
    if (!httpHasPermission(c.req.raw, 'chat', '*')) return c.json({ error: 'Forbidden' }, 403)

    const conv = conversationStore.getConversation(conversationId)
    if (!conv) return c.json({ error: 'Conversation not found' }, 404)

    const backend = resolveBackend(conv)
    if (backend.requiresAgentSocket) return c.json({ error: 'Not a proxy-backed conversation' }, 400)

    const body = await c.req.json<{ input: string }>()
    if (!body.input || typeof body.input !== 'string') return c.json({ error: 'Missing input field' }, 400)

    const result = await backend.handleInput(conversationId, body.input, { conversationStore, kv })
    if (!result.ok) {
      return c.json({ error: result.error }, 502)
    }
    return c.json({ success: true })
  })

  return app
}
