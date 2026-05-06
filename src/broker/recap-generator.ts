import { randomUUID } from 'node:crypto'
import type { TranscriptAssistantEntry, TranscriptSystemEntry, TranscriptUserEntry } from '../shared/protocol'
import type { ConversationStore } from './conversation-store'

const RECAP_DELAY_MS = 60_000
const RECAP_PROMPT =
  'The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.'
const MAX_RECENT_ENTRIES = 20
const MAX_CONTEXT_CHARS = 4000
const MODEL = 'anthropic/claude-haiku-4.5'

const pendingTimers = new Map<string, Timer>()

export function scheduleRecap(store: ConversationStore, conversationId: string): void {
  if (!process.env.OPENROUTER_API_KEY) return

  cancelRecap(conversationId)

  const timer = setTimeout(() => {
    pendingTimers.delete(conversationId)
    const conv = store.getConversation(conversationId)
    if (!conv || conv.status !== 'idle') return
    generateRecap(store, conversationId).catch(err => {
      console.log(`[recap] generation failed for ${conversationId.slice(0, 8)}: ${err}`)
    })
  }, RECAP_DELAY_MS)

  pendingTimers.set(conversationId, timer)
}

export function cancelRecap(conversationId: string): void {
  const timer = pendingTimers.get(conversationId)
  if (timer) {
    clearTimeout(timer)
    pendingTimers.delete(conversationId)
  }
}

async function generateRecap(store: ConversationStore, conversationId: string): Promise<void> {
  const condensed = condenseTranscript(store, conversationId)
  if (!condensed) {
    console.log(`[recap] no transcript context for ${conversationId.slice(0, 8)}, skipping`)
    return
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return

  console.log(`[recap] generating for ${conversationId.slice(0, 8)} (${condensed.length} chars context)`)

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: RECAP_PROMPT },
        { role: 'user', content: condensed },
      ],
      max_tokens: 256,
      temperature: 0.1,
    }),
  })

  if (!res.ok) {
    console.log(`[recap] OpenRouter returned ${res.status} for ${conversationId.slice(0, 8)}`)
    return
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const recapText = data.choices?.[0]?.message?.content?.trim()
  if (!recapText) {
    console.log(`[recap] empty response for ${conversationId.slice(0, 8)}`)
    return
  }

  const freshConv = store.getConversation(conversationId)
  if (!freshConv || freshConv.status !== 'idle') return

  const entry: TranscriptSystemEntry = {
    type: 'system',
    subtype: 'away_summary',
    content: recapText,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }

  store.addTranscriptEntries(conversationId, [entry], false)
  store.broadcastToChannel('conversation:transcript', conversationId, {
    type: 'transcript',
    conversationId,
    entries: [entry],
  })
  store.broadcastConversationUpdate(conversationId)

  console.log(`[recap] generated for ${conversationId.slice(0, 8)}: ${recapText.slice(0, 80)}`)
}

function condenseTranscript(store: ConversationStore, conversationId: string): string | null {
  const cached = store.getTranscriptEntries(conversationId)
  if (cached.length === 0) return null

  let resetIdx = 0
  for (let i = cached.length - 1; i >= 0; i--) {
    const e = cached[i]
    if (e.type === 'system' && (e as TranscriptSystemEntry).subtype === 'compact_boundary') {
      resetIdx = i + 1
      break
    }
  }

  const postReset = cached.slice(resetIdx)
  if (postReset.length === 0) return null

  const parts: string[] = []
  let chars = 0

  const firstUser = postReset.find((e): e is TranscriptUserEntry => e.type === 'user')
  if (firstUser) {
    const text = extractUserText(firstUser)
    if (text) {
      const label = `INITIAL PROMPT: ${text}`
      parts.push(truncate(label, MAX_CONTEXT_CHARS))
      chars += parts[0].length
    }
  }

  const recent = postReset.slice(-MAX_RECENT_ENTRIES)
  for (const entry of recent) {
    if (chars >= MAX_CONTEXT_CHARS) break

    let line: string | null = null
    if (entry.type === 'user') {
      if (entry === firstUser) continue
      line = prefixed('USER', extractUserText(entry as TranscriptUserEntry))
    } else if (entry.type === 'assistant') {
      line = prefixed('ASSISTANT', extractAssistantText(entry as TranscriptAssistantEntry))
    }
    if (!line) continue

    const remaining = MAX_CONTEXT_CHARS - chars
    const trimmed = truncate(line, remaining)
    parts.push(trimmed)
    chars += trimmed.length
  }

  return parts.length > 0 ? parts.join('\n') : null
}

function extractUserText(entry: TranscriptUserEntry): string | null {
  const msg = entry.message
  if (!msg) return null
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    const text = msg.content
      .filter(
        (b): b is { type: 'text'; text: string } =>
          typeof b === 'object' && b !== null && b.type === 'text' && 'text' in b,
      )
      .map(b => b.text)
      .join(' ')
    return text || null
  }
  return null
}

function extractAssistantText(entry: TranscriptAssistantEntry): string | null {
  const content = entry.message?.content
  if (!content || !Array.isArray(content)) return null
  const text = content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        typeof b === 'object' && b !== null && b.type === 'text' && 'text' in b,
    )
    .map(b => b.text)
    .join(' ')
  return text || null
}

function prefixed(label: string, text: string | null): string | null {
  return text ? `${label}: ${text}` : null
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}
