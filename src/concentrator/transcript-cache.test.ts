import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '../shared/protocol'
import { createSessionStore } from './session-store'

function makeEntry(index: number): TranscriptEntry {
  return { type: 'user', message: { content: `entry ${index}` }, index }
}

describe('TranscriptCache', () => {
  it('stores and retrieves transcript entries', () => {
    const store = createSessionStore({ enablePersistence: false })
    store.createSession('s1', '/tmp')

    const entries = [makeEntry(1), makeEntry(2), makeEntry(3)]
    store.addTranscriptEntries('s1', entries, true)

    const result = store.getTranscriptEntries('s1')
    expect(result).toEqual(entries)
  })

  it('appends incremental entries', () => {
    const store = createSessionStore({ enablePersistence: false })
    store.createSession('s1', '/tmp')

    store.addTranscriptEntries('s1', [makeEntry(1), makeEntry(2)], true)
    store.addTranscriptEntries('s1', [makeEntry(3)], false)

    const result = store.getTranscriptEntries('s1')
    expect(result.length).toBe(3)
    expect(result[2]).toEqual(makeEntry(3))
  })

  it('initial batch replaces previous entries', () => {
    const store = createSessionStore({ enablePersistence: false })
    store.createSession('s1', '/tmp')

    store.addTranscriptEntries('s1', [makeEntry(1), makeEntry(2)], true)
    store.addTranscriptEntries('s1', [makeEntry(10)], true)

    const result = store.getTranscriptEntries('s1')
    expect(result.length).toBe(1)
    expect(result[0]).toEqual(makeEntry(10))
  })

  it('respects limit parameter', () => {
    const store = createSessionStore({ enablePersistence: false })
    store.createSession('s1', '/tmp')

    const entries = Array.from({ length: 20 }, (_, i) => makeEntry(i))
    store.addTranscriptEntries('s1', entries, true)

    const result = store.getTranscriptEntries('s1', 5)
    expect(result.length).toBe(5)
    // Should return last 5 entries
    expect(result[0]).toEqual(makeEntry(15))
    expect(result[4]).toEqual(makeEntry(19))
  })

  it('caps at max entries (500)', () => {
    const store = createSessionStore({ enablePersistence: false })
    store.createSession('s1', '/tmp')

    const entries = Array.from({ length: 600 }, (_, i) => makeEntry(i))
    store.addTranscriptEntries('s1', entries, true)

    const result = store.getTranscriptEntries('s1')
    expect(result.length).toBe(500)
    // Should keep the last 500
    expect(result[0]).toEqual(makeEntry(100))
    expect(result[499]).toEqual(makeEntry(599))
  })

  it('caps incremental appends too', () => {
    const store = createSessionStore({ enablePersistence: false })
    store.createSession('s1', '/tmp')

    // Fill with 490 entries
    const initial = Array.from({ length: 490 }, (_, i) => makeEntry(i))
    store.addTranscriptEntries('s1', initial, true)

    // Add 20 more (total 510, should trim to 500)
    const more = Array.from({ length: 20 }, (_, i) => makeEntry(490 + i))
    store.addTranscriptEntries('s1', more, false)

    const result = store.getTranscriptEntries('s1')
    expect(result.length).toBe(500)
    expect(result[0]).toEqual(makeEntry(10))
    expect(result[499]).toEqual(makeEntry(509))
  })

  it('returns empty array for unknown session', () => {
    const store = createSessionStore({ enablePersistence: false })
    expect(store.getTranscriptEntries('nonexistent')).toEqual([])
    expect(store.hasTranscriptCache('nonexistent')).toBe(false)
  })

  it('hasTranscriptCache returns correct state', () => {
    const store = createSessionStore({ enablePersistence: false })
    store.createSession('s1', '/tmp')

    expect(store.hasTranscriptCache('s1')).toBe(false)
    store.addTranscriptEntries('s1', [makeEntry(1)], true)
    expect(store.hasTranscriptCache('s1')).toBe(true)
  })
})

describe('SubagentTranscriptCache', () => {
  it('stores and retrieves subagent transcript entries', () => {
    const store = createSessionStore({ enablePersistence: false })
    store.createSession('s1', '/tmp')

    const entries = [makeEntry(1), makeEntry(2)]
    store.addSubagentTranscriptEntries('s1', 'agent-1', entries, true)

    const result = store.getSubagentTranscriptEntries('s1', 'agent-1')
    expect(result).toEqual(entries)
  })

  it('isolates different agents', () => {
    const store = createSessionStore({ enablePersistence: false })
    store.createSession('s1', '/tmp')

    store.addSubagentTranscriptEntries('s1', 'agent-1', [makeEntry(1)], true)
    store.addSubagentTranscriptEntries('s1', 'agent-2', [makeEntry(2)], true)

    expect(store.getSubagentTranscriptEntries('s1', 'agent-1')).toEqual([makeEntry(1)])
    expect(store.getSubagentTranscriptEntries('s1', 'agent-2')).toEqual([makeEntry(2)])
  })

  it('isolates different sessions', () => {
    const store = createSessionStore({ enablePersistence: false })
    store.createSession('s1', '/tmp')
    store.createSession('s2', '/tmp')

    store.addSubagentTranscriptEntries('s1', 'agent-1', [makeEntry(1)], true)
    store.addSubagentTranscriptEntries('s2', 'agent-1', [makeEntry(2)], true)

    expect(store.getSubagentTranscriptEntries('s1', 'agent-1')).toEqual([makeEntry(1)])
    expect(store.getSubagentTranscriptEntries('s2', 'agent-1')).toEqual([makeEntry(2)])
  })

  it('appends incremental entries', () => {
    const store = createSessionStore({ enablePersistence: false })
    store.createSession('s1', '/tmp')

    store.addSubagentTranscriptEntries('s1', 'agent-1', [makeEntry(1)], true)
    store.addSubagentTranscriptEntries('s1', 'agent-1', [makeEntry(2)], false)

    const result = store.getSubagentTranscriptEntries('s1', 'agent-1')
    expect(result.length).toBe(2)
  })

  it('hasSubagentTranscriptCache works', () => {
    const store = createSessionStore({ enablePersistence: false })
    store.createSession('s1', '/tmp')

    expect(store.hasSubagentTranscriptCache('s1', 'agent-1')).toBe(false)
    store.addSubagentTranscriptEntries('s1', 'agent-1', [makeEntry(1)], true)
    expect(store.hasSubagentTranscriptCache('s1', 'agent-1')).toBe(true)
  })

  it('respects limit on retrieval', () => {
    const store = createSessionStore({ enablePersistence: false })
    store.createSession('s1', '/tmp')

    const entries = Array.from({ length: 50 }, (_, i) => makeEntry(i))
    store.addSubagentTranscriptEntries('s1', 'agent-1', entries, true)

    const result = store.getSubagentTranscriptEntries('s1', 'agent-1', 10)
    expect(result.length).toBe(10)
    expect(result[0]).toEqual(makeEntry(40))
  })
})
