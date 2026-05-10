import { describe, expect, it } from 'bun:test'
import {
  applyPromptUsage,
  applyUpdate,
  createTranslatorState,
  flushTurn,
  type AcpSessionUpdateParams,
} from './translator'

const SID = 'ses_test'

function update(u: Record<string, unknown>): AcpSessionUpdateParams {
  return { sessionId: SID, update: u as never }
}

describe('translator: agent_message_chunk', () => {
  it('coalesces consecutive chunks into one text block', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello, ' } }), s)
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } }), s)
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '!' } }), s)
    expect(s.pendingBlocks).toEqual([{ type: 'text', text: 'Hello, world!' }])
  })

  it('ignores empty text chunks', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }), s)
    expect(s.pendingBlocks).toEqual([])
  })
})

describe('translator: agent_thought_chunk', () => {
  it('coalesces consecutive thought chunks into one thinking block', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I should ' } }), s)
    applyUpdate(update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'do X' } }), s)
    expect(s.pendingBlocks).toEqual([{ type: 'thinking', thinking: 'I should do X' }])
  })

  it('a text chunk after a thought breaks the coalescing run', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking ' } }), s)
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replying' } }), s)
    applyUpdate(update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ' more' } }), s)
    expect(s.pendingBlocks).toEqual([
      { type: 'thinking', thinking: 'thinking ' },
      { type: 'text', text: 'replying' },
      { type: 'thinking', thinking: ' more' },
    ])
  })
})

describe('translator: tool_call lifecycle', () => {
  it('emits tool_use + tool_result for a successful bash invocation', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'tool_call', toolCallId: 'call_1', status: 'pending', kind: 'execute', title: 'bash', rawInput: {} }), s)
    applyUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress', kind: 'execute', title: 'bash', rawInput: { command: 'ls' } }), s)
    applyUpdate(update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      kind: 'execute',
      title: 'List files',
      rawInput: { command: 'ls' },
      rawOutput: { output: 'file1\nfile2\n', metadata: { exit: 0, truncated: false } },
    }), s)

    expect(s.pendingBlocks).toHaveLength(2)
    expect(s.pendingBlocks[0]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'List files',
      input: { command: 'ls' },
    })
    expect(s.pendingBlocks[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_1',
      content: 'file1\nfile2\n',
    })
  })

  it('marks tool_result with is_error on failed tool call', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed', rawInput: { command: 'doomed' }, rawOutput: { output: 'permission denied', metadata: { exit: 1 } } }), s)
    const result = s.pendingBlocks.find(b => b.type === 'tool_result')
    expect(result).toBeDefined()
    expect(result?.is_error).toBe(true)
    expect(result?.content).toBe('permission denied')
  })

  it('marks is_error on non-zero exit even without explicit failed status', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawInput: { command: 'x' }, rawOutput: { output: 'oh no', metadata: { exit: 7 } } }), s)
    const result = s.pendingBlocks.find(b => b.type === 'tool_result')
    expect(result?.is_error).toBe(true)
  })

  it('handles tool_call_update without preceding tool_call (defensive)', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'orphan', status: 'completed', kind: 'read', title: 'read', rawInput: { path: '/x' }, rawOutput: { output: 'data' } }), s)
    expect(s.pendingBlocks).toHaveLength(2)
    expect(s.pendingBlocks[0].type).toBe('tool_use')
    expect(s.pendingBlocks[1].type).toBe('tool_result')
  })

  it('captures intermediate streaming content from update.content', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress', rawInput: { command: 'ls' } }), s)
    applyUpdate(update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'in_progress',
      rawInput: { command: 'ls' },
      content: [{ type: 'content', content: { type: 'text', text: 'partial output\n' } }],
    }), s)
    applyUpdate(update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      rawInput: { command: 'ls' },
      rawOutput: { output: 'final output\n', metadata: { exit: 0 } },
    }), s)
    const result = s.pendingBlocks.find(b => b.type === 'tool_result')
    // rawOutput supersedes intermediate streamed content.
    expect(result?.content).toBe('final output\n')
  })

  it('text chunk after tool_use does not coalesce with pre-tool text', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before' } }), s)
    applyUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawInput: { x: 1 }, rawOutput: { output: 'y' } }), s)
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } }), s)
    const texts = s.pendingBlocks.filter(b => b.type === 'text').map(b => b.text)
    expect(texts).toEqual(['before', 'after'])
  })
})

describe('translator: usage_update + applyPromptUsage', () => {
  it('records cost amount and currency', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'usage_update', cost: { amount: 0.01234, currency: 'USD' } }), s)
    expect(s.cost).toBeCloseTo(0.01234)
    expect(s.costCurrency).toBe('USD')
  })

  it('records token totals from session/prompt usage', () => {
    const s = createTranslatorState()
    applyPromptUsage({ inputTokens: 100, outputTokens: 50, cachedReadTokens: 1000 }, s)
    expect(s.inputTokens).toBe(100)
    expect(s.outputTokens).toBe(50)
    expect(s.cacheReadTokens).toBe(1000)
  })
})

