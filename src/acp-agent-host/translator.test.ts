import { describe, expect, it } from 'bun:test'
import type {
  TranscriptAssistantEntry,
  TranscriptContentBlock,
  TranscriptSystemEntry,
  TranscriptUserEntry,
} from '../shared/protocol'
import {
  type AcpSessionUpdateParams,
  applyPromptUsage,
  applyUpdate,
  createTranslatorState,
  flushTurn,
} from './translator'

const SID = 'ses_test'

function update(u: Record<string, unknown>): AcpSessionUpdateParams {
  return { sessionId: SID, update: u as never }
}

describe('translator: agent_message_chunk streaming', () => {
  it('coalesces consecutive chunks into one text block, no commit until run ends', () => {
    const s = createTranslatorState()
    const o1 = applyUpdate(
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello, ' } }),
      s,
    )
    const o2 = applyUpdate(
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } }),
      s,
    )
    const o3 = applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '!' } }), s)
    expect(s.pendingBlocks).toEqual([{ type: 'text', text: 'Hello, world!' }])
    // No transcript entries committed mid-run.
    expect(o1.entries).toEqual([])
    expect(o2.entries).toEqual([])
    expect(o3.entries).toEqual([])
    // First chunk emits message_start; every chunk emits content_block_delta(text_delta).
    expect(o1.streamDeltas[0]).toMatchObject({ type: 'message_start' })
    const allDeltas = [...o1.streamDeltas, ...o2.streamDeltas, ...o3.streamDeltas]
    const textDeltas = allDeltas
      .filter(d => d.type === 'content_block_delta')
      .map(d => (d as { delta: { type: string; text: string } }).delta)
    expect(textDeltas).toEqual([
      { type: 'text_delta', text: 'Hello, ' },
      { type: 'text_delta', text: 'world' },
      { type: 'text_delta', text: '!' },
    ])
  })

  it('ignores empty text chunks (no delta, no entry, no run start)', () => {
    const s = createTranslatorState()
    const o = applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }), s)
    expect(s.pendingBlocks).toEqual([])
    expect(s.activeRunUuid).toBeNull()
    expect(o.entries).toEqual([])
    expect(o.streamDeltas).toEqual([])
  })
})

describe('translator: agent_thought_chunk streaming', () => {
  it('coalesces thoughts into one thinking block + emits thinking_delta', () => {
    const s = createTranslatorState()
    const o1 = applyUpdate(
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I should ' } }),
      s,
    )
    const o2 = applyUpdate(update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'do X' } }), s)
    expect(s.pendingBlocks).toEqual([{ type: 'thinking', thinking: 'I should do X' }])
    expect(o1.streamDeltas[0]).toMatchObject({ type: 'message_start' })
    const thinkingDeltas = [...o1.streamDeltas, ...o2.streamDeltas]
      .filter(d => d.type === 'content_block_delta')
      .map(d => (d as { delta: { type: string; thinking: string } }).delta)
    expect(thinkingDeltas).toEqual([
      { type: 'thinking_delta', thinking: 'I should ' },
      { type: 'thinking_delta', thinking: 'do X' },
    ])
  })

  it('text chunk after a thought breaks the coalescing run within the same assistant entry', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking ' } }), s)
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replying' } }), s)
    applyUpdate(update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ' more' } }), s)
    expect(s.pendingBlocks).toEqual([
      { type: 'thinking', thinking: 'thinking ' },
      { type: 'text', text: 'replying' },
      { type: 'thinking', thinking: ' more' },
    ])
    // Single run -- no entries committed.
    expect(s.activeRunUuid).not.toBeNull()
  })
})

