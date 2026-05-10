/**
 * OpenCode NDJSON event -> Claudwerk wire-protocol translator.
 *
 * Pure function (no side-effects, no I/O) so it's easy to unit-test. The
 * caller (index.ts) reads stdout from `opencode run --format json`, splits
 * on newlines, JSON.parses each line, and feeds it here.
 *
 * Event shape reference: `.claude/docs/research-multi-agent-integration.md`
 * (OpenCode section, line 192-470) and the runtime sample in
 * `.claude/docs/plan-opencode-backend.md`.
 *
 * The output entries match the existing Claudwerk transcript shapes
 * (TranscriptAssistantEntry, TranscriptSystemEntry, ...) so the dashboard's
 * existing renderers work unchanged.
 */

import { randomUUID } from 'node:crypto'
import type {
  TranscriptAssistantEntry,
  TranscriptContentBlock,
  TranscriptEntry,
  TranscriptSystemEntry,
} from '../shared/protocol'
import { translateOpencodeNdjsonToolResult, translateOpencodeNdjsonToolUse } from './dialect/from-opencode-ndjson'

// --- Input shapes ---------------------------------------------------------

export type OpenCodeEvent =
  | OpenCodeStepStart
  | OpenCodeText
  | OpenCodeToolUse
  | OpenCodeStepFinish
  | OpenCodeError
  | OpenCodeUnknown

export interface OpenCodeStepStart {
  type: 'step_start'
  // Sometimes session id is included on the part / outer envelope.
  sessionID?: string
  part?: { sessionID?: string; messageID?: string }
}

export interface OpenCodeText {
  type: 'text'
  part: {
    text: string
    sessionID?: string
    messageID?: string
  }
}

export interface OpenCodeToolUse {
  type: 'tool_use'
  part: {
    tool: string
    callID: string
    state: {
      status: 'running' | 'completed' | 'error'
      input?: Record<string, unknown>
      output?: string
      title?: string
      time?: { start?: number; end?: number }
      error?: string
    }
    sessionID?: string
    messageID?: string
  }
}

export interface OpenCodeStepFinish {
  type: 'step_finish'
  part: {
    reason?: string // 'tool-calls' | 'stop' | 'length' | ...
    cost?: number
    tokens?: {
      input?: number
      output?: number
      reasoning?: number
      cache?: { read?: number; write?: number }
    }
    sessionID?: string
    messageID?: string
  }
}

export interface OpenCodeError {
  type: 'error'
  part?: { message?: string; name?: string; data?: unknown }
  error?: string
  message?: string
}

export interface OpenCodeUnknown {
  type: string
  [key: string]: unknown
}

// --- Output ---------------------------------------------------------------

/** Per-turn aggregator state. The opencode-host process keeps one of these
 *  per running `opencode run` subprocess; events flow in, transcript entries
 *  flow out. step_finish flushes any in-flight assistant message. */
export interface ParserState {
  /** OpenCode session id, captured from any event that carries one. Stored
   *  on agentHostMeta so the next turn can resume with `--session`. */
  sessionId: string | null
  /** Accumulated text + tool blocks for the current step. Flushed as a single
   *  TranscriptAssistantEntry when step_finish arrives. */
  pendingBlocks: TranscriptContentBlock[]
  /** Last non-empty plain-text segment (used to coalesce contiguous text
   *  events into a single block). */
  lastTextBlockIdx: number | null
  /** Cumulative usage / cost for the turn (summed across all step_finish events). */
  cost: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** Steps observed in this turn -- one per LLM round trip. */
  stepCount: number
  /** Wall-clock turn start, for duration reporting. */
  turnStartedAt: number
}

export function createParserState(): ParserState {
  return {
    sessionId: null,
    pendingBlocks: [],
    lastTextBlockIdx: null,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    stepCount: 0,
    turnStartedAt: Date.now(),
  }
}

export interface TranslatorOutput {
  /** Transcript entries to emit to the broker right now (may be empty). */
  entries: TranscriptEntry[]
  /** True if the turn is complete (last step_finish observed and reason is a
   *  terminal one). The caller drains pendingBlocks and finishes the turn. */
  turnComplete: boolean
}

