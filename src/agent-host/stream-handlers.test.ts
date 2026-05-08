import { describe, expect, test } from 'vitest'
import type { TranscriptEntry } from '../shared/protocol'
import { type HandlerContext, handleMessage } from './stream-handlers'
import { createReplayBuffer } from './stream-replay'

function createTestContext(): { hctx: HandlerContext; entries: TranscriptEntry[] } {
  const entries: TranscriptEntry[] = []
  const hctx: HandlerContext = {
    monitors: { pendingMonitorInputs: new Map(), agentTaskToToolUse: new Map(), monitorTasks: new Map() },
    replay: createReplayBuffer(),
    pendingControlRequests: new Map(),
    callbacks: {
      onTranscriptEntries(e) {
        entries.push(...e)
      },
    },
  }
  hctx.replay.done = true
  return { hctx, entries }
}

describe('stream-handlers UUID synthesis', () => {
  test('tool_result user message without UUID gets deterministic UUID', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'ok' }] },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].uuid).toBeDefined()
    expect(entries[0].uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('tool_result user message with UUID from CC preserves it', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      uuid: 'cc-provided-uuid-1234',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_2', type: 'tool_result', content: 'yes' }] },
    })
    expect(entries[0].uuid).toBe('cc-provided-uuid-1234')
  })

  test('same tool_result user message always produces same UUID', () => {
    const { hctx: hctx1, entries: entries1 } = createTestContext()
    const { hctx: hctx2, entries: entries2 } = createTestContext()
    const msg = {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_3', type: 'tool_result', content: 'same' }] },
    }
    handleMessage(hctx1, { ...msg })
    handleMessage(hctx2, { ...msg })
    expect(entries1[0].uuid).toBe(entries2[0].uuid)
  })

  test('different tool_result messages produce different UUIDs', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_A', type: 'tool_result', content: 'a' }] },
    })
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:26.000Z',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_B', type: 'tool_result', content: 'b' }] },
    })
    expect(entries[0].uuid).not.toBe(entries[1].uuid)
  })

  test('plain text user message gets deterministic UUID', () => {
    const { hctx, entries } = createTestContext()
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      message: { role: 'user', content: 'hello world' },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('same plain text user message always produces same UUID (dedup-safe)', () => {
    const { hctx: hctx1, entries: entries1 } = createTestContext()
    const { hctx: hctx2, entries: entries2 } = createTestContext()
    const msg = {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      message: { role: 'user', content: 'hello world' },
    }
    handleMessage(hctx1, { ...msg })
    handleMessage(hctx2, { ...msg })
    expect(entries1[0].uuid).toBe(entries2[0].uuid)
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

  test('CC echo reuses stashed UUID from synthetic (dedup with broker)', () => {
    const stash = new Map<string, string>()
    const entries: TranscriptEntry[] = []
    const hctx: HandlerContext = {
      monitors: { pendingMonitorInputs: new Map(), agentTaskToToolUse: new Map(), monitorTasks: new Map() },
      replay: createReplayBuffer(),
      pendingControlRequests: new Map(),
      syntheticUserUuids: stash,
      conversationId: 'test-conv-id',
      callbacks: { onTranscriptEntries(e) { entries.push(...e) } },
    }
    hctx.replay.done = true

    // Simulate sendUserMessage stashing a UUID
    const { createHash } = require('node:crypto')
    const content = 'hello world'
    const contentHash = createHash('sha1').update(content).digest('hex').slice(0, 16)
    stash.set(contentHash, 'stashed-uuid-12345')

    // CC echo arrives -- should reuse the stashed UUID
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:17:40.000Z',
      message: { role: 'user', content },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].uuid).toBe('stashed-uuid-12345')
    expect(stash.size).toBe(0) // consumed
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

  test('plain text user message during replay goes to buffer', () => {
    const { hctx, entries } = createTestContext()
    hctx.replay.done = false
    handleMessage(hctx, {
      type: 'user',
      timestamp: '2026-05-08T15:15:25.731Z',
      isReplay: true,
      message: { role: 'user', content: 'hello world' },
    })
    expect(entries).toHaveLength(0)
    expect(hctx.replay.entries).toHaveLength(1)
  })

  test('tool_result user and assistant with same timestamp produce different UUIDs', () => {
    const { hctx, entries } = createTestContext()
    const ts = '2026-05-08T15:15:25.731Z'
    handleMessage(hctx, {
      type: 'user',
      timestamp: ts,
      message: { role: 'user', content: [{ tool_use_id: 'toolu_x', type: 'tool_result', content: 'same' }] },
    })
    handleMessage(hctx, { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: 'same' } })
    expect(entries).toHaveLength(2)
    expect(entries[0].uuid).not.toBe(entries[1].uuid)
  })
})
