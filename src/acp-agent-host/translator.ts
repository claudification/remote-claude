/**
 * ACP `session/update` notifications -> Claudwerk transcript entries.
 *
 * The shape we produce matches what the existing dashboard renders for
 * Claude and OpenCode-NDJSON conversations: `TranscriptAssistantEntry` with
 * text/thinking/tool_use/tool_result content blocks, plus a closing
 * `TranscriptSystemEntry` of subtype `turn_duration` carrying cost/tokens.
 *
 * Aggregation pattern (mirrors src/opencode-agent-host/ndjson-parser.ts):
 *   - One `TranslatorState` per running prompt turn.
 *   - `applyUpdate()` is called for each `session/update` notification; it
 *     mutates state and returns any entries that should be flushed
 *     immediately (currently empty -- all output is held until flushTurn).
 *   - `flushTurn()` is called when `session/prompt` resolves; it produces
 *     the final assistant + turn_duration entries and resets state.
 *
 * Streaming-friendly: incremental flushes (e.g., emit assistant entry on
 * partial text) can be added later without changing the public surface.
 * For now we hold until turn end -- matches NDJSON semantics and avoids
 * partial-entry rendering bugs the dashboard hasn't been hardened against.
 *
 * Pure module: no I/O, no Bun-specifics, no broker types beyond the shared
 * TranscriptEntry types. Easy to unit-test with synthetic event streams
 * (see translator.test.ts and the spike artifacts in
 * .claude/docs/spike-acp-opencode/).
 */

import { randomUUID } from 'node:crypto'
import type {
  TranscriptAssistantEntry,
  TranscriptContentBlock,
  TranscriptEntry,
  TranscriptSystemEntry,
} from '../shared/protocol'

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
  rawOutput?: { output?: string; metadata?: { exit?: number; truncated?: boolean; description?: string; output?: string } }
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

/**
 * Live tool-call we've seen via `tool_call` but not yet flushed (still
 * accumulating updates). Keyed by toolCallId.
 */
interface PendingToolCall {
  toolCallId: string
  name: string
  input: Record<string, unknown>
  output: string
  isError: boolean
  status: string
  /** Index in `pendingBlocks` of the tool_use block we already pushed.
   *  null means we haven't pushed it yet. */
  toolUseBlockIdx: number | null
  /** Index in `pendingBlocks` of the tool_result block. null until completed. */
  toolResultBlockIdx: number | null
}

export interface TranslatorState {
  /** Accumulated content blocks for the current turn. Emitted as a single
   *  TranscriptAssistantEntry on flushTurn. */
  pendingBlocks: TranscriptContentBlock[]
  /** Index of the last text block (for chunk coalescing). */
  lastTextBlockIdx: number | null
  /** Index of the last thinking block (for chunk coalescing). */
  lastThinkingBlockIdx: number | null
  /** Active tool calls keyed by toolCallId. */
  toolCalls: Map<string, PendingToolCall>
  /** Cost amount in USD (or whatever the agent reports; we trust currency
   *  but normalize at display time). */
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
}

export function createTranslatorState(): TranslatorState {
  return {
    pendingBlocks: [],
    lastTextBlockIdx: null,
    lastThinkingBlockIdx: null,
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
  }
}

// ─── Apply ───────────────────────────────────────────────────────────────

export interface TranslatorOutput {
  /** Entries to flush immediately. Currently always empty -- we hold until
   *  flushTurn -- but reserved for future per-event flushing. */
  entries: TranscriptEntry[]
}

/**
 * Mutate state given one ACP session/update notification. Unknown subtypes
 * are silently ignored (defensive against future ACP additions).
 */
export function applyUpdate(params: AcpSessionUpdateParams, state: TranslatorState): TranslatorOutput {
  const update = params.update
  switch ((update as { sessionUpdate?: string }).sessionUpdate) {
    case 'agent_message_chunk':
      handleAgentMessageChunk(update as AcpAgentMessageChunk, state)
      return { entries: [] }
    case 'agent_thought_chunk':
      handleAgentThoughtChunk(update as AcpAgentThoughtChunk, state)
      return { entries: [] }
    case 'tool_call':
      handleToolCall(update as AcpToolCallEvent, state)
      return { entries: [] }
    case 'tool_call_update':
      handleToolCallUpdate(update as AcpToolCallUpdateEvent, state)
      return { entries: [] }
    case 'usage_update':
      handleUsageUpdate(update as AcpUsageUpdate, state)
      return { entries: [] }
    default:
      // available_commands_update, current_mode_update, config_option_update,
      // plan -- ignored for transcript synthesis. Host surfaces these via a
      // separate channel (broker `agentHostMeta` updates).
      return { entries: [] }
  }
}

function handleAgentMessageChunk(update: AcpAgentMessageChunk, state: TranslatorState): void {
  const text = update.content?.text ?? ''
  if (!text) return
  if (state.lastTextBlockIdx !== null) {
    const block = state.pendingBlocks[state.lastTextBlockIdx]
    if (block && block.type === 'text') {
      block.text = (block.text ?? '') + text
      return
    }
  }
  state.pendingBlocks.push({ type: 'text', text })
  state.lastTextBlockIdx = state.pendingBlocks.length - 1
  // A new text block ends any active thinking block (coalescing-wise).
  state.lastThinkingBlockIdx = null
}

