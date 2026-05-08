import { describe, expect, test } from 'vitest'
import type { TranscriptEntry } from '../shared/protocol'
import { handleMessage, type HandlerContext } from './stream-handlers'
import { createReplayBuffer } from './stream-replay'

function createTestContext(): { hctx: HandlerContext; entries: TranscriptEntry[] } {
  const entries: TranscriptEntry[] = []
  const hctx: HandlerContext = {
    monitors: { pendingMonitorInputs: new Map(), agentTaskToToolUse: new Map(), monitorTasks: new Map() },
    replay: createReplayBuffer(),
    pendingControlRequests: new Map(),
    callbacks: {
      onTranscriptEntries(e) { entries.push(...e) },
    },
  }
  hctx.replay.done = true
  return { hctx, entries }
}

describe('stream-handlers UUID synthesis', () => {
  test('user message without UUID gets deterministic UUID', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      message: { role: 'user', content: 'hello world' },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].uuid).toBeDefined()
    expect(entries[0].uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('user message with UUID from CC preserves it', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      uuid: 'cc-provided-uuid-1234',
      message: { role: 'user', content: 'hello' },
    })
    expect(entries[0].uuid).toBe('cc-provided-uuid-1234')
  })

  test('same user message always produces same UUID', () => {
    const { hctx: hctx1, entries: entries1 } = createTestContext()
    const { hctx: hctx2, entries: entries2 } = createTestContext()
    const msg = {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      message: { role: 'user', content: 'same content' },
    }
    handleMessage(hctx1, { ...msg })
    handleMessage(hctx2, { ...msg })
    expect(entries1[0].uuid).toBe(entries2[0].uuid)
  })

  test('different user messages produce different UUIDs', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      message: { role: 'user', content: 'message A' },
    })
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:26.000Z',
      message: { role: 'user', content: 'message B' },
    })
    expect(entries[0].uuid).not.toBe(entries[1].uuid)
  })

  test('assistant message without UUID gets deterministic UUID', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'assistant',
      timestamp: '2026-05-08T15:17:32.164Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].uuid).toBeDefined()
    expect(entries[0].uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('assistant message with UUID from CC preserves it', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'assistant',
      uuid: 'cc-assistant-uuid',
      timestamp: '2026-05-08T15:17:32.164Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    })
    expect(entries[0].uuid).toBe('cc-assistant-uuid')
  })

  test('user and assistant with same content produce different UUIDs (type-prefixed)', () => {
    const { hctx, entries } = createTestContext()
    const ts = '2026-05-08T15:15:25.731Z'
    const content = { role: 'user', content: 'same' }
    handleMessage(hctx, { type: 'user', timestamp: ts, message: content })
    handleMessage(hctx, { type: 'assistant', timestamp: ts, message: content })
    expect(entries[0].uuid).not.toBe(entries[1].uuid)
  })
})
