import { describe, expect, it } from 'bun:test'
import type { TranscriptEntry, TranscriptSystemEntry } from '../../../shared/protocol'
import { createConversationStore } from '../../conversation-store'

function compactBoundary(timestamp: string): TranscriptSystemEntry {
  return { type: 'system', subtype: 'compact_boundary', timestamp } as TranscriptSystemEntry
}

function countMarkers(entries: TranscriptEntry[]): number {
  return entries.filter(e => e.type === 'compacted').length
}

describe('compact_boundary dedup', () => {
  it('emits one synthetic marker on the first live compact_boundary', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    store.addTranscriptEntries('s1', [compactBoundary('2026-05-11T14:00:00Z')], false)

    expect(countMarkers(store.getTranscriptEntries('s1'))).toBe(1)
  })

  it('does NOT emit a duplicate when the same compact_boundary is replayed (broker restart scenario)', () => {
    // Reproduces the bug: agent host's ring buffer replays the last 50
    // transcript entries on every reconnect (including across broker
    // restarts). The same compact_boundary system entry hits the live
    // handler again with isInitial=false; without entry-time-based dedup
    // every restart stacks another synthetic marker.
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    const entry = compactBoundary('2026-05-11T14:00:00Z')
    store.addTranscriptEntries('s1', [entry], false)
    // Simulate three subsequent reconnects after a long broker outage.
    store.addTranscriptEntries('s1', [entry], false)
    store.addTranscriptEntries('s1', [entry], false)
    store.addTranscriptEntries('s1', [entry], false)

    expect(countMarkers(store.getTranscriptEntries('s1'))).toBe(1)
  })

  it('emits a fresh marker for a new compaction after a prior one', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    store.addTranscriptEntries('s1', [compactBoundary('2026-05-11T14:00:00Z')], false)
    store.addTranscriptEntries('s1', [compactBoundary('2026-05-11T15:00:00Z')], false)

    expect(countMarkers(store.getTranscriptEntries('s1'))).toBe(2)
  })

  it('initial-load compact_boundary does not emit a synthetic marker but does set compactedAt', () => {
    const store = createConversationStore({ enablePersistence: false })
    store.createConversation('s1', '/tmp')

    store.addTranscriptEntries('s1', [compactBoundary('2026-05-11T14:00:00Z')], true)

    expect(countMarkers(store.getTranscriptEntries('s1'))).toBe(0)
    // A subsequent replay of the same entry as live must still be deduped
    store.addTranscriptEntries('s1', [compactBoundary('2026-05-11T14:00:00Z')], false)
    expect(countMarkers(store.getTranscriptEntries('s1'))).toBe(0)
  })
})