function handleAgentThoughtChunk(update: AcpAgentThoughtChunk, state: TranslatorState): void {
  const text = update.content?.text ?? ''
  if (!text) return
  if (state.lastThinkingBlockIdx !== null) {
    const block = state.pendingBlocks[state.lastThinkingBlockIdx]
    if (block && block.type === 'thinking') {
      block.thinking = (block.thinking ?? '') + text
      return
    }
  }
  state.pendingBlocks.push({ type: 'thinking', thinking: text })
  state.lastThinkingBlockIdx = state.pendingBlocks.length - 1
  state.lastTextBlockIdx = null
}

function handleToolCall(update: AcpToolCallEvent, state: TranslatorState): void {
  if (!update.toolCallId) return
  // First sighting -- pre-create the pending state. We don't push the
  // tool_use block yet because we may not have rawInput; tool_call_update
  // typically arrives with the args populated.
  const existing = state.toolCalls.get(update.toolCallId)
  if (existing) return
  const pending: PendingToolCall = {
    toolCallId: update.toolCallId,
    name: update.title || update.kind || 'tool',
    input: (update.rawInput as Record<string, unknown> | undefined) ?? {},
    output: '',
    isError: false,
    status: update.status ?? 'pending',
    toolUseBlockIdx: null,
    toolResultBlockIdx: null,
  }
  state.toolCalls.set(update.toolCallId, pending)
  // Reset coalescing pointers -- a tool boundary ends the current text run.
  state.lastTextBlockIdx = null
  state.lastThinkingBlockIdx = null
}

function handleToolCallUpdate(update: AcpToolCallUpdateEvent, state: TranslatorState): void {
  if (!update.toolCallId) return
  let pending = state.toolCalls.get(update.toolCallId)
  if (!pending) {
    // Update arrived without a preceding tool_call -- create on the fly.
    pending = {
      toolCallId: update.toolCallId,
      name: update.title || update.kind || 'tool',
      input: {},
      output: '',
      isError: false,
      status: update.status ?? 'pending',
      toolUseBlockIdx: null,
      toolResultBlockIdx: null,
    }
    state.toolCalls.set(update.toolCallId, pending)
  }
  if (update.title) pending.name = update.title
  if (update.kind && !pending.name) pending.name = update.kind
  if (update.rawInput && typeof update.rawInput === 'object') {
    pending.input = update.rawInput as Record<string, unknown>
  }
  if (update.status) pending.status = update.status

  // Push the tool_use block as soon as we have rawInput (the model's intent
  // is now visible). Once pushed, we update name/input in place if they
  // change later. The tool_use block has a stable identity tied to toolCallId.
  if (pending.toolUseBlockIdx === null && Object.keys(pending.input).length > 0) {
    const block: TranscriptContentBlock = {
      type: 'tool_use',
      id: pending.toolCallId,
      name: pending.name,
      input: pending.input,
    }
    state.pendingBlocks.push(block)
    pending.toolUseBlockIdx = state.pendingBlocks.length - 1
    state.lastTextBlockIdx = null
    state.lastThinkingBlockIdx = null
  } else if (pending.toolUseBlockIdx !== null) {
    // Update name/input in place -- the model may refine args mid-call.
    const block = state.pendingBlocks[pending.toolUseBlockIdx]
    if (block && block.type === 'tool_use') {
      block.name = pending.name
      block.input = pending.input
    }
  }

  // Capture intermediate / final output. Streaming tool output arrives as
  // `content: [{ type: 'content', content: { type: 'text', text: '...' } }]`.
  if (Array.isArray(update.content)) {
    const collected = update.content
      .map(c => (c?.content && typeof c.content === 'object' ? c.content.text ?? '' : ''))
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
  }

  // Terminal status -> emit the tool_result block (or attach error if failed).
  if (pending.status === 'completed' || pending.status === 'failed' || pending.status === 'cancelled') {
    if (pending.status === 'failed' || pending.status === 'cancelled') pending.isError = true
    if (pending.toolResultBlockIdx === null) {
      const block: TranscriptContentBlock = {
        type: 'tool_result',
        tool_use_id: pending.toolCallId,
        content: pending.output,
        ...(pending.isError ? { is_error: true } : {}),
      }
      state.pendingBlocks.push(block)
      pending.toolResultBlockIdx = state.pendingBlocks.length - 1
    } else {
      // Update existing result with the final content.
      const block = state.pendingBlocks[pending.toolResultBlockIdx]
      if (block && block.type === 'tool_result') {
        block.content = pending.output
        if (pending.isError) block.is_error = true
      }
    }
    state.lastTextBlockIdx = null
    state.lastThinkingBlockIdx = null
  }
}

function handleUsageUpdate(update: AcpUsageUpdate, state: TranslatorState): void {
  if (update.cost && typeof update.cost.amount === 'number') {
    // ACP spec emits cumulative usage; replace, don't add.
    state.cost = update.cost.amount
    state.costCurrency = update.cost.currency || state.costCurrency
  }
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
 * End-of-turn flush: produce the final entries, reset state for the next
 * turn. Called by the host when `session/prompt` resolves. If pendingBlocks
 * is empty (turn finished with no model output -- unusual), only the
 * turn_duration system entry is emitted.
 */
export function flushTurn(state: TranslatorState): TranscriptEntry[] {
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
  entries.push(sysEntry)

  // Reset for next turn.
  Object.assign(state, createTranslatorState())
  return entries
}

function formatTurnSummary(state: TranslatorState, durationMs: number): string {
  const parts: string[] = []
  parts.push(formatDuration(durationMs))
  if (state.inputTokens || state.outputTokens) {
    parts.push(`${state.inputTokens}/${state.outputTokens} tok`)
  }
  if (state.cost > 0) {
    const symbol = state.costCurrency === 'USD' ? '$' : (state.costCurrency ? `${state.costCurrency} ` : '$')
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
