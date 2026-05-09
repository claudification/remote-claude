/**
 * Hermes routes -- agent registry CRUD + connection test + conversation proxy
 */

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { HermesAgent, HermesAgentCreate, HermesAgentUpdate } from '../../shared/hermes-types'
import type { TranscriptAssistantEntry, TranscriptEntry, TranscriptUserEntry } from '../../shared/protocol'
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
      icon: body.icon,
      color: body.color,
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

  // ─── Conversation Proxy (chat completions) ─────────────────────────

  app.post('/api/hermes/conversations/:conversationId/chat', async c => {
    const conversationId = c.req.param('conversationId')
    if (!httpHasPermission(c.req.raw, 'chat', '*')) return c.json({ error: 'Forbidden' }, 403)

    const conv = conversationStore.getConversation(conversationId)
    if (!conv) return c.json({ error: 'Conversation not found' }, 404)

    const hermesAgentId = conv.agentHostMeta?.hermesAgentId as string | undefined
    if (!hermesAgentId) return c.json({ error: 'Not a Hermes conversation' }, 400)

    const agent = getAgent(kv, hermesAgentId)
    if (!agent) return c.json({ error: 'Hermes agent not found' }, 404)
    if (!agent.enabled) return c.json({ error: 'Hermes agent is disabled' }, 400)

    const body = await c.req.json<{ input: string }>()
    if (!body.input || typeof body.input !== 'string') return c.json({ error: 'Missing input field' }, 400)

    // Add user message to transcript
    const userEntry: TranscriptUserEntry = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: body.input },
    }
    conversationStore.addTranscriptEntries(conversationId, [userEntry], false)

    // Set conversation active
    conv.status = 'active'
    conv.lastActivity = Date.now()
    conversationStore.broadcastConversationUpdate(conversationId)

    // Build message history from transcript
    const transcript = conversationStore.getTranscriptEntries(conversationId, 200)
    const messages = transcriptToMessages(transcript)

    try {
      const resp = await fetch(`${agent.url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${agent.apiKey}`,
        },
        body: JSON.stringify({
          model: agent.model || 'default',
          messages,
          stream: true,
        }),
        signal: AbortSignal.timeout(120_000),
      })

      if (!resp.ok) {
        const errText = await resp.text()
        conv.status = 'idle'
        conversationStore.broadcastConversationUpdate(conversationId)
        return c.json({ error: `Hermes API error: ${resp.status} ${errText}` }, 502)
      }

      // Stream SSE response, accumulate full text
      const fullText = await streamHermesResponse(resp, conversationId, conversationStore)

      // Add assistant message to transcript
      const assistantEntry: TranscriptAssistantEntry = {
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: fullText }],
        },
      }
      conversationStore.addTranscriptEntries(conversationId, [assistantEntry], false)

      conv.status = 'idle'
      conv.lastActivity = Date.now()
      conversationStore.broadcastConversationUpdate(conversationId)

      return c.json({ success: true, text: fullText })
    } catch (err) {
      conv.status = 'idle'
      conversationStore.broadcastConversationUpdate(conversationId)
      return c.json(
        {
          error: `Hermes request failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        502,
      )
    }
  })

  return app
}

// ─── Helpers ──────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

function transcriptToMessages(entries: TranscriptEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const entry of entries) {
    if (entry.type === 'user') {
      const userEntry = entry as TranscriptUserEntry
      const content = typeof userEntry.message?.content === 'string' ? userEntry.message.content : ''
      if (content) messages.push({ role: 'user', content })
    } else if (entry.type === 'assistant') {
      const assistantEntry = entry as TranscriptAssistantEntry
      const msg = assistantEntry.message
      if (!msg) continue
      const text = msg.content
        .filter(b => b.type === 'text')
        .map(b => ('text' in b ? (b.text as string) : ''))
        .join('')
      if (text) messages.push({ role: 'assistant', content: text })
    }
  }
  return messages
}

async function streamHermesResponse(
  resp: Response,
  conversationId: string,
  conversationStore: ConversationStore,
): Promise<string> {
  const reader = resp.body?.getReader()
  if (!reader) return ''

  const decoder = new TextDecoder()
  let fullText = ''
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue

        try {
          const chunk = JSON.parse(data)
          const delta = chunk.choices?.[0]?.delta?.content
          if (typeof delta === 'string') {
            fullText += delta
          }

          // Extract usage if present (final chunk)
          const usage = chunk.usage
          if (usage && conversationStore.getConversation(conversationId)) {
            const conv = conversationStore.getConversation(conversationId)!
            if (conv.stats) {
              conv.stats.totalInputTokens = (conv.stats.totalInputTokens || 0) + (usage.prompt_tokens || 0)
              conv.stats.totalOutputTokens = (conv.stats.totalOutputTokens || 0) + (usage.completion_tokens || 0)
              conv.stats.turnCount = (conv.stats.turnCount || 0) + 1
            }
          }
        } catch {
          // skip malformed SSE chunks
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  return fullText
}