describe('translator: tool_call lifecycle (live commits)', () => {
  it('commits tool_use as soon as rawInput populated, then tool_result on completed', () => {
    const s = createTranslatorState()
    const o1 = applyUpdate(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        status: 'pending',
        kind: 'execute',
        title: 'bash',
        rawInput: {},
      }),
      s,
    )
    expect(o1.entries).toEqual([])

    const o2 = applyUpdate(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'in_progress',
        kind: 'execute',
        title: 'bash',
        rawInput: { command: 'ls' },
      }),
      s,
    )
    expect(o2.entries).toHaveLength(1)
    const toolUseEntry = o2.entries[0] as TranscriptAssistantEntry
    expect(toolUseEntry.type).toBe('assistant')
    expect(toolUseEntry.message?.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls' } },
    ])
    expect(toolUseEntry.uuid).toBeTruthy()

    const o3 = applyUpdate(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'completed',
        kind: 'execute',
        title: 'List files',
        rawInput: { command: 'ls' },
        rawOutput: { output: 'file1\nfile2\n', metadata: { exit: 0, truncated: false } },
      }),
      s,
    )
    expect(o3.entries).toHaveLength(1)
    const resultEntry = o3.entries[0] as TranscriptUserEntry
    expect(resultEntry.type).toBe('user')
    expect(resultEntry.message?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: 'file1\nfile2\n' },
    ])
    expect(resultEntry.uuid).toBeTruthy()
    expect(resultEntry.uuid).not.toBe(toolUseEntry.uuid)
  })

  it('commits in-flight text BEFORE tool_use so transcript order is preserved', () => {
    const s = createTranslatorState()
    applyUpdate(
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'About to run ls.' } }),
      s,
    )
    const out = applyUpdate(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'in_progress',
        rawInput: { command: 'ls' },
      }),
      s,
    )
    expect(out.entries).toHaveLength(2)
    const [textEntry, toolEntry] = out.entries as [TranscriptAssistantEntry, TranscriptAssistantEntry]
    expect(textEntry.type).toBe('assistant')
    expect((textEntry.message?.content as TranscriptContentBlock[])[0]).toMatchObject({
      type: 'text',
      text: 'About to run ls.',
    })
    expect(toolEntry.type).toBe('assistant')
    expect((toolEntry.message?.content as TranscriptContentBlock[])[0]).toMatchObject({ type: 'tool_use' })
    // Closing message_stop should be in stream deltas (clear live buffer).
    expect(out.streamDeltas).toContainEqual({ type: 'message_stop' })
  })

  it('marks tool_result with is_error on failed tool_call_update', () => {
    const s = createTranslatorState()
    const out = applyUpdate(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'failed',
        rawInput: { command: 'doomed' },
        rawOutput: { output: 'permission denied', metadata: { exit: 1 } },
      }),
      s,
    )
    expect(out.entries).toHaveLength(2) // tool_use + tool_result
    const result = out.entries[1] as TranscriptUserEntry
    const block = (result.message?.content as TranscriptContentBlock[])[0]
    expect(block.type).toBe('tool_result')
    expect(block.is_error).toBe(true)
    expect(block.content).toBe('permission denied')
  })

  it('marks is_error on non-zero exit even without explicit failed status', () => {
    const s = createTranslatorState()
    const out = applyUpdate(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        rawInput: { command: 'x' },
        rawOutput: { output: 'oh no', metadata: { exit: 7 } },
      }),
      s,
    )
    const resultEntry = out.entries.find(e => e.type === 'user') as TranscriptUserEntry | undefined
    const block = (resultEntry?.message?.content as TranscriptContentBlock[])[0]
    expect(block.is_error).toBe(true)
  })

  it('handles tool_call_update without preceding tool_call (defensive synth)', () => {
    const s = createTranslatorState()
    const out = applyUpdate(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'orphan',
        status: 'completed',
        kind: 'read',
        title: 'read',
        rawInput: { path: '/x' },
        rawOutput: { output: 'data' },
      }),
      s,
    )
    expect(out.entries).toHaveLength(2)
    expect(out.entries[0].type).toBe('assistant')
    expect(out.entries[1].type).toBe('user')
  })

  it('rawOutput supersedes intermediate streamed content', () => {
    const s = createTranslatorState()
    applyUpdate(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'in_progress',
        rawInput: { command: 'ls' },
      }),
      s,
    )
    applyUpdate(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'in_progress',
        rawInput: { command: 'ls' },
        content: [{ type: 'content', content: { type: 'text', text: 'partial output\n' } }],
      }),
      s,
    )
    const finalOut = applyUpdate(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        rawInput: { command: 'ls' },
        rawOutput: { output: 'final output\n', metadata: { exit: 0 } },
      }),
      s,
    )
    const result = finalOut.entries.find(e => e.type === 'user') as TranscriptUserEntry | undefined
    const block = (result?.message?.content as TranscriptContentBlock[])[0]
    expect(block.content).toBe('final output\n')
  })

  it('text chunk after tool_use starts a fresh run (new UUID)', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before' } }), s)
    const firstUuid = s.activeRunUuid
    applyUpdate(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        rawInput: { x: 1 },
        rawOutput: { output: 'y' },
      }),
      s,
    )
    expect(s.activeRunUuid).toBeNull()
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } }), s)
    expect(s.activeRunUuid).not.toBeNull()
    expect(s.activeRunUuid).not.toBe(firstUuid)
    expect(s.pendingBlocks).toEqual([{ type: 'text', text: 'after' }])
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
  it('emits final assistant entry with usage + system turn_duration + closing message_stop', () => {
    const s = createTranslatorState()
    s.turnStartedAt = Date.now() - 1500
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } }), s)
    applyUpdate(update({ sessionUpdate: 'usage_update', cost: { amount: 0.0042, currency: 'USD' } }), s)
    applyPromptUsage({ inputTokens: 100, outputTokens: 5 }, s)
    s.stopReason = 'end_turn'

    const out = flushTurn(s)
    expect(out.entries).toHaveLength(2)
    const [assistant, sys] = out.entries as [TranscriptAssistantEntry, TranscriptSystemEntry]
    expect(assistant.type).toBe('assistant')
    expect(assistant.message?.content).toEqual([{ type: 'text', text: 'Done.' }])
    expect(assistant.message?.usage).toEqual({ input_tokens: 100, output_tokens: 5 })
    expect(sys.type).toBe('system')
    expect(sys.subtype).toBe('turn_duration')
    expect(sys.content).toMatch(/100\/5 tok/)
    expect(sys.content).toMatch(/\$0\.0042/)
    expect((sys as { stopReason?: string }).stopReason).toBeUndefined()
    // Closing message_stop clears the dashboard's streaming buffer.
    expect(out.streamDeltas).toContainEqual({ type: 'message_stop' })
  })

  it('emits only turn_duration when no content was produced', () => {
    const s = createTranslatorState()
    const out = flushTurn(s)
    expect(out.entries).toHaveLength(1)
    expect(out.entries[0].type).toBe('system')
    expect(out.streamDeltas).toEqual([])
  })

  it('does not re-emit text already committed at a tool boundary', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before' } }), s)
    applyUpdate(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        rawInput: { x: 1 },
        rawOutput: { output: 'y' },
      }),
      s,
    )
    // Only the post-tool text run is still pending.
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } }), s)
    const out = flushTurn(s)
    const assistantEntries = out.entries.filter(e => e.type === 'assistant') as TranscriptAssistantEntry[]
    expect(assistantEntries).toHaveLength(1)
    expect(assistantEntries[0]?.message?.content).toEqual([{ type: 'text', text: 'after' }])
  })

  it('resets state for the next turn', () => {
    const s = createTranslatorState()
    applyUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A' } }), s)
    flushTurn(s)
    expect(s.pendingBlocks).toEqual([])
    expect(s.activeRunUuid).toBeNull()
    expect(s.cost).toBe(0)
    expect(s.toolCalls.size).toBe(0)
    expect(s.streamRunActive).toBe(false)
  })
})

