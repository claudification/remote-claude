/**
 * Pure helpers for extracting human-readable text out of transcript
 * entries. Used by both away-summary (recent context condensation) and
 * period-recap (per-conversation user prompt + assistant final pulls).
 */

import type { TranscriptAssistantEntry, TranscriptEntry, TranscriptUserEntry } from '../../../shared/protocol'

// fallow-ignore-next-line complexity
export function extractUserText(entry: TranscriptUserEntry): string | null {
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

// fallow-ignore-next-line complexity
export function extractAssistantText(entry: TranscriptAssistantEntry): string | null {
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

export function prefixed(label: string, text: string | null): string | null {
  return text ? `${label}: ${text}` : null
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s
}

export interface PeriodTurn {
  turnIndex: number
  userPrompt: string
  assistantFinal: string
  /**
   * Timestamp (ms since epoch) of the user prompt that opened the turn.
   * Used by Phase 5 prompt-builder for ordering / rendering.
   */
  timestamp: number
}

/**
 * Walk a transcript window and pull every turn's user prompt + the
 * matching final assistant text. The "final" assistant text of a turn is
 * the last assistant entry that comes before the next user entry (or
 * end-of-window). Each prompt/final is truncated independently with a
 * `...[truncated NN chars]` marker the LLM can recognise.
 */
interface PendingTurn {
  prompt: string
  ts: number
  assistantTexts: string[]
}

export function extractUserPromptsAndFinals(
  entries: TranscriptEntry[],
  opts: { maxPromptChars?: number; maxFinalChars?: number } = {},
): PeriodTurn[] {
  const limits = { prompt: opts.maxPromptChars ?? 2000, final: opts.maxFinalChars ?? 4000 }
  const acc: { turns: PeriodTurn[]; pending: PendingTurn | null } = { turns: [], pending: null }
  for (const entry of entries) ingestEntry(entry, acc, limits)
  flushPending(acc, limits)
  return acc.turns
}

// fallow-ignore-next-line complexity
function ingestEntry(
  entry: TranscriptEntry,
  acc: { turns: PeriodTurn[]; pending: PendingTurn | null },
  limits: { prompt: number; final: number },
): void {
  if (entry.type === 'user') {
    flushPending(acc, limits)
    acc.pending = startTurnFromUser(entry as TranscriptUserEntry)
    return
  }
  if (entry.type === 'assistant' && acc.pending) {
    const text = extractAssistantText(entry as TranscriptAssistantEntry)
    if (text) acc.pending.assistantTexts.push(text)
  }
}

function startTurnFromUser(entry: TranscriptUserEntry): PendingTurn | null {
  const text = extractUserText(entry)
  if (text === null) return null
  return { prompt: text, ts: parseTimestamp(entry.timestamp), assistantTexts: [] }
}

function flushPending(
  acc: { turns: PeriodTurn[]; pending: PendingTurn | null },
  limits: { prompt: number; final: number },
): void {
  if (!acc.pending) return
  const finalText = acc.pending.assistantTexts.join(' ').trim()
  if (acc.pending.prompt.trim() || finalText) {
    acc.turns.push({
      turnIndex: acc.turns.length,
      timestamp: acc.pending.ts,
      userPrompt: capWithMarker(acc.pending.prompt, limits.prompt),
      assistantFinal: capWithMarker(finalText, limits.final),
    })
  }
  acc.pending = null
}

function parseTimestamp(ts: string | number | undefined): number {
  if (typeof ts === 'number') return ts
  if (typeof ts === 'string') {
    const ms = Date.parse(ts)
    if (!Number.isNaN(ms)) return ms
  }
  return 0
}

function capWithMarker(text: string, max: number): string {
  if (text.length <= max) return text
  const dropped = text.length - max
  return `${text.slice(0, max)}...[truncated ${dropped} chars]`
}
