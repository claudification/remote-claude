import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '../shared/protocol'
import { createConversationStore } from './conversation-store'

function makeEntry(index: number): TranscriptEntry {
  return { type: 'user', message: { content: `entry ${index}` }, index }
}

describe('TranscriptCache', () => {
  it('stores and retrieves transcript entries', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    const entries = [makeEntry(1), makeEntry(2), makeEntry(3)]
    store.addTranscriptEntries('s1', entries, true)

    const result = store.getTranscriptEntries('s1')
    expect(result).toEqual(entries)
  })

  it('appends incremental entries', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    store.addTranscriptEntries('s1', [makeEntry(1), makeEntry(2)], true)
    store.addTranscriptEntries('s1', [makeEntry(3)], false)

    const result = store.getTranscriptEntries('s1')
    expect(result.length).toBe(3)
    // toMatchObject ignores the in-place stamped `seq` (asserted separately below)
    expect(result[2]).toMatchObject(makeEntry(3))
    // Monotonic seqs: initial batch got 1,2; incremental got 3.
    expect(result.map(e => e.seq)).toEqual([1, 2, 3])
  })

  it('initial batch replaces previous entries and resets seq counter', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    store.addTranscriptEntries('s1', [makeEntry(1), makeEntry(2)], true)
    store.addTranscriptEntries('s1', [makeEntry(10)], true)

    const result = store.getTranscriptEntries('s1')
    expect(result.length).toBe(1)
    expect(result[0]).toMatchObject(makeEntry(10))
    // isInitial=true resets counter -> new single entry restarts at seq 1.
    expect(result[0].seq).toBe(1)
  })

  it('respects limit parameter', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    const entries = Array.from({ length: 20 }, (_, i) => makeEntry(i))
    store.addTranscriptEntries('s1', entries, true)

    const result = store.getTranscriptEntries('s1', 5)
    expect(result.length).toBe(5)
    // Should return last 5 entries
    expect(result[0]).toMatchObject(makeEntry(15))
    expect(result[4]).toMatchObject(makeEntry(19))
  })

  it('caps at max entries (1000)', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    const entries = Array.from({ length: 1200 }, (_, i) => makeEntry(i))
    store.addTranscriptEntries('s1', entries, true)

    const result = store.getTranscriptEntries('s1')
    expect(result.length).toBe(1000)
    // Should keep the last 1000
    expect(result[0]).toMatchObject(makeEntry(200))
    expect(result[999]).toMatchObject(makeEntry(1199))
    // Seqs 201..1200 survive (1..200 stamped then evicted by slice(-1000)).
    expect(result[0].seq).toBe(201)
    expect(result[999].seq).toBe(1200)
  })

  it('caps incremental appends too', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    // Fill with 990 entries
    const initial = Array.from({ length: 990 }, (_, i) => makeEntry(i))
    store.addTranscriptEntries('s1', initial, true)

    // Add 20 more (total 1010, should trim to 1000)
    const more = Array.from({ length: 20 }, (_, i) => makeEntry(990 + i))
    store.addTranscriptEntries('s1', more, false)

    const result = store.getTranscriptEntries('s1')
    expect(result.length).toBe(1000)
    expect(result[0]).toMatchObject(makeEntry(10))
    expect(result[999]).toMatchObject(makeEntry(1009))
    // Counter didn't reset on the incremental -> seqs 11..1010 survive.
    expect(result[0].seq).toBe(11)
    expect(result[999].seq).toBe(1010)
  })

  it('stamps per-conversation monotonic seq starting at 1', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')
    store.createConversation('s2', '/tmp')

    store.addTranscriptEntries('s1', [makeEntry(1), makeEntry(2)], true)
    store.addTranscriptEntries('s2', [makeEntry(1)], true)
    store.addTranscriptEntries('s1', [makeEntry(3)], false)

    const s1 = store.getTranscriptEntries('s1')
    const s2 = store.getTranscriptEntries('s2')
    // Each session has its own counter starting at 1.
    expect(s1.map(e => e.seq)).toEqual([1, 2, 3])
    expect(s2.map(e => e.seq)).toEqual([1])
  })

  it('returns empty array for unknown conversation', () => {
    const store = createConversationStore({ enablePersistence: false })
    expect(store.getTranscriptEntries('nonexistent')).toEqual([])
    expect(store.hasTranscriptCache('nonexistent')).toBe(false)
  })

  it('hasTranscriptCache returns correct state', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    expect(store.hasTranscriptCache('s1')).toBe(false)
    store.addTranscriptEntries('s1', [makeEntry(1)], true)
    expect(store.hasTranscriptCache('s1')).toBe(true)
  })
})

describe('SubagentTranscriptCache', () => {
  it('stores and retrieves subagent transcript entries', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    const entries = [makeEntry(1), makeEntry(2)]
    store.addSubagentTranscriptEntries('s1', 'agent-1', entries, true)

    const result = store.getSubagentTranscriptEntries('s1', 'agent-1')
    expect(result).toEqual(entries)
  })

  it('isolates different agents', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    store.addSubagentTranscriptEntries('s1', 'agent-1', [makeEntry(1)], true)
    store.addSubagentTranscriptEntries('s1', 'agent-2', [makeEntry(2)], true)

    const a1 = store.getSubagentTranscriptEntries('s1', 'agent-1')
    const a2 = store.getSubagentTranscriptEntries('s1', 'agent-2')
    expect(a1).toHaveLength(1)
    expect(a1[0]).toMatchObject(makeEntry(1))
    expect(a2).toHaveLength(1)
    expect(a2[0]).toMatchObject(makeEntry(2))
    // Separate counters: each agent restarts at seq 1.
    expect(a1[0].seq).toBe(1)
    expect(a2[0].seq).toBe(1)
  })

  it('isolates different sessions', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')
    store.createConversation('s2', '/tmp')

    store.addSubagentTranscriptEntries('s1', 'agent-1', [makeEntry(1)], true)
    store.addSubagentTranscriptEntries('s2', 'agent-1', [makeEntry(2)], true)

    const s1 = store.getSubagentTranscriptEntries('s1', 'agent-1')
    const s2 = store.getSubagentTranscriptEntries('s2', 'agent-1')
    expect(s1).toHaveLength(1)
    expect(s1[0]).toMatchObject(makeEntry(1))
    expect(s2).toHaveLength(1)
    expect(s2[0]).toMatchObject(makeEntry(2))
  })

  it('appends incremental entries', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    store.addSubagentTranscriptEntries('s1', 'agent-1', [makeEntry(1)], true)
    store.addSubagentTranscriptEntries('s1', 'agent-1', [makeEntry(2)], false)

    const result = store.getSubagentTranscriptEntries('s1', 'agent-1')
    expect(result.length).toBe(2)
  })

  it('hasSubagentTranscriptCache works', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    expect(store.hasSubagentTranscriptCache('s1', 'agent-1')).toBe(false)
    store.addSubagentTranscriptEntries('s1', 'agent-1', [makeEntry(1)], true)
    expect(store.hasSubagentTranscriptCache('s1', 'agent-1')).toBe(true)
  })

  it('respects limit on retrieval', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    const entries = Array.from({ length: 50 }, (_, i) => makeEntry(i))
    store.addSubagentTranscriptEntries('s1', 'agent-1', entries, true)

    const result = store.getSubagentTranscriptEntries('s1', 'agent-1', 10)
    expect(result.length).toBe(10)
    expect(result[0]).toMatchObject(makeEntry(40))
  })
})
