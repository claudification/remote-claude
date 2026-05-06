#!/usr/bin/env bun
/**
 * Measure FTS5 backfill / rebuild time at several DB scales.
 *
 * Pipeline per size:
 *   1. Fresh tmp DB
 *   2. Bulk-insert N transcript_entries with realistic content (mix of
 *      short user prompts + long assistant turns + tool_use blobs)
 *   3. Drop transcript_fts to simulate post-restore state
 *   4. Time createSchema() -- this triggers the backfill rebuild
 *   5. Also time a follow-up search to confirm the index works
 *
 * Output: a table of (rows, build_ms, throughput, sample_search_ms, db_size_mb)
 *
 * Run: bun scripts/bench-fts-rebuild.ts
 */

import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSchema } from '../src/broker/store/sqlite/schema'
import { createSqliteTranscriptStore } from '../src/broker/store/sqlite/transcripts'

const SIZES = [1_000, 5_000, 25_000, 100_000, 250_000]

interface Row {
  size: number
  buildMs: number
  throughputPerSec: number
  searchMs: number
  searchHits: number
  dbSizeMb: number
  freshIndexMs: number
}

function fmt(n: number, decimals = 0): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

const SAMPLE_TEXTS = [
  'How do I fix the database migration?',
  'I think the authentication token is expired -- check the auth headers',
  'The deploy failed: docker compose returned exit code 137 (oomkilled)',
  'Refactor the conversation-store to use the new SQLite driver',
  'Add an FTS5 index to transcript_entries with porter stemming',
  'The web build is failing because @vitejs/plugin-react is missing',
  'Run the staging tests against the live broker on port 19999',
  'Found a race condition in the message-router on reconnect',
  'Implement pagination for /api/search with limit and offset',
  'Search for "memory leak" across all conversations from last month',
  'The transcript window endpoint clips correctly at conversation boundaries',
  'Wrap the dashboard websocket in a heartbeat-aware reconnection layer',
  'Profile the broker startup -- something is taking 800ms before HTTP starts',
  'Permission gating on /api/search filters by chat:read on each conversation',
  'rclaude-cli backup create --dest /data/backups --retain-days 7',
]

const TOOL_BLOBS = [
  'tool_use: Read { path: "/src/broker/conversation-store.ts", offset: 100, limit: 50 }',
  'tool_use: Bash { command: "git log --oneline -20", description: "Recent commits" }',
  'tool_use: Grep { pattern: "TranscriptStore", glob: "**/*.ts", output_mode: "files_with_matches" }',
  'tool_use: Edit { file_path: "/src/broker/routes/api.ts", old_string: "...", new_string: "..." }',
]

function syntheticContent(seq: number): string {
  const i = seq % SAMPLE_TEXTS.length
  const j = (seq * 7) % TOOL_BLOBS.length
  // Mix in seq-derived gibberish so each row tokenizes to something distinct.
  // Real transcripts vary wildly; this gives the FTS tokenizer real work to do.
  return JSON.stringify({
    type: seq % 3 === 0 ? 'user' : seq % 3 === 1 ? 'assistant' : 'tool_use',
    message: { role: seq % 3 === 0 ? 'user' : 'assistant', content: SAMPLE_TEXTS[i] },
    tool: TOOL_BLOBS[j],
    seq,
    extra: `entry-${seq} unique-${(seq * 31) % 9973} marker-${(seq * 17) % 991}`,
  })
}

async function benchOne(size: number): Promise<Row> {
  const dir = mkdtempSync(join(tmpdir(), `bench-fts-${size}-`))
  const dbPath = join(dir, 'store.db')

  try {
    // Phase 1: build a fresh DB with N rows and a fully-populated FTS index.
    // This measures the "live trigger" path -- per-insert FTS work.
    const t0 = Date.now()
    {
      const db = new Database(dbPath, { strict: true })
      try {
        createSchema(db)
        // Need a conversations row so transcript_entries has a valid scope.
        db.run(
          "INSERT INTO conversations (id, scope, agent_type, status, created_at) VALUES ('bench', 'bench', 'claude', 'active', 0)",
        )

        const insert = db.prepare(`
          INSERT INTO transcript_entries
            (conversation_id, seq, sync_epoch, type, subtype, agent_id, uuid, content, timestamp, ingested_at)
          VALUES ('bench', $seq, 'bench', 'user', NULL, NULL, $uuid, $content, $ts, $ts)
        `)
        const tx = db.transaction(() => {
          for (let i = 1; i <= size; i++) {
            insert.run({ seq: i, uuid: `bench-${i}`, content: syntheticContent(i), ts: i })
          }
        })
        tx()
      } finally {
        db.close()
      }
    }
    const freshIndexMs = Date.now() - t0

    // Phase 2: drop transcript_fts to simulate a post-backup-restore state,
    // then re-open via createSchema. The backfill check sees indexed=0,
    // source>0, fires INSERT INTO transcript_fts(transcript_fts) VALUES('rebuild').
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

    // Capture rebuild time (the createSchema log line goes to stderr; we
    // also time the call from the outside as the source of truth).
    const dbSizeMb = statSync(dbPath).size / (1024 * 1024)
    const t1 = Date.now()
    const db = new Database(dbPath, { strict: true })
    createSchema(db)
    const buildMs = Date.now() - t1

    // Phase 3: confirm the index works -- run a search and time it.
    const store = createSqliteTranscriptStore(db)
    const sampleQuery = 'authentication migration'
    const tSearch = Date.now()
    const hits = store.search(sampleQuery, { limit: 20 })
    const searchMs = Date.now() - tSearch
    db.close()

    return {
      size,
      buildMs,
      throughputPerSec: Math.round((size / Math.max(buildMs, 1)) * 1000),
      searchMs,
      searchHits: hits.length,
      dbSizeMb,
      freshIndexMs,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  console.log('# FTS5 rebuild benchmark')
  console.log(`# Bun ${Bun.version} | macOS ${process.platform}-${process.arch}`)
  console.log('')

  const rows: Row[] = []
  for (const size of SIZES) {
    process.stderr.write(`benchmarking ${fmt(size)} rows... `)
    const row = await benchOne(size)
    rows.push(row)
    process.stderr.write(`build ${fmt(row.buildMs)}ms, search ${fmt(row.searchMs)}ms\n`)
  }

  console.log('')
  console.log('| rows      | live insert | rebuild   | throughput   | db size  | sample search |')
  console.log('| --------- | ----------- | --------- | ------------ | -------- | ------------- |')
  for (const r of rows) {
    const rows = fmt(r.size).padStart(9)
    const insert = `${fmt(r.freshIndexMs)}ms`.padStart(11)
    const rebuild = `${fmt(r.buildMs)}ms`.padStart(9)
    const tput = `${fmt(r.throughputPerSec)}/s`.padStart(12)
    const dbSize = `${r.dbSizeMb.toFixed(1)}MB`.padStart(8)
    const search = `${fmt(r.searchMs)}ms (${r.searchHits})`.padStart(13)
    console.log(`| ${rows} | ${insert} | ${rebuild} | ${tput} | ${dbSize} | ${search} |`)
  }
  console.log('')
  console.log('Notes:')
  console.log('  - "live insert" = total time to insert N rows WITH triggers populating FTS')
  console.log('     (this is the cost during normal chat use, amortized per insert)')
  console.log('  - "rebuild" = time for createSchema()-driven FTS rebuild after a strip-restore')
  console.log('     (this is the cost a broker pays once on startup after restore)')
  console.log('  - "sample search" = single FTS5 MATCH for "authentication migration"')
  console.log('     (operational cost of an actual search query)')
}

main().catch(err => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