describe('translator: flushTurn output', () => {
  it('emits TranscriptAssistantEntry + system turn_duration with combined cost/tokens', () => {
    const s = createTranslatorState()
    s.turnStartedAt = Date.now() - 1500 // simulate 1.5s turn
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } }), s)
    applyUpdate(update({ sessionUpdate: 'usage_update', cost: { amount: 0.0042, currency: 'USD' } }), s)
    applyPromptUsage({ inputTokens: 100, outputTokens: 5 }, s)
    s.stopReason = 'end_turn'

    const entries = flushTurn(s)
    expect(entries).toHaveLength(2)
    const [assistant, sys] = entries
    expect(assistant.type).toBe('assistant')
    expect((assistant as { message?: { content?: unknown[] } }).message?.content).toEqual([{ type: 'text', text: 'Done.' }])
    expect((assistant as { message?: { usage?: { input_tokens?: number; output_tokens?: number } } }).message?.usage).toEqual({
      input_tokens: 100,
      output_tokens: 5,
    })
    expect(sys.type).toBe('system')
    expect((sys as { subtype?: string }).subtype).toBe('turn_duration')
    expect((sys as { content?: string }).content).toMatch(/100\/5 tok/)
    expect((sys as { content?: string }).content).toMatch(/\$0\.0042/)
    // stopReason is intentionally NOT carried on the system entry to keep
    // transcripts vendor-neutral (ACP emits Claude-flavored 'end_turn'
    // values that would leak into OpenCode/Codex/Gemini conversations).
    expect((sys as { stopReason?: string }).stopReason).toBeUndefined()
  })

  it('emits only turn_duration when no content was produced', () => {
    const s = createTranslatorState()
    const entries = flushTurn(s)
    expect(entries).toHaveLength(1)
    expect(entries[0].type).toBe('system')
  })

  it('resets state for the next turn', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A' } }), s)
    flushTurn(s)
    expect(s.pendingBlocks).toEqual([])
    expect(s.cost).toBe(0)
    expect(s.toolCalls.size).toBe(0)
  })
})

describe('translator: unknown / ignored update subtypes', () => {
  it('silently ignores available_commands_update / current_mode_update / config_option_update / plan / unknown', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'init' }] }), s)
    applyUpdate(update({ sessionUpdate: 'current_mode_update', currentModeId: 'edit' }), s)
    applyUpdate(update({ sessionUpdate: 'config_option_update', configId: 'model', currentValue: 'x' }), s)
    applyUpdate(update({ sessionUpdate: 'plan', entries: [{ content: 'do thing' }] }), s)
    applyUpdate(update({ sessionUpdate: 'totally_made_up' }), s)
    expect(s.pendingBlocks).toEqual([])
    expect(s.cost).toBe(0)
  })
})

describe('translator: end-to-end against spike-shaped events', () => {
  it('matches the shape produced from the Phase A run', () => {
    // Lifted from .claude/docs/spike-acp-opencode/session-update-stream.json.
    const s = createTranslatorState()

    // 7 thought chunks
    for (const t of ['The', ' user wants me to', ' list files using', ' `ls` via', ' bash', ' and then say done', '.']) {
      applyUpdate(update({ sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: { type: 'text', text: t } }), s)
    }
    // tool_call pending
    applyUpdate(update({ sessionUpdate: 'tool_call', toolCallId: 'call_aa86', status: 'pending', kind: 'execute', title: 'bash', rawInput: {} }), s)
    // in_progress with rawInput
    applyUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_aa86', status: 'in_progress', kind: 'execute', title: 'bash', rawInput: { command: 'ls', description: 'List files' } }), s)
    // completed with rawOutput
    applyUpdate(update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_aa86',
      status: 'completed',
      kind: 'execute',
      title: 'List files in current directory',
      rawInput: { command: 'ls', description: 'List files in current directory' },
      rawOutput: { output: 'backups\nbin\n', metadata: { exit: 0, truncated: false } },
    }), s)
    // assistant message chunk
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'Done.' } }), s)
    // usage_update
    applyUpdate(update({ sessionUpdate: 'usage_update', used: 24460, size: 202752, cost: { amount: 0.04055548, currency: 'USD' } }), s)
    applyPromptUsage({ inputTokens: 140, outputTokens: 3 }, s)
    s.stopReason = 'end_turn'

    const entries = flushTurn(s)
    expect(entries).toHaveLength(2)
    const [assistant, sys] = entries
    const blocks = (assistant as { message?: { content?: Array<{ type: string }> } }).message?.content ?? []
    expect(blocks.map(b => b.type)).toEqual(['thinking', 'tool_use', 'tool_result', 'text'])
    expect((sys as { content?: string }).content).toMatch(/140\/3 tok/)
    expect((sys as { content?: string }).content).toMatch(/\$0\.0406/)
  })
})
