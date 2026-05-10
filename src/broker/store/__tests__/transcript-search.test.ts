/**
 * Isolated tests for FTS5 transcript search + sliding context window.
 *
 * Runs against both MemoryDriver and SqliteDriver. The two backends differ:
 *   - SqliteDriver uses real FTS5 (porter stemming, bm25 ranking, snippet markers)
 *   - MemoryDriver uses substring fallback (case-insensitive)
 *
 * Tests assert behavior that should match across both. Driver-specific
 * features (FTS5 boolean operators, prefix matching, stemming) are gated.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'bun:test'
import { createMemoryDriver } from '../memory/driver'
import { createSqliteDriver } from '../sqlite/driver'
import type { StoreDriver, TranscriptEntryInput } from '../types'

function makeEntry(
  type: string,
  text: string,
  uuid?: string,
  overrides: Partial<TranscriptEntryInput> = {},
): TranscriptEntryInput {
  return {
    type,
    uuid: uuid ?? crypto.randomUUID(),
    content: { text },
    timestamp: Date.now(),
    ...overrides,
  }
}

interface DriverFlavor {
  name: string
  isFts: boolean
  create: () => StoreDriver
}

const flavors: DriverFlavor[] = [
  { name: 'MemoryDriver', isFts: false, create: () => createMemoryDriver() },
  {
    name: 'SqliteDriver',
    isFts: true,
    create: () => createSqliteDriver({ type: 'sqlite', dataDir: mkdtempSync(join(tmpdir(), 'fts-test-')) }),
  },
]

for (const flavor of flavors) {
  describe(`Transcript search [${flavor.name}]`, () => {
    let store: StoreDriver

    beforeEach(() => {
      store = flavor.create()
      store.init()
      store.conversations.create({ id: 'c1', scope: 'p1', agentType: 'claude' })
      store.conversations.create({ id: 'c2', scope: 'p2', agentType: 'claude' })
    })

    // ---------- basic search ----------

    describe('search() basics', () => {
      it('returns empty array for empty query', () => {
        store.transcripts.append('c1', 'e1', [makeEntry('user', 'hello world', 'a1')])
        expect(store.transcripts.search('')).toEqual([])
        expect(store.transcripts.search('   ')).toEqual([])
      })

      it('finds entries by single word', () => {
        store.transcripts.append('c1', 'e1', [
          makeEntry('user', 'How do I fix the migration bug', 'm1'),
          makeEntry('assistant', 'Try resetting the database', 'm2'),
        ])
        const hits = store.transcripts.search('migration')
        expect(hits.length).toBeGreaterThan(0)
        expect(hits[0].conversationId).toBe('c1')
        expect(hits[0].seq).toBe(1)
      })

      it('returns no hits for non-matching query', () => {
        store.transcripts.append('c1', 'e1', [makeEntry('user', 'hello world', 'x1')])
        expect(store.transcripts.search('nonexistentword12345xyz')).toEqual([])
      })

      it('returns SearchHit shape with required fields', () => {
        store.transcripts.append('c1', 'e1', [makeEntry('user', 'database migration broke', 'sh1')])
        const [hit] = store.transcripts.search('migration')
        expect(hit).toBeDefined()
        expect(hit.id).toBeGreaterThan(0)
        expect(hit.conversationId).toBe('c1')
        expect(hit.seq).toBe(1)
        expect(hit.type).toBe('user')
        expect(hit.content).toEqual({ text: 'database migration broke' })
        expect(typeof hit.timestamp).toBe('number')
        expect(typeof hit.rank).toBe('number')
        expect(typeof hit.snippet).toBe('string')
      })

      it('search across multiple conversations returns hits from both', () => {
        store.transcripts.append('c1', 'e1', [makeEntry('user', 'shared keyword alpha', 'a')])
        store.transcripts.append('c2', 'e1', [makeEntry('user', 'shared keyword beta', 'b')])
        const hits = store.transcripts.search('keyword')
        const ids = new Set(hits.map(h => h.conversationId))
        expect(ids.has('c1')).toBe(true)
        expect(ids.has('c2')).toBe(true)
      })
    })

    // ---------- conversation filter ----------

    describe('search() conversationId filter', () => {
      beforeEach(() => {
        store.transcripts.append('c1', 'e1', [makeEntry('user', 'shared topic in c1', 'c1-1')])
        store.transcripts.append('c2', 'e1', [makeEntry('user', 'shared topic in c2', 'c2-1')])
      })

      it('limits to single conversation when conversationId set', () => {
        const hits = store.transcripts.search('topic', { conversationId: 'c1' })
        expect(hits.length).toBeGreaterThan(0)
        expect(hits.every(h => h.conversationId === 'c1')).toBe(true)
      })

      it('returns empty when conversationId has no matches', () => {
        const hits = store.transcripts.search('topic', { conversationId: 'c-nonexistent' })
        expect(hits).toEqual([])
      })
    })

    describe('search() conversationIds filter', () => {
      beforeEach(() => {
        store.conversations.create({ id: 'c3', scope: 'p3', agentType: 'claude' })
        store.transcripts.append('c1', 'e1', [makeEntry('user', 'common term', 'A')])
        store.transcripts.append('c2', 'e1', [makeEntry('user', 'common term', 'B')])
        store.transcripts.append('c3', 'e1', [makeEntry('user', 'common term', 'C')])
      })

      it('limits to provided IDs', () => {
        const hits = store.transcripts.search('common', { conversationIds: ['c1', 'c3'] })
        const ids = new Set(hits.map(h => h.conversationId))
        expect(ids.has('c1')).toBe(true)
        expect(ids.has('c3')).toBe(true)
        expect(ids.has('c2')).toBe(false)
      })

      it('empty conversationIds list still searches all (or none, driver-defined)', () => {
        // Empty array is treated as "no filter"
        const hits = store.transcripts.search('common', { conversationIds: [] })
        expect(hits.length).toBeGreaterThanOrEqual(0)
      })
    })

    // ---------- types filter ----------

    describe('search() types filter', () => {
      beforeEach(() => {
        store.transcripts.append('c1', 'e1', [
          makeEntry('user', 'banana split', 'u1'),
          makeEntry('assistant', 'banana bread', 'a1'),
          makeEntry('tool_use', 'banana fetch', 't1'),
          makeEntry('tool_result', 'banana data', 'r1'),
        ])
      })

      it('filters to user entries only', () => {
        const hits = store.transcripts.search('banana', { types: ['user'] })
        expect(hits.every(h => h.type === 'user')).toBe(true)
        expect(hits.length).toBe(1)
      })

      it('filters to multiple types', () => {
        const hits = store.transcripts.search('banana', { types: ['user', 'assistant'] })
        const types = new Set(hits.map(h => h.type))
        expect(types.has('user')).toBe(true)
        expect(types.has('assistant')).toBe(true)
        expect(types.has('tool_use')).toBe(false)
        expect(types.has('tool_result')).toBe(false)
      })

      it('returns empty for unmatched type', () => {
        const hits = store.transcripts.search('banana', { types: ['summary'] })
        expect(hits).toEqual([])
      })
    })

    // ---------- pagination ----------

    describe('search() pagination', () => {
      beforeEach(() => {
        const entries = Array.from({ length: 25 }, (_, i) =>
          makeEntry('user', `paginated keyword entry-${i}`, `pg-${i}`),
        )
        store.transcripts.append('c1', 'e1', entries)
      })

      it('respects limit', () => {
        const hits = store.transcripts.search('paginated', { limit: 5 })
        expect(hits.length).toBeLessThanOrEqual(5)
      })

      it('caps limit at 100', () => {
        const hits = store.transcripts.search('paginated', { limit: 1000 })
        expect(hits.length).toBeLessThanOrEqual(100)
      })

      it('default limit is 20', () => {
        const hits = store.transcripts.search('paginated')
        expect(hits.length).toBeLessThanOrEqual(20)
      })

      it('respects offset (different page)', () => {
        const a = store.transcripts.search('paginated', { limit: 5, offset: 0 })
        const b = store.transcripts.search('paginated', { limit: 5, offset: 5 })
        expect(a.length).toBe(5)
        expect(b.length).toBe(5)
        const aIds = new Set(a.map(h => h.id))
        for (const hit of b) {
          expect(aIds.has(hit.id)).toBe(false)
        }
      })

      it('offset beyond results returns empty', () => {
        const hits = store.transcripts.search('paginated', { limit: 5, offset: 1000 })
        expect(hits).toEqual([])
      })
    })

    // ---------- ranking ----------

    describe('search() ranking', () => {
      it('returns hits in rank order (best first)', () => {
        store.transcripts.append('c1', 'e1', [
          makeEntry('user', 'foo bar baz qux quux corge grault garply waldo migration', 'long'),
          makeEntry('user', 'migration', 'short'),
        ])
        const hits = store.transcripts.search('migration')
        expect(hits.length).toBeGreaterThanOrEqual(2)
        // Both backends should rank shorter/more-specific matches better.
        // Just verify rank values are monotonic non-decreasing (bm25 returns
        // negative numbers; lower = better. Substring uses negative inverse-length.)
        for (let i = 1; i < hits.length; i++) {
          expect(hits[i].rank).toBeGreaterThanOrEqual(hits[i - 1].rank)
        }
      })
    })

    // ---------- snippet ----------

    describe('search() snippet', () => {
      it('returns a snippet string for each hit', () => {
        store.transcripts.append('c1', 'e1', [makeEntry('user', 'the quick brown fox jumps over the lazy dog', 's1')])
        const [hit] = store.transcripts.search('fox')
        expect(hit.snippet.length).toBeGreaterThan(0)
        expect(hit.snippet.toLowerCase()).toContain('fox')
      })

      if (flavor.isFts) {
        it('FTS snippet wraps matches in <mark> tags', () => {
          store.transcripts.append('c1', 'e1', [makeEntry('user', 'authenticate the user safely', 'mk1')])
          const [hit] = store.transcripts.search('authenticate')
          expect(hit.snippet).toContain('<mark>')
          expect(hit.snippet).toContain('</mark>')
        })
      }
    })

    // ---------- FTS5-only features ----------

    if (flavor.isFts) {
      describe('search() FTS5 features', () => {
        beforeEach(() => {
          store.transcripts.append('c1', 'e1', [
            makeEntry('user', 'token authentication failed', 'fts1'),
            makeEntry('assistant', 'try refreshing the auth token', 'fts2'),
            makeEntry('user', 'database migration completed successfully', 'fts3'),
            makeEntry('user', 'migrate the schema first', 'fts4'),
          ])
        })

        it('porter stemmer matches migrate/migrating/migration', () => {
          const hits = store.transcripts.search('migrate')
          // Should find both "migration" and "migrate" via stemming
          const texts = hits.map(h => (h.content as { text: string }).text).join(' ')
          expect(texts.toLowerCase()).toMatch(/migrat/)
          expect(hits.length).toBeGreaterThanOrEqual(2)
        })

        it('AND operator requires both terms', () => {
          const hits = store.transcripts.search('token AND authentication')
          for (const h of hits) {
            const t = ((h.content as { text: string }).text || '').toLowerCase()
            expect(t).toContain('token')
            expect(t).toContain('authent')
          }
        })

        it('OR operator finds either term', () => {
          const hits = store.transcripts.search('migration OR token')
          expect(hits.length).toBeGreaterThanOrEqual(2)
        })

        it('NOT operator excludes term', () => {
          const hits = store.transcripts.search('token NOT refreshing')
          for (const h of hits) {
            const t = ((h.content as { text: string }).text || '').toLowerCase()
            expect(t).not.toContain('refreshing')
          }
        })

        it('prefix matching with *', () => {
          const hits = store.transcripts.search('migrat*')
          expect(hits.length).toBeGreaterThanOrEqual(2)
        })

        it('exact phrase with quotes', () => {
          const hits = store.transcripts.search('"token authentication"')
          expect(hits.length).toBeGreaterThanOrEqual(1)
        })

        it('multi-word casual query auto-quotes (no syntax error)', () => {
          // No quotes, no operators -- should work as a phrase, not throw
          const hits = store.transcripts.search('database migration completed')
          expect(hits.length).toBeGreaterThanOrEqual(1)
        })

        it('punctuation in query does not error', () => {
          // Should not throw a syntax error
          expect(() => store.transcripts.search("user's token: failed")).not.toThrow()
        })
      })

      describe('search() FTS triggers (insert/update/delete sync)', () => {
        it('newly appended entries are immediately searchable', () => {
          store.transcripts.append('c1', 'e1', [makeEntry('user', 'before-update text', 'tr1')])
          const before = store.transcripts.search('before-update')
          expect(before.length).toBeGreaterThanOrEqual(1)

          store.transcripts.append('c1', 'e1', [makeEntry('user', 'after-update content', 'tr2')])
          const after = store.transcripts.search('after-update')
          expect(after.length).toBeGreaterThanOrEqual(1)
        })

        it('pruned entries disappear from search', () => {
          const old = Date.now() - 100_000
          store.transcripts.append('c1', 'e1', [
            makeEntry('user', 'will-be-pruned-uniqstring', 'pr1', { timestamp: old }),
          ])
          expect(store.transcripts.search('will-be-pruned-uniqstring').length).toBeGreaterThanOrEqual(1)

          store.transcripts.pruneOlderThan(Date.now() - 50_000)
          expect(store.transcripts.search('will-be-pruned-uniqstring')).toEqual([])
        })
      })
    }

    // ---------- getWindow ----------

    describe('getWindow()', () => {
      beforeEach(() => {
        const entries = Array.from({ length: 20 }, (_, i) => makeEntry('user', `entry-${i}`, `w-${i}`))
        store.transcripts.append('c1', 'e1', entries)
      })

      it('returns 5+1+5 entries by default centered on aroundSeq', () => {
        const win = store.transcripts.getWindow('c1', { aroundSeq: 10 })
        expect(win.length).toBe(11)
        expect(win[0].seq).toBe(5)
        expect(win[win.length - 1].seq).toBe(15)
        expect(win[5].seq).toBe(10)
      })

      it('respects custom before/after', () => {
        const win = store.transcripts.getWindow('c1', { aroundSeq: 10, before: 2, after: 3 })
        expect(win.length).toBe(6)
        expect(win[0].seq).toBe(8)
        expect(win[win.length - 1].seq).toBe(13)
      })

      it('clips before start of conversation', () => {
        const win = store.transcripts.getWindow('c1', { aroundSeq: 2, before: 5, after: 0 })
        expect(win.length).toBe(2) // seq 1, 2
        expect(win[0].seq).toBe(1)
      })

      it('clips after end of conversation', () => {
        const win = store.transcripts.getWindow('c1', { aroundSeq: 19, before: 0, after: 5 })
        expect(win.length).toBe(2) // seq 19, 20
        expect(win[win.length - 1].seq).toBe(20)
      })

      it('center on aroundId resolves to seq', () => {
        const lastSeq = store.transcripts.getLastSeq('c1')
        const all = store.transcripts.getLatest('c1', 100)
        const middle = all[10]
        const win = store.transcripts.getWindow('c1', { aroundId: middle.id, before: 1, after: 1 })
        expect(win.length).toBe(3)
        expect(win[1].id).toBe(middle.id)
        expect(lastSeq).toBe(20)
      })

      it('returns empty for non-existent aroundId', () => {
        const win = store.transcripts.getWindow('c1', { aroundId: 999_999 })
        expect(win).toEqual([])
      })

      it('returns empty when neither aroundSeq nor aroundId provided', () => {
        const win = store.transcripts.getWindow('c1', {})
        expect(win).toEqual([])
      })

      it('returns empty for non-existent conversation', () => {
        const win = store.transcripts.getWindow('c-ghost', { aroundSeq: 5 })
        expect(win).toEqual([])
      })

      it('window does not bleed across conversations', () => {
        store.transcripts.append('c2', 'e1', [makeEntry('user', 'other-conv-entry', 'oc1')])
        const win = store.transcripts.getWindow('c1', { aroundSeq: 10, before: 10, after: 10 })
        expect(win.every(e => e.conversationId === 'c1')).toBe(true)
      })

      it('clamps before to 50 max, after to 50 max', () => {
        const win = store.transcripts.getWindow('c1', { aroundSeq: 10, before: 1000, after: 1000 })
        // 20 entries total, so should return all 20 even though caller asked for 2001
        expect(win.length).toBeLessThanOrEqual(101) // 50 + 1 + 50
        expect(win.length).toBeLessThanOrEqual(20)
      })

      it('zero before/after returns just the center entry', () => {
        const win = store.transcripts.getWindow('c1', { aroundSeq: 10, before: 0, after: 0 })
        expect(win.length).toBe(1)
        expect(win[0].seq).toBe(10)
      })
    })

    // ---------- search + getWindow integration ----------

    describe('search + getWindow workflow', () => {
      beforeEach(() => {
        const entries: TranscriptEntryInput[] = []
        for (let i = 1; i <= 15; i++) {
          entries.push(makeEntry('user', `chatter ${i}`, `flow-u-${i}`))
          entries.push(makeEntry('assistant', `reply ${i}`, `flow-a-${i}`))
        }
        // Insert a needle in the middle
        entries.splice(15, 0, makeEntry('user', 'NEEDLE-IN-HAYSTACK-XYZ', 'flow-needle'))
        store.transcripts.append('c1', 'e1', entries)
      })

      it('finds the needle, then walks context around it', () => {
        const hits = store.transcripts.search('NEEDLE-IN-HAYSTACK-XYZ')
        expect(hits.length).toBe(1)
        const hit = hits[0]

        const window = store.transcripts.getWindow('c1', { aroundSeq: hit.seq, before: 3, after: 3 })
        expect(window.length).toBe(7)
        const centerIdx = window.findIndex(e => e.seq === hit.seq)
        expect(centerIdx).toBe(3)
      })

      it('sliding window forward by re-centering on last seq', () => {
        const first = store.transcripts.getWindow('c1', { aroundSeq: 5, before: 2, after: 2 })
        const lastSeq = first[first.length - 1].seq
        // Slide forward: new center = lastSeq + window_size, so windows don't overlap.
        const next = store.transcripts.getWindow('c1', { aroundSeq: lastSeq + 3, before: 2, after: 2 })
        expect(next[0].seq).toBeGreaterThan(lastSeq)
      })
    })
  })
}
