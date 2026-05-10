/**
 * ACP `session/update` notifications -> Claudwerk transcript entries + live
 * stream deltas.
 *
 * Streaming model (the FLOW):
 *   - Token-level text/thinking are mirrored to `stream_delta` SSE events
 *     (Anthropic-shaped) so the dashboard's live "streaming" buffer renders
 *     them as the model types. Same wire shape headless CC + chat-api use.
 *   - Each text/thinking RUN (a contiguous streak of message/thought chunks
 *     not interrupted by a tool call) is committed as ONE write-once
 *     assistant entry the moment the run ends -- on tool boundary or at
 *     end-of-turn. UUIDs are stable per run; entries are sent exactly once.
 *   - Each tool_use is committed as its own write-once assistant entry the
 *     moment the agent has populated rawInput. The dashboard's tool-call UI
 *     lights up immediately, not at end-of-turn.
 *   - Each tool_result is committed as its own write-once USER entry (paired
 *     by tool_use_id, matching Claude's transcript convention so
 *     buildResultMap renders it next to the tool_use). Committed the moment
 *     the tool reaches a terminal status (completed / failed / cancelled).
 *   - flushTurn closes any in-flight text run, emits a `message_stop` to
 *     clear the live buffer, and emits the turn_duration system entry.
 *
 * State accumulators (cost, tokens, lastTextBlockIdx, ...) reset per turn.
 * The translator is pure (no I/O); the host is responsible for actually
 * dispatching the stream_delta wire messages and transcript_entries flushes.
 *
 * Pure module: no I/O, no Bun-specifics, no broker types beyond the shared
 * TranscriptEntry types. Easy to unit-test with synthetic event streams
 * (see translator.test.ts).
 */

import { randomUUID } from 'node:crypto'
import type {
  TranscriptAssistantEntry,
  TranscriptContentBlock,
  TranscriptEntry,
  TranscriptSystemEntry,
  TranscriptUserEntry,
} from '../shared/protocol'
import { translateAcpToolResult, translateAcpToolUse } from './dialect/from-acp'

// ─── Inbound shapes ──────────────────────────────────────────────────────

/** Generic ACP session/update params envelope. */
export interface AcpSessionUpdateParams {
  sessionId: string
  update: AcpSessionUpdate
}

export type AcpSessionUpdate =
  | AcpAgentMessageChunk
  | AcpAgentThoughtChunk
  | AcpToolCallEvent
  | AcpToolCallUpdateEvent
  | AcpUsageUpdate
  | AcpAvailableCommandsUpdate
  | AcpCurrentModeUpdate
  | AcpConfigOptionUpdate
  | AcpPlanUpdate
  | { sessionUpdate: string; [k: string]: unknown }

export interface AcpAgentMessageChunk {
  sessionUpdate: 'agent_message_chunk'
  messageId?: string
  content: AcpContentBlock
}
export interface AcpAgentThoughtChunk {
  sessionUpdate: 'agent_thought_chunk'
  messageId?: string
  content: AcpContentBlock
}

export interface AcpContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
}

export interface AcpToolCallEvent {
  sessionUpdate: 'tool_call'
  toolCallId: string
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | string
  title?: string
  kind?: string
  rawInput?: unknown
  locations?: unknown
}

export interface AcpToolCallUpdateEvent {
  sessionUpdate: 'tool_call_update'
  toolCallId: string
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | string
  title?: string
  kind?: string
  rawInput?: unknown
  rawOutput?: {
    output?: string
    metadata?: { exit?: number; truncated?: boolean; description?: string; output?: string }
  }
  content?: Array<{ type: string; content?: AcpContentBlock }>
}

export interface AcpUsageUpdate {
  sessionUpdate: 'usage_update'
  used?: number
  size?: number
  cost?: { amount: number; currency: string }
}

export interface AcpAvailableCommandsUpdate {
  sessionUpdate: 'available_commands_update'
  availableCommands: Array<{ name: string; description?: string }>
}

export interface AcpCurrentModeUpdate {
  sessionUpdate: 'current_mode_update'
  currentModeId?: string
}

