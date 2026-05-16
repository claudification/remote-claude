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
   * Used by the prompt-builder for ordering / rendering.
   */
  timestamp: number
  /**
   * Tool calls made and tool errors hit during the turn, one per line.
   * Only populated when the `turn_internals` signal is requested -- it is
   * the safety net for un-marked dead ends. Opt-in because it is expensive.
   */
  internals?: string
}

interface PendingTurn {
  prompt: string
  ts: number
  assistantTexts: string[]
  internals: string[]
}

interface ExtractLimits {
  prompt: number
  final: number
  internals: number
}

export interface ExtractOptions {
  maxPromptChars?: number
  maxFinalChars?: number
  maxInternalsChars?: number
  /** Capture per-turn tool calls + errors into PeriodTurn.internals. */
  includeInternals?: boolean
}

/**
 * Walk a transcript window and pull every turn's user prompt + the
 * matching final assistant text. The "final" assistant text of a turn is
 * the last assistant entry that comes before the next user entry (or
 * end-of-window). Each prompt/final is truncated independently with a
 * `...[truncated NN chars]` marker the LLM can recognise.
 *
 * With `includeInternals`, also collects tool calls + tool errors per turn
 * and stops treating mid-turn tool-result entries as turn boundaries, so
 * the capture spans the whole turn rather than the first assistant block.
 */
export function extractUserPromptsAndFinals(entries: TranscriptEntry[], opts: ExtractOptions = {}): PeriodTurn[] {
  const limits: ExtractLimits = {
    prompt: opts.maxPromptChars ?? 2000,
    final: opts.maxFinalChars ?? 4000,
    internals: opts.maxInternalsChars ?? 3000,
  }
  const includeInternals = opts.includeInternals === true
  const acc: { turns: PeriodTurn[]; pending: PendingTurn | null } = { turns: [], pending: null }
  for (const entry of entries) ingestEntry(entry, acc, limits, includeInternals)
  flushPending(acc, limits)
  return acc.turns
}

// fallow-ignore-next-line complexity
function ingestEntry(
  entry: TranscriptEntry,
  acc: { turns: PeriodTurn[]; pending: PendingTurn | null },
  limits: ExtractLimits,
  includeInternals: boolean,
): void {
  if (entry.type === 'user') {
    const userEntry = entry as TranscriptUserEntry
    const text = extractUserText(userEntry)
    // A user entry with no text is a tool_result. With internals capture on,
    // absorb its errors into the current turn instead of closing the turn.
    if (text === null && includeInternals && acc.pending) {
      for (const e of extractToolErrors(userEntry)) acc.pending.internals.push(e)
      return
    }
    flushPending(acc, limits)
    acc.pending =
      text === null
        ? null
        : { prompt: text, ts: parseTimestamp(userEntry.timestamp), assistantTexts: [], internals: [] }
    return
  }
  if (entry.type === 'assistant' && acc.pending) {
    const assistantEntry = entry as TranscriptAssistantEntry
    const text = extractAssistantText(assistantEntry)
    if (text) acc.pending.assistantTexts.push(text)
    if (includeInternals) {
      for (const u of extractToolUses(assistantEntry)) acc.pending.internals.push(u)
    }
  }
}

function flushPending(acc: { turns: PeriodTurn[]; pending: PendingTurn | null }, limits: ExtractLimits): void {
  if (!acc.pending) return
  const finalText = acc.pending.assistantTexts.join(' ').trim()
  if (acc.pending.prompt.trim() || finalText) {
    const turn: PeriodTurn = {
      turnIndex: acc.turns.length,
      timestamp: acc.pending.ts,
      userPrompt: capWithMarker(acc.pending.prompt, limits.prompt),
      assistantFinal: capWithMarker(finalText, limits.final),
    }
    if (acc.pending.internals.length > 0) {
      turn.internals = capWithMarker(acc.pending.internals.join('\n'), limits.internals)
    }
    acc.turns.push(turn)
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

/** Content blocks of a given `type` inside a transcript message's content. */
function blocksOfType(content: unknown, type: string): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return []
  return content.filter(
    (b): b is Record<string, unknown> =>
      typeof b === 'object' && b !== null && (b as { type?: string }).type === type,
  )
}

/** Compact one-line-per-call list of tool_use blocks in an assistant entry. */
function extractToolUses(entry: TranscriptAssistantEntry): string[] {
  return blocksOfType(entry.message?.content, 'tool_use').map(block => {
    const tool = block as { name?: string; input?: unknown }
    return `[tool] ${tool.name ?? 'unknown'}(${compactValue(tool.input, 80)})`
  })
}

/** Compact list of the error tool_result blocks in a user entry. */
function extractToolErrors(entry: TranscriptUserEntry): string[] {
  return blocksOfType(entry.message?.content, 'tool_result')
    .filter(block => (block as { is_error?: boolean }).is_error === true)
    .map(block => `[error] ${compactValue((block as { content?: unknown }).content, 160)}`)
}

// fallow-ignore-next-line complexity
function compactValue(value: unknown, max: number): string {
  let text: string
  if (typeof value === 'string') {
    text = value
  } else if (Array.isArray(value)) {
    text = value
      .map(item =>
        typeof item === 'string'
          ? item
          : typeof item === 'object' && item !== null && 'text' in item
            ? String((item as { text: unknown }).text)
            : '',
      )
      .join(' ')
  } else if (value === null || value === undefined) {
    text = ''
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}...` : text
}
