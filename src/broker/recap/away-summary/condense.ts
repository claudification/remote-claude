import type { TranscriptEntry, TranscriptSystemEntry } from '../../../shared/protocol'
import { parseRecapContent } from '../shared/json-parse'
import { extractAssistantText, extractUserText, prefixed, truncate } from '../shared/transcript-extract'
import { AWAY_SUMMARY_MAX_CONTEXT_CHARS, AWAY_SUMMARY_MAX_RECENT_ENTRIES } from './prompt'

export interface CondenseInput {
  entries: TranscriptEntry[]
  resultText?: string
}

// fallow-ignore-next-line complexity
export function condenseTranscript(input: CondenseInput): string | null {
  const builder = new ContextBuilder(AWAY_SUMMARY_MAX_CONTEXT_CHARS)
  appendFinalResult(builder, input.resultText)
  const scan = scanForBoundariesAndRecaps(input.entries)
  const conversationLines = appendRecentConversation(builder, scan.postReset)
  appendBackground(builder, scan.priorRecaps)
  return finishOrEmpty(builder, conversationLines, scan, input.resultText)
}

// fallow-ignore-next-line complexity
function finishOrEmpty(
  builder: ContextBuilder,
  conversationLines: number,
  scan: BoundaryScan,
  resultText: string | undefined,
): string | null {
  const hasAnything = conversationLines > 0 || scan.priorRecaps.length > 0 || Boolean(resultText)
  if (!hasAnything) return null
  return builder.length > 0 ? builder.build() : null
}

function appendFinalResult(builder: ContextBuilder, resultText: string | undefined): void {
  if (!resultText) return
  builder.add(`FINAL RESULT (the assistant's last output to the user):\n${truncate(resultText, 2000)}`)
}

function appendBackground(builder: ContextBuilder, priorRecaps: string[]): void {
  if (priorRecaps.length === 0) return
  builder.add(`\nBACKGROUND (earlier in this session):\n${priorRecaps.join('\n')}`)
}

class ContextBuilder {
  private readonly parts: string[] = []
  private chars = 0
  constructor(private readonly max: number) {}

  add(text: string): boolean {
    if (this.chars >= this.max) return false
    const trimmed = truncate(text, this.max - this.chars)
    this.parts.push(trimmed)
    this.chars += trimmed.length
    return true
  }

  get length(): number {
    return this.parts.length
  }

  hasRoom(): boolean {
    return this.chars < this.max
  }

  build(): string {
    return this.parts.join('\n')
  }
}

interface BoundaryScan {
  priorRecaps: string[]
  postReset: TranscriptEntry[]
}

// fallow-ignore-next-line complexity
function scanForBoundariesAndRecaps(entries: TranscriptEntry[]): BoundaryScan {
  const priorRecaps: string[] = []
  let lastBoundaryIdx = 0
  for (let i = 0; i < entries.length; i++) {
    const sys = asSystemEntry(entries[i])
    if (!sys) continue
    if (sys.subtype === 'compact_boundary') lastBoundaryIdx = i + 1
    const summary = formatAwaySummary(sys)
    if (summary) priorRecaps.push(summary)
  }
  return { priorRecaps, postReset: entries.slice(lastBoundaryIdx) }
}

function asSystemEntry(entry: TranscriptEntry): TranscriptSystemEntry | null {
  return entry.type === 'system' ? (entry as TranscriptSystemEntry) : null
}

function formatAwaySummary(sys: TranscriptSystemEntry): string | null {
  if (sys.subtype !== 'away_summary' || typeof sys.content !== 'string') return null
  const parsed = parseRecapContent(sys.content)
  return parsed.title ? `${parsed.title}: ${parsed.recap}` : parsed.recap
}

// fallow-ignore-next-line complexity
function appendRecentConversation(builder: ContextBuilder, postReset: TranscriptEntry[]): number {
  const recent = postReset.slice(-AWAY_SUMMARY_MAX_RECENT_ENTRIES)
  if (recent.length === 0) return 0
  builder.add('\nRECENT CONVERSATION:')
  let conversationLines = 0
  for (const entry of recent) {
    if (!builder.hasRoom()) break
    const line = renderEntry(entry)
    if (line) {
      builder.add(line)
      conversationLines++
    }
  }
  return conversationLines
}

function renderEntry(entry: TranscriptEntry): string | null {
  if (entry.type === 'user') return prefixed('USER', extractUserText(entry as never))
  if (entry.type === 'assistant') return prefixed('ASSISTANT', extractAssistantText(entry as never))
  return null
}