export interface AcpConfigOptionUpdate {
  sessionUpdate: 'config_option_update'
  configId?: string
  currentValue?: unknown
}

export interface AcpPlanUpdate {
  sessionUpdate: 'plan'
  entries?: Array<{ content?: string; status?: string; priority?: string }>
}

// ─── State ───────────────────────────────────────────────────────────────

/** Tool call we've seen via `tool_call` / `tool_call_update`. The tool_use
 *  block is committed (with UUID `useEntryUuid`) the moment rawInput is
 *  populated. The tool_result block is committed (with UUID `resultEntryUuid`)
 *  the moment status reaches a terminal value. */
interface PendingToolCall {
  toolCallId: string
  /** The stable tool name for the transcript (captured from the first title/kind
   *  that looks like a tool name, NOT a human-readable description). Once set,
   *  subsequent updates that change title to a description string are ignored. */
  name: string
  input: Record<string, unknown>
  output: string
  isError: boolean
  status: string
  /** Verbatim ACP `rawOutput` envelope from the most recent tool_call_update.
   *  Preserved for the dialect translator's result envelope (and `block.raw`)
   *  so things like exit code, truncation, and arbitrary metadata never get
   *  dropped during commit. */
  rawOutput?: unknown
  rawOutputMetadata?: { exit?: number; truncated?: boolean; description?: string; output?: string }
  /** Verbatim `locations` array from the original tool_call event (opencode
   *  ships file refs here; preserved into raw so the dashboard can render
   *  them later). */
  locations?: unknown
  /** Stable UUID for the assistant entry we'll emit (or already emitted). */
  useEntryUuid: string
  /** Stable UUID for the user entry carrying the tool_result. */
  resultEntryUuid: string
  /** True once the tool_use assistant entry has been emitted. */
  useCommitted: boolean
  /** True once the tool_result user entry has been emitted. */
  resultCommitted: boolean
}

export interface TranslatorState {
  /** Blocks accumulated for the current text/thinking run. Flushed as one
   *  assistant entry on tool boundary or end-of-turn. */
  pendingBlocks: TranscriptContentBlock[]
  /** Stable UUID for the assistant entry that will commit pendingBlocks. */
  activeRunUuid: string | null
  /** Index of the last text block in pendingBlocks (for chunk coalescing). */
  lastTextBlockIdx: number | null
  /** Index of the last thinking block in pendingBlocks. */
  lastThinkingBlockIdx: number | null
  /** True once we've emitted `message_start` for the current run. */
  streamRunActive: boolean
  /** Active tool calls keyed by toolCallId. */
  toolCalls: Map<string, PendingToolCall>
  /** Cost amount in USD (or whatever the agent reports). */
  cost: number
  costCurrency: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** Wall-clock turn start, for duration reporting. */
  turnStartedAt: number
  /** Optional stopReason from the session/prompt response, set by host
   *  before flushTurn() if available. */
  stopReason: string | null
  /** ACP agent name (e.g. 'opencode', 'codex', 'gemini-acp'). Threaded
   *  into the dialect translator so each tool block carries the right
   *  `acp:<agent>` backend identifier in `block.raw`. */
  acpAgent: string
}

export function createTranslatorState(opts?: { acpAgent?: string }): TranslatorState {
  return {
    pendingBlocks: [],
    activeRunUuid: null,
    lastTextBlockIdx: null,
    lastThinkingBlockIdx: null,
    streamRunActive: false,
    toolCalls: new Map(),
    cost: 0,
    costCurrency: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    turnStartedAt: Date.now(),
    stopReason: null,
    acpAgent: opts?.acpAgent ?? 'acp',
  }
}

// ─── Apply ───────────────────────────────────────────────────────────────

export interface TranslatorOutput {
  /** Transcript entries to flush right now (write-once, stable UUIDs). */
  entries: TranscriptEntry[]
  /** Anthropic-shaped SSE events to emit as `stream_delta` messages. */
  streamDeltas: Record<string, unknown>[]
}

function emptyOutput(): TranslatorOutput {
  return { entries: [], streamDeltas: [] }
}

