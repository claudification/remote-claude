/**
 * Chat API routes -- connection registry CRUD + connection test + conversation proxy
 */

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { ChatApiConnection, ChatApiConnectionCreate, ChatApiConnectionUpdate } from '../../shared/chat-api-types'
import { resolveBackend } from '../backends'
import type { ConversationStore } from '../conversation-store'
import type { KVStore } from '../store/types'
import type { RouteHelpers } from './shared'

const KV_PREFIX = 'chat:connection:'

function connectionKey(id: string): string {
  return `${KV_PREFIX}${id}`
}

function listConnections(kv: KVStore): ChatApiConnection[] {
  return kv
    .keys(KV_PREFIX)
    .map(k => kv.get<ChatApiConnection>(k))
    .filter((a): a is ChatApiConnection => a !== null)
    .sort((a, b) => a.createdAt - b.createdAt)
}

function getConnection(kv: KVStore, id: string): ChatApiConnection | null {
  return kv.get<ChatApiConnection>(connectionKey(id))
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

export function createChatApiRouter(conversationStore: ConversationStore, kv: KVStore, helpers: RouteHelpers): Hono {
  const { httpHasPermission, httpIsAdmin } = helpers
  const app = new Hono()

  // --- Connection Registry CRUD ----------------------------------------------

  app.get('/api/chat/connections', c => {
    if (!httpHasPermission(c.req.raw, 'chat:read', '*')) return c.json({ error: 'Forbidden' }, 403)
    return c.json({ connections: listConnections(kv) })
  })

  app.post('/api/chat/connections', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)

    const body = await c.req.json<ChatApiConnectionCreate>()
    if (!body.name || !body.url || !body.apiKey) {
      return c.json({ error: 'name, url, and apiKey are required' }, 400)
    }

    const connection: ChatApiConnection = {
      id: randomUUID().slice(0, 12),
      name: body.name,
      url: normalizeUrl(body.url),
      apiKey: body.apiKey,
      model: body.model,
      enabled: true,
      createdAt: Date.now(),
    }
    kv.set(connectionKey(connection.id), connection)
    return c.json({ connection }, 201)
  })

  app.put('/api/chat/connections/:id', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)

    const id = c.req.param('id')
    const existing = getConnection(kv, id)
    if (!existing) return c.json({ error: 'Connection not found' }, 404)

    const patch = await c.req.json<ChatApiConnectionUpdate>()
    const updated: ChatApiConnection = {
      ...existing,
      ...Object.fromEntries(Object.entries(patch).filter(([_, v]) => v !== undefined)),
    }
    if (patch.url) updated.url = normalizeUrl(patch.url)
    kv.set(connectionKey(id), updated)
    return c.json({ connection: updated })
  })

  app.delete('/api/chat/connections/:id', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)

    const id = c.req.param('id')
    if (!getConnection(kv, id)) return c.json({ error: 'Connection not found' }, 404)
    kv.delete(connectionKey(id))
    return c.json({ success: true })
  })

  // --- Test Connection -------------------------------------------------------

  app.post('/api/chat/connections/:id/test', async c => {
    if (!httpHasPermission(c.req.raw, 'chat:read', '*')) return c.json({ error: 'Forbidden' }, 403)

    const id = c.req.param('id')
    const connection = getConnection(kv, id)
    if (!connection) return c.json({ error: 'Connection not found' }, 404)

    try {
      const resp = await fetch(`${connection.url}/v1/models`, {
        headers: { Authorization: `Bearer ${connection.apiKey}` },
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

  // --- Conversation Proxy (delegates to backend) -----------------------------

  app.post('/api/chat/conversations/:conversationId/chat', async c => {
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