/**
 * Translate one OpenCode NDJSON event into zero or more transcript entries.
 * Mutates `state` to accumulate cross-event data (text/tool blocks per step,
 * session id, usage). Returns entries that should be flushed immediately.
 *
 * Caller contract:
 *   - On `step_finish`, the parser flushes pendingBlocks as one assistant
 *     entry plus a system turn_duration entry.
 *   - On `error`, the parser emits a system error entry and the caller
 *     should treat the turn as failed.
 *   - On unknown events, returns an empty entry list (defensive: future
 *     OpenCode versions may add events we don't know about).
 */
export function translateEvent(event: OpenCodeEvent, state: ParserState): TranslatorOutput {
  // Capture session id whenever we see it
  const sessionId =
    (event as { sessionID?: string }).sessionID ?? (event as { part?: { sessionID?: string } }).part?.sessionID
  if (sessionId && !state.sessionId) state.sessionId = sessionId

  switch (event.type) {
    case 'step_start':
      state.stepCount += 1
      return { entries: [], turnComplete: false }

    case 'text': {
      const text = (event as OpenCodeText).part?.text ?? ''
      if (!text) return { entries: [], turnComplete: false }
      // Coalesce consecutive text events into a single block (saves a lot of
      // tiny TranscriptAssistantEntries in token-streamed providers).
      if (state.lastTextBlockIdx !== null) {
        const block = state.pendingBlocks[state.lastTextBlockIdx]
        if (block && block.type === 'text') {
          block.text = (block.text ?? '') + text
          return { entries: [], turnComplete: false }
        }
      }
      const block: TranscriptContentBlock = { type: 'text', text }
      state.pendingBlocks.push(block)
      state.lastTextBlockIdx = state.pendingBlocks.length - 1
      return { entries: [], turnComplete: false }
    }

    case 'tool_use': {
      const part = (event as OpenCodeToolUse).part
      if (!part || !part.tool || !part.callID) return { entries: [], turnComplete: false }

      // tool_use part: id, name, input
      const toolUseBlock: TranscriptContentBlock = {
        type: 'tool_use',
        id: part.callID,
        name: part.tool,
        input: (part.state?.input as Record<string, unknown> | undefined) ?? {},
      }
      // Translate to canonical CLAUDEWERK shape (kind/canonicalInput/raw).
      // Backend identifier is `opencode` (vs `acp:opencode` for the ACP host).
      translateOpencodeNdjsonToolUse(toolUseBlock)

      // tool_result part: paired by tool_use_id, content from state.output
      const status = part.state?.status
      const isError = status === 'error'
      const outputContent = part.state?.output ?? part.state?.error ?? ''
      const toolResultBlock: TranscriptContentBlock = {
        type: 'tool_result',
        tool_use_id: part.callID,
        content: outputContent,
        ...(isError ? { is_error: true } : {}),
      }
      const startMs = part.state?.time?.start
      const endMs = part.state?.time?.end
      const durationMs = typeof startMs === 'number' && typeof endMs === 'number' ? endMs - startMs : undefined
      translateOpencodeNdjsonToolResult(toolResultBlock, {
        sourceToolName: part.tool,
        status,
        durationMs,
      })

      state.pendingBlocks.push(toolUseBlock, toolResultBlock)
      // A tool block ends the current text block; force a fresh one on next text.
      state.lastTextBlockIdx = null
      return { entries: [], turnComplete: false }
    }

    case 'step_finish': {
      const part = (event as OpenCodeStepFinish).part || {}
      if (typeof part.cost === 'number') state.cost += part.cost
      const t = part.tokens || {}
      if (typeof t.input === 'number') state.inputTokens += t.input
      if (typeof t.output === 'number') state.outputTokens += t.output
      if (typeof t.reasoning === 'number') state.reasoningTokens += t.reasoning
      if (t.cache) {
        if (typeof t.cache.read === 'number') state.cacheReadTokens += t.cache.read
        if (typeof t.cache.write === 'number') state.cacheWriteTokens += t.cache.write
      }
      // A reason of 'tool-calls' means another step is coming -- don't flush
      // the assistant message yet, just let the next step_start/text/tool_use
      // append more blocks. A reason like 'stop' / 'end_turn' / undefined (terminal
      // step in single-step run) means we're done.
      const isTerminal = !part.reason || part.reason !== 'tool-calls'
      if (!isTerminal) {
        return { entries: [], turnComplete: false }
      }
      return {
        entries: flushTurn(state),
        turnComplete: true,
      }
    }

    case 'error': {
      const message =
        (event as OpenCodeError).message ||
        (event as OpenCodeError).error ||
        (event as OpenCodeError).part?.message ||
        'OpenCode reported an error'
      const errorEntry: TranscriptSystemEntry = {
        type: 'system',
        subtype: 'chat_api_error',
        content: String(message),
        level: 'error',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
      }
      return { entries: [errorEntry], turnComplete: false }
    }

    default:
      // Unknown event -- skip silently. The runner logs unknowns at debug level.
      return { entries: [], turnComplete: false }
  }
}