/** Resolve the stable tool name from ACP's `title` and `kind` fields.
 *
 *  OpenCode sends `title` with changing semantics across the tool lifecycle:
 *  - `pending`/`in_progress`: title = tool name (e.g. "read", "bash", "grep")
 *  - `completed`:           title = description (e.g. "src/foo/bar.ts")
 *
 *  We assume a title that contains `/`, `.`, or spaces is a description, not a
 *  tool name. The ACP `kind` field is stable but uses different categories
 *  ("read", "edit", "execute", "search", "other") so we use it only as a
 *  last resort. */
function resolveToolName(title: string | undefined, kind: string | undefined): string {
  if (title && !/[/.]/.test(title) && !title.includes(' ')) return title
  if (kind) return kind
  return 'tool'
}

/**
 * Mutate state given one ACP session/update notification. Returns any
 * transcript entries to commit and any stream deltas to broadcast.
 * Unknown subtypes are silently ignored (defensive against future ACP
 * additions).
 */
export function applyUpdate(params: AcpSessionUpdateParams, state: TranslatorState): TranslatorOutput {
  const update = params.update
  switch ((update as { sessionUpdate?: string }).sessionUpdate) {
    case 'agent_message_chunk':
      return handleAgentMessageChunk(update as AcpAgentMessageChunk, state)
    case 'agent_thought_chunk':
      return handleAgentThoughtChunk(update as AcpAgentThoughtChunk, state)
    case 'tool_call':
      return handleToolCall(update as AcpToolCallEvent, state)
    case 'tool_call_update':
      return handleToolCallUpdate(update as AcpToolCallUpdateEvent, state)
    case 'usage_update':
      handleUsageUpdate(update as AcpUsageUpdate, state)
      return emptyOutput()
    default:
      // available_commands_update, current_mode_update, config_option_update,
      // plan -- ignored for transcript synthesis. Host surfaces these via a
      // separate channel (broker `agentHostMeta` updates).
      return emptyOutput()
  }
}

function ensureActiveRun(state: TranslatorState, out: TranslatorOutput): void {
  if (state.activeRunUuid !== null) return
  state.activeRunUuid = randomUUID()
  state.streamRunActive = true
  // message_start resets the dashboard's streamingText buffer if it has
  // leftover content from a prior run we already committed.
  out.streamDeltas.push({ type: 'message_start', message: { role: 'assistant' } })
}

function handleAgentMessageChunk(update: AcpAgentMessageChunk, state: TranslatorState): TranslatorOutput {
  const text = update.content?.text ?? ''
  if (!text) return emptyOutput()
  const out = emptyOutput()
  ensureActiveRun(state, out)
  if (state.lastTextBlockIdx !== null) {
    const block = state.pendingBlocks[state.lastTextBlockIdx]
    if (block && block.type === 'text') {
      block.text = (block.text ?? '') + text
    }
  } else {
    state.pendingBlocks.push({ type: 'text', text })
    state.lastTextBlockIdx = state.pendingBlocks.length - 1
    state.lastThinkingBlockIdx = null
  }
  out.streamDeltas.push({
    type: 'content_block_delta',
    index: state.lastTextBlockIdx ?? 0,
    delta: { type: 'text_delta', text },
  })
  return out
}

function handleAgentThoughtChunk(update: AcpAgentThoughtChunk, state: TranslatorState): TranslatorOutput {
  const text = update.content?.text ?? ''
  if (!text) return emptyOutput()
  const out = emptyOutput()
  ensureActiveRun(state, out)
  if (state.lastThinkingBlockIdx !== null) {
    const block = state.pendingBlocks[state.lastThinkingBlockIdx]
    if (block && block.type === 'thinking') {
      block.thinking = (block.thinking ?? '') + text
    }
  } else {
    state.pendingBlocks.push({ type: 'thinking', thinking: text })
    state.lastThinkingBlockIdx = state.pendingBlocks.length - 1
    state.lastTextBlockIdx = null
  }
  out.streamDeltas.push({
    type: 'content_block_delta',
    index: state.lastThinkingBlockIdx ?? 0,
    delta: { type: 'thinking_delta', thinking: text },
  })
  return out
}

