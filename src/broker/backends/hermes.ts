/**
 * Hermes backend -- proxies input to the Hermes API via HTTP/SSE.
 * No agent host socket needed.
 */

import { randomUUID } from 'node:crypto'
import type { HermesAgent } from '../../shared/hermes-types'
import type {
  TranscriptAssistantEntry,
  TranscriptEntry,
  TranscriptUserEntry,
} from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import type { KVStore } from '../store/types'
import type { BackendDeps, ConversationBackend, InputResult } from './types'

const KV_PREFIX = 'hermes:agent:'

export function getHermesAgent(kv: KVStore, id: string): HermesAgent | null {
  return kv.get<HermesAgent>(`${KV_PREFIX}${id}`)
}

export const hermesBackend: ConversationBackend = {
  type: 'hermes',
  requiresAgentSocket: false,

  async handleInput(conversationId: string, input: string, deps: BackendDeps): Promise<InputResult> {
    const { conversationStore, kv } = deps

    const conv = conversationStore.getConversation(conversationId)
    if (!conv) return { ok: false, error: 'Conversation not found' }

    const hermesAgentId = conv.agentHostMeta?.hermesAgentId as string | undefined
    if (!hermesAgentId) return { ok: false, error: 'Not a Hermes conversation' }

    const agent = getHermesAgent(kv, hermesAgentId)
    if (!agent) return { ok: false, error: 'Hermes agent not found' }
    if (!agent.enabled) return { ok: false, error: 'Hermes agent is disabled' }

    const userEntry: TranscriptUserEntry = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: input },
    }
    conversationStore.addTranscriptEntries(conversationId, [userEntry], false)

    conv.status = 'active'
    conv.lastActivity = Date.now()
    conversationStore.broadcastConversationUpdate(conversationId)

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
        return { ok: false, error: `Hermes API error: ${resp.status} ${errText}` }
      }

      const fullText = await streamHermesResponse(resp, conversationId, conversationStore)

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

      return { ok: true }
    } catch (err) {
      conv.status = 'idle'
      conversationStore.broadcastConversationUpdate(conversationId)
      return { ok: false, error: `Hermes request failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
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
      const content = typeof userEntry.message?.content === 'string'
        ? userEntry.message.content
        : ''
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

          const usage = chunk.usage
          if (usage) {
            const conv = conversationStore.getConversation(conversationId)
            if (conv?.stats) {
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
