/**
 * Chat API backend -- proxies input to an OpenAI-compatible API via HTTP/SSE.
 * No agent host socket needed.
 */

import { randomUUID } from 'node:crypto'
import type { ChatApiConnection } from '../../shared/chat-api-types'
import type {
  TranscriptAssistantEntry,
  TranscriptEntry,
  TranscriptSystemEntry,
  TranscriptUserEntry,
} from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import type { KVStore } from '../store/types'
import type { BackendDeps, ConversationBackend, InputResult } from './types'

const KV_PREFIX = 'chat:connection:'

export function getChatApiConnection(kv: KVStore, id: string): ChatApiConnection | null {
  return kv.get<ChatApiConnection>(`${KV_PREFIX}${id}`)
}

export const chatApiBackend: ConversationBackend = {
  type: 'chat-api',
  requiresAgentSocket: false,

  async handleInput(conversationId: string, input: string, deps: BackendDeps): Promise<InputResult> {
    const { conversationStore, kv } = deps

    const conv = conversationStore.getConversation(conversationId)
    if (!conv) return { ok: false, error: 'Conversation not found' }

    const chatConnectionId = conv.agentHostMeta?.chatConnectionId as string | undefined
    if (!chatConnectionId) {
      emitErrorEntry(conversationId, 'Not a Chat API conversation', deps)
      return { ok: false, error: 'Not a Chat API conversation' }
    }

    const connection = getChatApiConnection(kv, chatConnectionId)
    if (!connection) {
      emitErrorEntry(conversationId, 'Chat API connection not found -- was it deleted?', deps)
      return { ok: false, error: 'Chat API connection not found' }
    }
    if (!connection.enabled) {
      emitErrorEntry(conversationId, `Connection "${connection.name}" is disabled`, deps)
      return { ok: false, error: 'Chat API connection is disabled' }
    }

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

    const transcript = conversationStore.getTranscriptEntries(conversationId, 200)
    const messages = transcriptToMessages(transcript)

    try {
      const resp = await fetch(`${connection.url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${connection.apiKey}`,
        },
        body: JSON.stringify({
          model: connection.model || 'default',
          messages,
          stream: true,
        }),
        signal: AbortSignal.timeout(120_000),
      })

      if (!resp.ok) {
        const errText = await resp.text()
        const error = `${connection.name}: HTTP ${resp.status} -- ${errText.slice(0, 200)}`
        conv.status = 'idle'
        conversationStore.broadcastConversationUpdate(conversationId)
        emitErrorEntry(conversationId, error, deps)
        return { ok: false, error }
      }

      const broadcast = deps.broadcastScoped
        ? (event: Record<string, unknown>) =>
            deps.broadcastScoped!({ type: 'stream_delta', conversationId, event }, conv.project)
        : undefined
      const fullText = await streamChatApiResponse(resp, conversationId, conversationStore, broadcast)

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
      deps.broadcastToChannel?.('conversation:transcript', conversationId, {
        type: 'transcript_entries',
        conversationId,
        entries: [assistantEntry],
        isInitial: false,
      })

      conv.status = 'idle'
      conv.lastActivity = Date.now()
      conversationStore.broadcastConversationUpdate(conversationId)

      return { ok: true }
    } catch (err) {
      const error = `${connection.name}: ${err instanceof Error ? err.message : String(err)}`
      conv.status = 'idle'
      conversationStore.broadcastConversationUpdate(conversationId)
      emitErrorEntry(conversationId, error, deps)
      return { ok: false, error }
    }
  },
}

function emitErrorEntry(conversationId: string, error: string, deps: BackendDeps): void {
  const entry: TranscriptSystemEntry = {
    type: 'system',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    subtype: 'chat_api_error',
    content: error,
    level: 'error',
  }
  deps.conversationStore.addTranscriptEntries(conversationId, [entry], false)
  deps.broadcastToChannel?.('conversation:transcript', conversationId, {
    type: 'transcript_entries',
    conversationId,
    entries: [entry],
    isInitial: false,
  })
}

// --- Helpers ------------------------------------------------------------------

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

async function streamChatApiResponse(
  resp: Response,
  conversationId: string,
  conversationStore: ConversationStore,
  emitDelta?: (event: Record<string, unknown>) => void,
): Promise<string> {
  const reader = resp.body?.getReader()
  if (!reader) return ''

  const decoder = new TextDecoder()
  let fullText = ''
  let buffer = ''
  let started = false
  let modelReported = false

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
          const delta = chunk.choices?.[0]?.delta

          if (!modelReported && typeof chunk.model === 'string' && chunk.model !== 'default') {
            const conv = conversationStore.getConversation(conversationId)
            if (conv) conv.model = chunk.model
            modelReported = true
          }

          if (emitDelta && !started) {
            emitDelta({ type: 'message_start', message: { role: 'assistant' } })
            emitDelta({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
            started = true
          }

          if (typeof delta?.content === 'string') {
            fullText += delta.content
            if (emitDelta) {
              emitDelta({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } })
            }
          }

          if (typeof delta?.reasoning_content === 'string' && emitDelta) {
            emitDelta({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
            })
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

  if (emitDelta && started) {
    emitDelta({ type: 'content_block_stop', index: 0 })
    emitDelta({ type: 'message_stop' })
  }

  return fullText
}
