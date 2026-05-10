/**
 * Regression guard for FTS5 backfill / rebuild perf.
 *
 * Catches the case where someone introduces a per-row N+1 (e.g. switching
 * from FTS5's `'rebuild'` directive to a row-by-row INSERT loop) -- the
 * threshold is set generously so it doesn't flake on slow CI machines, but
 * tightly enough to fire if the implementation accidentally goes O(N) on
 * something expensive.
 *
 * Bun test only -- needs real bun:sqlite + FTS5.
 *
 * For richer numbers across multiple sizes, run `bun scripts/bench-fts-rebuild.ts`.
 */

import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { createSchema } from '../sqlite/schema'
import { createSqliteTranscriptStore } from '../sqlite/transcripts'

const ROW_COUNT = 5_000

// Allow plenty of slack for slow CI (5k rows benchmarks at ~16ms locally;
// allowing 2000ms catches a 100x regression without flaking on shared runners).
const REBUILD_BUDGET_MS = 2_000

// Search after rebuild should still be fast. 5k rows benchmarks at <1ms;
// 200ms catches a multi-order-of-magnitude regression.
const SEARCH_BUDGET_MS = 200

function syntheticContent(seq: number): string {
  return JSON.stringify({
    type: 'user',
    seq,
    message: { role: 'user', content: `entry ${seq} marker-${(seq * 17) % 991} keyword-bench-${seq % 23}` },
  })
}

describe('FTS5 perf regression guard', () => {
  it(`backfills ${ROW_COUNT} rows under ${REBUILD_BUDGET_MS}ms via createSchema`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'fts-perf-'))
    const dbPath = join(dir, 'store.db')
    try {
      // Phase 1: build a fully-populated DB with FTS triggers active.
      {
        const db = new Database(dbPath, { strict: true })
        try {
          createSchema(db)
          db.run(
            "INSERT INTO conversations (id, scope, agent_type, status, created_at) VALUES ('perf', 'perf', 'claude', 'active', 0)",
          )
          const insert = db.prepare(`
            INSERT INTO transcript_entries
              (conversation_id, seq, sync_epoch, type, subtype, agent_id, uuid, content, timestamp, ingested_at)
            VALUES ('perf', $seq, 'perf', 'user', NULL, NULL, $uuid, $content, $ts, $ts)
          `)
          const tx = db.transaction(() => {
            for (let i = 1; i <= ROW_COUNT; i++) {
              insert.run({ seq: i, uuid: `perf-${i}`, content: syntheticContent(i), ts: i })
            }
          })
          tx()
        } finally {
          db.close()
        }
      }

      // Phase 2: strip the FTS shadows -- mimics post-restore state.
      {
        const db = new Database(dbPath, { strict: true })
        try {
          db.run('DROP TRIGGER IF EXISTS transcript_fts_ai')
          db.run('DROP TRIGGER IF EXISTS transcript_fts_ad')
          db.run('DROP TRIGGER IF EXISTS transcript_fts_au')
          db.run('DROP TABLE IF EXISTS transcript_fts')
          db.run('VACUUM')
        } finally {
          db.close()
        }
      }

      // Phase 3: time the createSchema rebuild.
      const start = Date.now()
      const db = new Database(dbPath, { strict: true })
      createSchema(db)
      const rebuildMs = Date.now() - start
      expect(rebuildMs).toBeLessThan(REBUILD_BUDGET_MS)

      // Phase 4: search must still be fast.
      const store = createSqliteTranscriptStore(db)
      const tSearch = Date.now()
      const hits = store.search('keyword-bench-7', { limit: 20 })
      const searchMs = Date.now() - tSearch
      expect(searchMs).toBeLessThan(SEARCH_BUDGET_MS)
      // Sanity: rebuild actually populated the index.
      expect(hits.length).toBeGreaterThan(0)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('live insert path stays fast (5k rows under 2s with FTS triggers active)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fts-live-perf-'))
    const dbPath = join(dir, 'store.db')
    try {
      const db = new Database(dbPath, { strict: true })
      try {
        createSchema(db)
        db.run(
          "INSERT INTO conversations (id, scope, agent_type, status, created_at) VALUES ('live', 'live', 'claude', 'active', 0)",
        )
        const insert = db.prepare(`
          INSERT INTO transcript_entries
            (conversation_id, seq, sync_epoch, type, subtype, agent_id, uuid, content, timestamp, ingested_at)
          VALUES ('live', $seq, 'live', 'user', NULL, NULL, $uuid, $content, $ts, $ts)
        `)
        const start = Date.now()
        const tx = db.transaction(() => {
          for (let i = 1; i <= ROW_COUNT; i++) {
            insert.run({ seq: i, uuid: `live-${i}`, content: syntheticContent(i), ts: i })
          }
        })
        tx()
        const insertMs = Date.now() - start
        // 5k rows benchmarks at ~140ms locally with triggers active.
        // 2000ms catches a regression where triggers do something expensive.
        expect(insertMs).toBeLessThan(2_000)
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
