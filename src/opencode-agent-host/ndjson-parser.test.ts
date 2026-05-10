import { describe, expect, it } from 'bun:test'
import { createParserState, flushTurn, type OpenCodeEvent, parseNdjsonChunk, translateEvent } from './ndjson-parser'

describe('opencode-host NDJSON parser', () => {
  it('captures session id from any event that carries one', () => {
    const state = createParserState()
    translateEvent({ type: 'step_start', part: { sessionID: 'ses_abc', messageID: 'msg_1' } }, state)
    expect(state.sessionId).toBe('ses_abc')
  })

  it('coalesces consecutive text events into one block', () => {
    const state = createParserState()
    translateEvent({ type: 'step_start' }, state)
    translateEvent({ type: 'text', part: { text: 'Hello, ' } }, state)
    translateEvent({ type: 'text', part: { text: 'world!' } }, state)
    expect(state.pendingBlocks).toHaveLength(1)
    expect(state.pendingBlocks[0]).toEqual({ type: 'text', text: 'Hello, world!' })
  })

  it('emits paired tool_use + tool_result blocks for a successful tool call', () => {
    const state = createParserState()
    translateEvent({ type: 'step_start' }, state)
    translateEvent(
      {
        type: 'tool_use',
        part: {
          tool: 'read',
          callID: 'toolu_xyz',
          state: {
            status: 'completed',
            input: { filePath: '/workspace/hello.txt' },
            output: '1: Hello',
          },
        },
      },
      state,
    )
    // Additive canonical fields (kind/canonicalInput/result/raw) ride along.
    // Assert legacy shape via toMatchObject.
    expect(state.pendingBlocks).toHaveLength(2)
    expect(state.pendingBlocks[0]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_xyz',
      name: 'read',
      input: { filePath: '/workspace/hello.txt' },
    })
    expect(state.pendingBlocks[1]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_xyz',
      content: '1: Hello',
    })
  })

  it('marks tool results as is_error when the call failed', () => {
    const state = createParserState()
    translateEvent({ type: 'step_start' }, state)
    translateEvent(
      {
        type: 'tool_use',
        part: {
          tool: 'bash',
          callID: 'toolu_err',
          state: { status: 'error', error: 'permission denied' },
        },
      },
      state,
    )
    expect(state.pendingBlocks[1]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_err',
      content: 'permission denied',
      is_error: true,
    })
  })

  it('does not flush on step_finish with reason=tool-calls (mid-turn)', () => {
    const state = createParserState()
    translateEvent({ type: 'step_start' }, state)
    translateEvent({ type: 'text', part: { text: 'Reading file...' } }, state)
    const out = translateEvent({ type: 'step_finish', part: { reason: 'tool-calls', cost: 0.001 } }, state)
    expect(out.entries).toEqual([])
    expect(out.turnComplete).toBe(false)
    expect(state.cost).toBe(0.001)
    expect(state.pendingBlocks).toHaveLength(1) // text block still pending
  })

  it('flushes assistant + system entries on terminal step_finish', () => {
    const state = createParserState()
    state.turnStartedAt = Date.now() - 250
    translateEvent({ type: 'step_start' }, state)
    translateEvent({ type: 'text', part: { text: 'Done!' } }, state)
    const out = translateEvent(
      {
        type: 'step_finish',
        part: { reason: 'stop', cost: 0.014, tokens: { input: 100, output: 50 } },
      },
      state,
    )
    expect(out.turnComplete).toBe(true)
    expect(out.entries).toHaveLength(2)
    expect(out.entries[0]).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done!' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    })
    expect(out.entries[1]).toMatchObject({
      type: 'system',
      subtype: 'turn_duration',
    })
    // Pending state cleared
    expect(state.pendingBlocks).toHaveLength(0)
    expect(state.cost).toBe(0)
    expect(state.inputTokens).toBe(0)
  })

  it('preserves session id across turn flush (so --session resume works)', () => {
    const state = createParserState()
    state.sessionId = 'ses_persist'
    translateEvent({ type: 'text', part: { text: 'x' } }, state)
    flushTurn(state)
    expect(state.sessionId).toBe('ses_persist')
  })

  it('translates an error event to a system error entry', () => {
    const state = createParserState()
    const out = translateEvent({ type: 'error', part: { message: 'rate limited' } } as OpenCodeEvent, state)
    expect(out.entries).toHaveLength(1)
    expect(out.entries[0]).toMatchObject({
      type: 'system',
      subtype: 'chat_api_error',
      level: 'error',
      content: 'rate limited',
    })
  })

  it('skips unknown event types silently', () => {
    const state = createParserState()
    const out = translateEvent({ type: 'mystery_event' } as OpenCodeEvent, state)
    expect(out.entries).toEqual([])
    expect(state.pendingBlocks).toHaveLength(0)
  })

  it('parseNdjsonChunk handles split lines across chunks', () => {
    const events: OpenCodeEvent[] = []
    const visit = (e: OpenCodeEvent) => events.push(e)
    let carry = parseNdjsonChunk('{"type":"step_start"}\n{"type":"te', '', visit)
    expect(events).toHaveLength(1)
    expect(carry).toBe('{"type":"te')
    carry = parseNdjsonChunk('xt","part":{"text":"hi"}}\n', carry, visit)
    expect(events).toHaveLength(2)
    expect((events[1] as { part?: { text?: string } }).part?.text).toBe('hi')
    expect(carry).toBe('')
  })

  it('parseNdjsonChunk emits a synthetic error event for malformed JSON', () => {
    const events: OpenCodeEvent[] = []
    parseNdjsonChunk('not valid json\n', '', e => events.push(e))
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('error')
  })

  it('full happy-path turn produces the expected entry sequence', () => {
    const state = createParserState()
    const events: OpenCodeEvent[] = [
      { type: 'step_start' },
      { type: 'text', part: { text: "I'll read hello.txt..." } },
      {
        type: 'tool_use',
        part: {
          tool: 'read',
          callID: 'tu_1',
          state: { status: 'completed', input: { filePath: '/x.txt' }, output: 'hi' },
        },
      },
      { type: 'step_finish', part: { reason: 'tool-calls', cost: 0.005, tokens: { input: 50, output: 10 } } },
      { type: 'text', part: { text: 'Done!' } },
      { type: 'step_finish', part: { reason: 'stop', cost: 0.009, tokens: { input: 60, output: 15 } } },
    ]
    const allEntries = []
    let turnDone = false
    for (const e of events) {
      const out = translateEvent(e, state)
      allEntries.push(...out.entries)
      if (out.turnComplete) turnDone = true
    }
    expect(turnDone).toBe(true)
    expect(allEntries).toHaveLength(2) // one assistant, one system
    const assistant = allEntries[0] as { message: { content: { type: string }[] } }
    // text + tool_use + tool_result + text
    expect(assistant.message.content.map(b => b.type)).toEqual(['text', 'tool_use', 'tool_result', 'text'])
  })
})
