import { randomUUID } from 'node:crypto'
import type { TranscriptAssistantEntry, TranscriptSystemEntry, TranscriptUserEntry } from '../shared/protocol'
import { parseRecapContent } from '../shared/recap'
import type { ConversationStore } from './conversation-store'

const RECAP_DELAY_MS = 60_000
const RECAP_PROMPT = `The developer stepped away from this coding session. Recap what's happening.
Respond with JSON: {"title": "...", "recap": "..."}

title: 3-5 word topic label (e.g. "Fix spawn timeout", "SQLite migration").
recap: One plain sentence, under 20 words. State what's being done and where it stands. No labels like "Goal:" or "Next:". No "I" or "We". No markdown, no backticks, no bullet points.

Focus on RECENT CONVERSATION. BACKGROUND is prior context only.
Respond with ONLY the JSON object.`
const MAX_RECENT_ENTRIES = 40
const MAX_CONTEXT_CHARS = 8000
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
  const conv = store.getConversation(conversationId)
  const condensed = condenseTranscript(store, conversationId, conv?.resultText)
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
  const rawText = data.choices?.[0]?.message?.content?.trim()
  if (!rawText) {
    console.log(`[recap] empty response for ${conversationId.slice(0, 8)}`)
    return
  }

  const parsed = parseRecapContent(rawText)

  const freshConv = store.getConversation(conversationId)
  if (!freshConv || freshConv.status !== 'idle') return

  const entry: TranscriptSystemEntry = {
    type: 'system',
    subtype: 'away_summary',
    content: JSON.stringify({ title: parsed.title, recap: parsed.recap }),
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

  console.log(
    `[recap] generated for ${conversationId.slice(0, 8)}: title="${parsed.title}" recap="${parsed.recap.slice(0, 60)}"`,
  )
}

function condenseTranscript(store: ConversationStore, conversationId: string, resultText?: string): string | null {
  const cached = store.getTranscriptEntries(conversationId)
  if (cached.length === 0) return null

  const parts: string[] = []
  let chars = 0

  function addPart(text: string): boolean {
    if (chars >= MAX_CONTEXT_CHARS) return false
    const trimmed = truncate(text, MAX_CONTEXT_CHARS - chars)
    parts.push(trimmed)
    chars += trimmed.length
    return true
  }

  // The assistant's final result text is the single most important signal
  if (resultText) {
    addPart(`FINAL RESULT (the assistant's last output to the user):\n${truncate(resultText, 2000)}`)
  }

  // Scan for compaction boundaries and prior recaps
  const priorRecaps: string[] = []
  let lastBoundaryIdx = 0

  for (let i = 0; i < cached.length; i++) {
    const e = cached[i]
    if (e.type !== 'system') continue
    const sys = e as TranscriptSystemEntry
    if (sys.subtype === 'away_summary' && typeof sys.content === 'string') {
      const parsed = parseRecapContent(sys.content)
      const label = parsed.title ? `${parsed.title}: ${parsed.recap}` : parsed.recap
      priorRecaps.push(label)
    }
    if (sys.subtype === 'compact_boundary') {
      lastBoundaryIdx = i + 1
    }
  }

  // Recent conversation entries -- this is the current work
  const postReset = cached.slice(lastBoundaryIdx)
  if (postReset.length === 0 && priorRecaps.length === 0 && !resultText) return null

  const recent = postReset.slice(-MAX_RECENT_ENTRIES)
  if (recent.length > 0) {
    addPart('\nRECENT CONVERSATION:')
    for (const entry of recent) {
      if (chars >= MAX_CONTEXT_CHARS) break
      let line: string | null = null
      if (entry.type === 'user') {
        line = prefixed('USER', extractUserText(entry as TranscriptUserEntry))
      } else if (entry.type === 'assistant') {
        line = prefixed('ASSISTANT', extractAssistantText(entry as TranscriptAssistantEntry))
      }
      if (line) addPart(line)
    }
  }

  // Prior recaps as background context at the end
  if (priorRecaps.length > 0) {
    addPart(`\nBACKGROUND (earlier in this session):\n${priorRecaps.join('\n')}`)
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