describe('translator: unknown / ignored update subtypes', () => {
  it('silently ignores unknown subtypes (no entries, no deltas, no state mutation)', () => {
    const s = createTranslatorState()
    const out1 = applyUpdate(
      update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'init' }] }),
      s,
    )
    const out2 = applyUpdate(update({ sessionUpdate: 'current_mode_update', currentModeId: 'edit' }), s)
    const out3 = applyUpdate(update({ sessionUpdate: 'config_option_update', configId: 'model', currentValue: 'x' }), s)
    const out4 = applyUpdate(update({ sessionUpdate: 'plan', entries: [{ content: 'do thing' }] }), s)
    const out5 = applyUpdate(update({ sessionUpdate: 'totally_made_up' }), s)
    for (const o of [out1, out2, out3, out4, out5]) {
      expect(o.entries).toEqual([])
      expect(o.streamDeltas).toEqual([])
    }
    expect(s.pendingBlocks).toEqual([])
    expect(s.cost).toBe(0)
  })
})

describe('translator: end-to-end against spike-shaped events', () => {
  it('produces in-order live entries: thinking-run -> tool_use -> tool_result -> text-run -> turn_duration', () => {
    const s = createTranslatorState()
    const allEntries: ReturnType<typeof flushTurn>['entries'] = []
    const allDeltas: Record<string, unknown>[] = []
    function feed(u: Record<string, unknown>) {
      const o = applyUpdate(update(u), s)
      allEntries.push(...o.entries)
      allDeltas.push(...o.streamDeltas)
    }

    // 7 thought chunks
    for (const t of [
      'The',
      ' user wants me to',
      ' list files using',
      ' `ls` via',
      ' bash',
      ' and then say done',
      '.',
    ]) {
      feed({ sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: { type: 'text', text: t } })
    }
    // tool_call pending (no rawInput) -- triggers thinking-run commit
    feed({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_aa86',
      status: 'pending',
      kind: 'execute',
      title: 'bash',
      rawInput: {},
    })
    // in_progress with rawInput -- commits tool_use
    feed({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_aa86',
      status: 'in_progress',
      kind: 'execute',
      title: 'bash',
      rawInput: { command: 'ls', description: 'List files' },
    })
    // completed with rawOutput -- commits tool_result
    feed({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_aa86',
      status: 'completed',
      kind: 'execute',
      title: 'List files in current directory',
      rawInput: { command: 'ls', description: 'List files in current directory' },
      rawOutput: { output: 'backups\nbin\n', metadata: { exit: 0, truncated: false } },
    })
    // assistant message chunk -- starts a new run
    feed({ sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'Done.' } })
    // usage_update
    feed({ sessionUpdate: 'usage_update', used: 24460, size: 202752, cost: { amount: 0.04055548, currency: 'USD' } })
    applyPromptUsage({ inputTokens: 140, outputTokens: 3 }, s)
    s.stopReason = 'end_turn'

    const finalOut = flushTurn(s)
    allEntries.push(...finalOut.entries)
    allDeltas.push(...finalOut.streamDeltas)

    // Expected order: thinking assistant entry, tool_use assistant entry,
    // tool_result user entry, final text assistant entry, turn_duration system.
    expect(allEntries.map(e => e.type)).toEqual(['assistant', 'assistant', 'user', 'assistant', 'system'])
    const thinkingEntry = allEntries[0] as TranscriptAssistantEntry
    expect((thinkingEntry.message?.content as TranscriptContentBlock[])[0]?.type).toBe('thinking')
    const toolUseEntry = allEntries[1] as TranscriptAssistantEntry
    expect((toolUseEntry.message?.content as TranscriptContentBlock[])[0]?.type).toBe('tool_use')
    const toolResultEntry = allEntries[2] as TranscriptUserEntry
    expect((toolResultEntry.message?.content as TranscriptContentBlock[])[0]?.type).toBe('tool_result')
    const finalText = allEntries[3] as TranscriptAssistantEntry
    expect((finalText.message?.content as TranscriptContentBlock[])[0]).toMatchObject({
      type: 'text',
      text: 'Done.',
    })
    expect(finalText.message?.usage).toEqual({ input_tokens: 140, output_tokens: 3 })

    const sys = allEntries[4] as TranscriptSystemEntry
    expect(sys.subtype).toBe('turn_duration')
    expect(sys.content).toMatch(/140\/3 tok/)
    expect(sys.content).toMatch(/\$0\.0406/)

    // Two complete runs -> two message_starts and two message_stops.
    const messageStarts = allDeltas.filter(d => d.type === 'message_start')
    const messageStops = allDeltas.filter(d => d.type === 'message_stop')
    expect(messageStarts).toHaveLength(2)
    expect(messageStops).toHaveLength(2)
    const thinkingDeltas = allDeltas.filter(
      d => d.type === 'content_block_delta' && (d as { delta: { type: string } }).delta.type === 'thinking_delta',
    )
    expect(thinkingDeltas).toHaveLength(7)
    const textDeltas = allDeltas.filter(
      d => d.type === 'content_block_delta' && (d as { delta: { type: string } }).delta.type === 'text_delta',
    )
    expect(textDeltas).toHaveLength(1)
  })
})