/** Flush any pending blocks as a final assistant entry plus a system entry
 *  carrying duration / cost / token totals. Resets accumulators. Used by
 *  translateEvent on terminal step_finish, and by the caller on subprocess
 *  exit when no terminal step_finish arrived. */
export function flushTurn(state: ParserState): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  if (state.pendingBlocks.length > 0) {
    const assistant: TranscriptAssistantEntry = {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: state.pendingBlocks,
        ...(state.inputTokens || state.outputTokens
          ? {
              usage: {
                input_tokens: state.inputTokens,
                output_tokens: state.outputTokens,
                ...(state.cacheReadTokens ? { cache_read_input_tokens: state.cacheReadTokens } : {}),
                ...(state.cacheWriteTokens ? { cache_creation_input_tokens: state.cacheWriteTokens } : {}),
              },
            }
          : {}),
      },
    }
    entries.push(assistant)
  }
  const durationMs = Date.now() - state.turnStartedAt
  // Even with no blocks, emit a turn_duration so the dashboard's "turn cost"
  // panel updates. Cost may be zero (free model) -- still useful telemetry.
  const sysEntry: TranscriptSystemEntry = {
    type: 'system',
    subtype: 'turn_duration',
    durationMs,
    content: formatTurnSummary(state, durationMs),
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
  entries.push(sysEntry)

  // Reset for the next turn (sessionId persists -- it's the resume key).
  const sessionId = state.sessionId
  Object.assign(state, createParserState())
  state.sessionId = sessionId

  return entries
}

function formatTurnSummary(state: ParserState, durationMs: number): string {
  const parts: string[] = []
  parts.push(`${state.stepCount} step${state.stepCount === 1 ? '' : 's'}`)
  parts.push(`${formatDuration(durationMs)}`)
  if (state.inputTokens || state.outputTokens) {
    parts.push(`${state.inputTokens}/${state.outputTokens} tok`)
  }
  if (state.cost > 0) {
    parts.push(`$${state.cost.toFixed(4)}`)
  }
  return parts.join(' · ')
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const remS = Math.round(s - m * 60)
  return `${m}m${remS}s`
}

/**
 * NDJSON line parser. Splits on \n, JSON.parses each non-empty line, calls
 * the visitor. Tolerates partial lines across calls (caller passes the
 * remaining buffer back in). Returns the unparsed tail.
 */
export function parseNdjsonChunk(chunk: string, carry: string, visit: (event: OpenCodeEvent) => void): string {
  let buffer = carry + chunk
  let nl = buffer.indexOf('\n')
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (line.length > 0) {
      try {
        const event = JSON.parse(line) as OpenCodeEvent
        visit(event)
      } catch {
        // Malformed line -- emit as an error event so the caller surfaces it.
        visit({ type: 'error', message: `Malformed NDJSON: ${line.slice(0, 200)}` } as OpenCodeError)
      }
    }
    nl = buffer.indexOf('\n')
  }
  return buffer
}