function handleToolCall(update: AcpToolCallEvent, state: TranslatorState): TranslatorOutput {
  if (!update.toolCallId) return emptyOutput()
  if (state.toolCalls.has(update.toolCallId)) return emptyOutput()

  // Pre-create the pending state. We don't commit a tool_use entry yet --
  // typically rawInput is empty here and arrives in the first
  // tool_call_update. Reserve UUIDs upfront so re-entry can't double-commit.
  //
  // Name resolution: prefer `title` (tool name) from the initial event, fall
  // back to `kind` (ACP category), then generic "tool". The `title` field
  // changes semantics across the lifecycle: it starts as the tool name on
  // `pending`/`in_progress` but mutates into a human-readable description on
  // `completed`. We freeze the name at first sight to avoid description strings
  // overwriting the tool name in the transcript.
  const pending: PendingToolCall = {
    toolCallId: update.toolCallId,
    name: resolveToolName(update.title, update.kind),
    input: (update.rawInput as Record<string, unknown> | undefined) ?? {},
    output: '',
    isError: false,
    status: update.status ?? 'pending',
    locations: update.locations,
    useEntryUuid: randomUUID(),
    resultEntryUuid: randomUUID(),
    useCommitted: false,
    resultCommitted: false,
  }
  state.toolCalls.set(update.toolCallId, pending)

  // A tool boundary ends the current text/thinking run. Commit it now so it
  // appears in the transcript BEFORE the tool, in the right order.
  const out = emptyOutput()
  flushActiveRun(state, out)

  // If rawInput is already populated (rare for `tool_call` itself), we can
  // also commit the tool_use right now.
  if (Object.keys(pending.input).length > 0) {
    commitToolUse(pending, out, state)
  }
  return out
}

function handleToolCallUpdate(update: AcpToolCallUpdateEvent, state: TranslatorState): TranslatorOutput {
  if (!update.toolCallId) return emptyOutput()
  let pending = state.toolCalls.get(update.toolCallId)
  if (!pending) {
    // Update arrived without a preceding tool_call -- create on the fly.
    pending = {
      toolCallId: update.toolCallId,
      name: resolveToolName(update.title, update.kind),
      input: {},
      output: '',
      isError: false,
      status: update.status ?? 'pending',
      useEntryUuid: randomUUID(),
      resultEntryUuid: randomUUID(),
      useCommitted: false,
      resultCommitted: false,
    }
    state.toolCalls.set(update.toolCallId, pending)
  }
  // Only update name if it hasn't been committed yet AND the new title looks
  // like a tool name rather than a description. Once the tool_use entry is
  // committed the name is frozen in the transcript; we also avoid overwriting
  // a stable tool name with a description string that OpenCode sends at
  // `completed` time (e.g. "src/acp-agent-host/translator.ts" for a `read`
  // tool).
  if (!pending.useCommitted) {
    const candidate = resolveToolName(update.title, update.kind)
    if (candidate && candidate !== pending.name) {
      pending.name = candidate
    }
  }
  if (update.rawInput && typeof update.rawInput === 'object') {
    pending.input = update.rawInput as Record<string, unknown>
  }
  if (update.status) pending.status = update.status

  // Capture intermediate / final output. Streaming tool output arrives as
  // `content: [{ type: 'content', content: { type: 'text', text: '...' } }]`.
  if (Array.isArray(update.content)) {
    const collected = update.content
      .map(c => (c?.content && typeof c.content === 'object' ? (c.content.text ?? '') : ''))
      .join('')
    if (collected.length > 0) pending.output = collected
  }
  // rawOutput is the canonical source for completed tools and supersedes
  // any intermediate streamed content.
  if (update.rawOutput) {
    if (typeof update.rawOutput.output === 'string') pending.output = update.rawOutput.output
    else if (typeof update.rawOutput.metadata?.output === 'string') pending.output = update.rawOutput.metadata.output
    if (typeof update.rawOutput.metadata?.exit === 'number' && update.rawOutput.metadata.exit !== 0) {
      pending.isError = true
    }
    pending.rawOutput = update.rawOutput
    if (update.rawOutput.metadata) pending.rawOutputMetadata = update.rawOutput.metadata
  }

  const out = emptyOutput()

  // Commit the tool_use as soon as we have rawInput populated. The arrival
  // of rawInput is the moment the model's intent is observable.
  if (!pending.useCommitted && Object.keys(pending.input).length > 0) {
    flushActiveRun(state, out)
    commitToolUse(pending, out, state)
  }

  // Terminal status -> commit the tool_result user entry.
  if (pending.status === 'completed' || pending.status === 'failed' || pending.status === 'cancelled') {
    if (pending.status === 'failed' || pending.status === 'cancelled') pending.isError = true
    // Defensive: if rawInput never showed up but we got a terminal status,
    // emit a synthetic tool_use first so the dashboard has something to pair
    // the result against.
    if (!pending.useCommitted) {
      flushActiveRun(state, out)
      commitToolUse(pending, out, state)
    }
    if (!pending.resultCommitted) {
      commitToolResult(pending, out, state)
    }
  }

  return out
}

