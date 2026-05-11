import { randomUUID } from 'node:crypto'
import type { TranscriptSystemEntry } from '../../../shared/protocol'
import type { ConversationStore } from '../../conversation-store'
import { parseRecapContent } from '../shared/json-parse'
import { chat } from '../shared/openrouter-client'
import { condenseTranscript } from './condense'
import {
  AWAY_SUMMARY_DELAY_MS,
  AWAY_SUMMARY_MAX_TOKENS,
  AWAY_SUMMARY_MODEL,
  AWAY_SUMMARY_PROMPT,
  AWAY_SUMMARY_TEMPERATURE,
} from './prompt'

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

type ReplyFn = (msg: Record<string, unknown>) => void

export function scheduleRecap(store: ConversationStore, conversationId: string): void {
  if (!process.env.OPENROUTER_API_KEY) return
  cancelRecap(conversationId)
  const timer = setTimeout(() => {
    pendingTimers.delete(conversationId)
    const conv = store.getConversation(conversationId)
    if (!conv || conv.status !== 'idle') return
    runGeneration(store, conversationId, { allowEnded: false }).catch(err => {
      logFailure('generation failed', conversationId, err)
    })
  }, AWAY_SUMMARY_DELAY_MS)
  pendingTimers.set(conversationId, timer)
}

export function cancelRecap(conversationId: string): void {
  const timer = pendingTimers.get(conversationId)
  if (!timer) return
  clearTimeout(timer)
  pendingTimers.delete(conversationId)
}

export function generateRecapOnEnd(store: ConversationStore, conversationId: string): void {
  if (!process.env.OPENROUTER_API_KEY) return
  const conv = store.getConversation(conversationId)
  if (!conv || conv.recap) return
  cancelRecap(conversationId)
  runGeneration(store, conversationId, { allowEnded: true }).catch(err => {
    logFailure('end-of-conversation generation failed', conversationId, err)
  })
}

export function generateRecapManual(store: ConversationStore, conversationId: string, reply?: ReplyFn): void {
  const replyResult = makeReplyResult(conversationId, reply)
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('[recap] manual generation skipped -- no OPENROUTER_API_KEY')
    replyResult(false, 'No OPENROUTER_API_KEY configured on broker')
    return
  }
  if (!store.getConversation(conversationId)) {
    replyResult(false, 'Conversation not found')
    return
  }
  cancelRecap(conversationId)
  console.log(`[recap] manual generation requested for ${conversationId.slice(0, 8)}`)
  runGeneration(store, conversationId, { allowEnded: true, reply }).catch(err => {
    logFailure('manual generation failed', conversationId, err)
    replyResult(false, `Recap generation failed: ${err}`)
  })
}

interface GenerationOptions {
  allowEnded: boolean
  reply?: ReplyFn
}

// fallow-ignore-next-line complexity
async function runGeneration(store: ConversationStore, conversationId: string, opts: GenerationOptions): Promise<void> {
  const replyResult = makeReplyResult(conversationId, opts.reply)
  const condensed = prepareContext(store, conversationId, opts, replyResult)
  if (!condensed) return
  console.log(`[recap] generating for ${conversationId.slice(0, 8)} (${condensed.length} chars context)`)

  const rawText = await callOpenRouter(conversationId, condensed, replyResult)
  if (rawText === null) return
  if (!hasRecapJson(rawText)) {
    console.log(`[recap] non-JSON response for ${conversationId.slice(0, 8)}: ${rawText.slice(0, 80)}`)
    replyResult(false, 'Model returned invalid response (no JSON)')
    return
  }
  persistResult(store, conversationId, rawText, opts.allowEnded)
  replyResult(true)
}

// fallow-ignore-next-line complexity
function prepareContext(
  store: ConversationStore,
  conversationId: string,
  opts: GenerationOptions,
  replyResult: (ok: boolean, error?: string) => void,
): string | null {
  const conv = store.getConversation(conversationId)
  if (!conv || (!opts.allowEnded && conv.status !== 'idle')) {
    replyResult(false, 'Conversation not available for recap')
    return null
  }
  const condensed = buildCondensedContext(store, conversationId, conv.resultText) ?? ''
  if (condensed.length < 50) {
    console.log(
      `[recap] insufficient transcript for ${conversationId.slice(0, 8)} (${condensed.length} chars), skipping`,
    )
    replyResult(false, 'Not enough conversation content to generate a recap')
    return null
  }
  return condensed
}

// fallow-ignore-next-line complexity
async function callOpenRouter(
  conversationId: string,
  condensed: string,
  replyResult: (ok: boolean, error?: string) => void,
): Promise<string | null> {
  try {
    const res = await chat({
      model: AWAY_SUMMARY_MODEL,
      system: AWAY_SUMMARY_PROMPT,
      user: condensed,
      maxTokens: AWAY_SUMMARY_MAX_TOKENS,
      temperature: AWAY_SUMMARY_TEMPERATURE,
      retries: 0,
    })
    if (!res.content.trim()) {
      console.log(`[recap] empty response for ${conversationId.slice(0, 8)}`)
      replyResult(false, 'OpenRouter returned an empty response')
      return null
    }
    return res.content
  } catch (err) {
    const status = isHttpStatusError(err) ? err.status : undefined
    if (status != null) {
      console.log(`[recap] OpenRouter returned ${status} for ${conversationId.slice(0, 8)}`)
      replyResult(false, `OpenRouter API returned ${status}`)
    } else {
      logFailure('OpenRouter call failed', conversationId, err)
      replyResult(false, `OpenRouter call failed: ${describe(err)}`)
    }
    return null
  }
}

// fallow-ignore-next-line complexity
function persistResult(store: ConversationStore, conversationId: string, rawText: string, allowEnded: boolean): void {
  const parsed = parseRecapContent(rawText)
  const freshConv = store.getConversation(conversationId)
  if (!freshConv) return
  if (!allowEnded && freshConv.status !== 'idle') return

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
  if (allowEnded) store.persistConversationById(conversationId)
  console.log(
    `[recap] generated for ${conversationId.slice(0, 8)}: title="${parsed.title}" recap="${parsed.recap.slice(0, 60)}"`,
  )
}

// fallow-ignore-next-line complexity
function buildCondensedContext(store: ConversationStore, conversationId: string, resultText?: string): string | null {
  let entries = store.getTranscriptEntries(conversationId)
  if (entries.length === 0) entries = store.loadTranscriptFromStore(conversationId, 200) || []
  if (entries.length === 0 && !resultText) return null
  return condenseTranscript({ entries, resultText })
}

function makeReplyResult(conversationId: string, reply?: ReplyFn) {
  return (ok: boolean, error?: string) => {
    if (!reply) return
    reply({ type: 'recap_request_result', conversationId, ok, ...(error ? { error } : {}) })
  }
}

function hasRecapJson(rawText: string): boolean {
  return /\{[\s\S]*"recap"[\s\S]*\}/.test(rawText)
}

function isHttpStatusError(err: unknown): err is { status: number } {
  return (
    typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status: number }).status === 'number'
  )
}

function logFailure(label: string, conversationId: string, err: unknown): void {
  console.log(`[recap] ${label} for ${conversationId.slice(0, 8)}: ${describe(err)}`)
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