function handleUsageUpdate(update: AcpUsageUpdate, state: TranslatorState): void {
  if (update.cost && typeof update.cost.amount === 'number') {
    // ACP spec emits cumulative usage; replace, don't add.
    state.cost = update.cost.amount
    state.costCurrency = update.cost.currency || state.costCurrency
  }
}

/** Commit the in-flight text/thinking run as a write-once assistant entry.
 *  Mutates state to reset run pointers and clear pendingBlocks. Emits the
 *  closing `message_stop` so the dashboard's live buffer clears. Safe to
 *  call when no run is active. */
function flushActiveRun(state: TranslatorState, out: TranslatorOutput): void {
  if (state.activeRunUuid !== null && state.pendingBlocks.length > 0) {
    const assistant: TranscriptAssistantEntry = {
      type: 'assistant',
      uuid: state.activeRunUuid,
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: state.pendingBlocks },
    }
    out.entries.push(assistant)
  }
  if (state.streamRunActive) {
    out.streamDeltas.push({ type: 'message_stop' })
    state.streamRunActive = false
  }
  state.activeRunUuid = null
  state.pendingBlocks = []
  state.lastTextBlockIdx = null
  state.lastThinkingBlockIdx = null
}

function commitToolUse(pending: PendingToolCall, out: TranslatorOutput, state: TranslatorState): void {
  if (pending.useCommitted) return
  const block: TranscriptContentBlock = {
    type: 'tool_use',
    id: pending.toolCallId,
    name: pending.name,
    input: pending.input,
  }
  // Translate to canonical CLAUDEWERK shape (kind / canonicalInput / raw).
  // Locations the agent shipped on the original tool_call event would
  // otherwise be dropped here -- preserve them on raw.
  translateAcpToolUse(block, { acpAgent: state.acpAgent })
  if (pending.locations !== undefined && block.raw) {
    ;(block.raw as Record<string, unknown>).locations = pending.locations
  }
  const entry: TranscriptAssistantEntry = {
    type: 'assistant',
    uuid: pending.useEntryUuid,
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [block] },
  }
  out.entries.push(entry)
  pending.useCommitted = true
}

function commitToolResult(pending: PendingToolCall, out: TranslatorOutput, state: TranslatorState): void {
  if (pending.resultCommitted) return
  const block: TranscriptContentBlock = {
    type: 'tool_result',
    tool_use_id: pending.toolCallId,
    content: pending.output,
    ...(pending.isError ? { is_error: true } : {}),
  }
  // Translate to canonical CLAUDEWERK shape (result / raw). Threads
  // pending.rawOutput + metadata so things like exit code survive into
  // the canonical shell envelope -- and the original payload is kept on
  // block.raw verbatim.
  translateAcpToolResult(
    block,
    {
      sourceToolName: pending.name,
      rawOutput: pending.rawOutput,
      metadata: pending.rawOutputMetadata,
    },
    { acpAgent: state.acpAgent },
  )
  const entry: TranscriptUserEntry = {
    type: 'user',
    uuid: pending.resultEntryUuid,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: [block] },
  }
  out.entries.push(entry)
  pending.resultCommitted = true
}

/** Optional: feed token totals from the `session/prompt` response.usage when
 *  the prompt resolves. ACP does not put per-event token counts on the
 *  notification stream, so this is the canonical spot. */
export interface AcpPromptUsage {
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
}

export function applyPromptUsage(usage: AcpPromptUsage, state: TranslatorState): void {
  if (typeof usage.inputTokens === 'number') state.inputTokens = usage.inputTokens
  if (typeof usage.outputTokens === 'number') state.outputTokens = usage.outputTokens
  if (typeof usage.cachedReadTokens === 'number') state.cacheReadTokens = usage.cachedReadTokens
  if (typeof usage.cachedWriteTokens === 'number') state.cacheWriteTokens = usage.cachedWriteTokens
}

// ─── Flush ───────────────────────────────────────────────────────────────

/**
 * End-of-turn flush. Called by the host when `session/prompt` resolves.
 * Closes any in-flight text/thinking run, commits any tools that haven't
 * been finalized yet, attaches the turn's usage to the final assistant
 * entry (if there is one), and emits the turn_duration system entry.
 * Resets state for the next turn.
 *
 * Returns `{ entries, streamDeltas }`. Callers must dispatch the stream
 * deltas (`message_stop` to clear the dashboard's live buffer) and then the
 * transcript entries.
 */
export function flushTurn(state: TranslatorState): TranslatorOutput {
  const out = emptyOutput()

  // Defensive: any tool that's still in-flight at end-of-turn gets committed
  // as-is so the transcript isn't missing entries.
  for (const pending of state.toolCalls.values()) {
    if (!pending.useCommitted && Object.keys(pending.input).length > 0) {
      flushActiveRun(state, out)
      commitToolUse(pending, out, state)
    }
    if (
      !pending.resultCommitted &&
      (pending.status === 'completed' || pending.status === 'failed' || pending.status === 'cancelled')
    ) {
      if (!pending.useCommitted) {
        flushActiveRun(state, out)
        commitToolUse(pending, out, state)
      }
      commitToolResult(pending, out, state)
    }
  }

  // Close the final text/thinking run, attaching turn usage onto its message.
  if (state.activeRunUuid !== null && state.pendingBlocks.length > 0) {
    const assistant: TranscriptAssistantEntry = {
      type: 'assistant',
      uuid: state.activeRunUuid,
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
    out.entries.push(assistant)
  }
  if (state.streamRunActive) {
    out.streamDeltas.push({ type: 'message_stop' })
    state.streamRunActive = false
  }

  const durationMs = Date.now() - state.turnStartedAt
  // The system turn_duration entry is the agnostic "turn ended" signal.
  // We deliberately do NOT carry the agent-specific stopReason here -- ACP
  // emits values like 'end_turn' that look Claude-flavored to dashboards
  // rendering OpenCode/Codex/Gemini conversations. The stopReason is still
  // recoverable from session/prompt result.usage if a future feature needs
  // it; the transcript stays vendor-neutral.
  const sysEntry: TranscriptSystemEntry = {
    type: 'system',
    subtype: 'turn_duration',
    durationMs,
    content: formatTurnSummary(state, durationMs),
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
  out.entries.push(sysEntry)

  // Reset for next turn.
  Object.assign(state, createTranslatorState())
  return out
}

function formatTurnSummary(state: TranslatorState, durationMs: number): string {
  const parts: string[] = []
  parts.push(formatDuration(durationMs))
  if (state.inputTokens || state.outputTokens) {
    parts.push(`${state.inputTokens}/${state.outputTokens} tok`)
  }
  if (state.cost > 0) {
    const symbol = state.costCurrency === 'USD' ? '$' : state.costCurrency ? `${state.costCurrency} ` : '$'
    parts.push(`${symbol}${state.cost.toFixed(4)}`)
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
