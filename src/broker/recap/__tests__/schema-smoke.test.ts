import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runStartupMigration, SCHEMA_VERSION } from '../../store/migrate'
import { createSqliteDriver } from '../../store/sqlite/driver'
import type { StoreDriver } from '../../store/types'

describe('Phase 0: recap schema + migration', () => {
  let cacheDir: string
  let store: StoreDriver

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'recap-schema-test-'))
    store = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
    store.init()
  })

  afterEach(() => {
    store.close?.()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('creates recap tables on init', () => {
    const db = new Database(join(cacheDir, 'store.db'))
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name LIKE 'recap%'")
        .all() as Array<{ name: string }>
      const names = tables.map(r => r.name).sort()
      expect(names).toContain('recaps')
      expect(names).toContain('recap_logs')
      expect(names).toContain('recap_chunks')
      expect(names).toContain('recap_tags')
    } finally {
      db.close()
    }
  })

  it('creates recaps_fts virtual table', () => {
    const db = new Database(join(cacheDir, 'store.db'))
    try {
      const fts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recaps_fts'").get() as
        | { name?: string }
        | undefined
      expect(fts?.name).toBe('recaps_fts')
    } finally {
      db.close()
    }
  })

  it('FTS5 round-trip: insert + match returns the row', () => {
    const db = new Database(join(cacheDir, 'store.db'))
    try {
      db.prepare(
        `INSERT INTO recaps_fts (recap_id, project_uri, title, subtitle, keywords, goals, discoveries, side_effects, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'recap_test1',
        'claude://default/test',
        'Test Recap',
        'WAL corruption discovered',
        'sqlite wal corruption btree',
        'fix wal',
        'b-tree desync from docker cp',
        '',
        'docker cp on a live SQLite database corrupts the WAL. Use broker-cli exec instead.',
      )
      const hits = db
        .prepare(
          `SELECT recap_id, snippet(recaps_fts, 8, '<mark>', '</mark>', '...', 8) AS snip
           FROM recaps_fts WHERE recaps_fts MATCH ?`,
        )
        .all('WAL corruption') as Array<{ recap_id: string; snip: string }>
      expect(hits.length).toBe(1)
      expect(hits[0].recap_id).toBe('recap_test1')
      expect(hits[0].snip).toContain('<mark>')
    } finally {
      db.close()
    }
  })

  it('shares table has polymorphic columns target_kind + target_id', () => {
    const db = new Database(join(cacheDir, 'store.db'))
    try {
      const cols = (db.prepare("PRAGMA table_info('shares')").all() as Array<{ name: string }>).map(r => r.name)
      expect(cols).toContain('target_kind')
      expect(cols).toContain('target_id')
    } finally {
      db.close()
    }
  })

  it('migration v4->v5 backfills target_id from conversation_id on legacy share rows', () => {
    // Seed a legacy share row via the store API so its connection stays
    // consistent. createShareRecord goes through the share store; we go
    // raw because the store's create path may already populate target_id.
    store.shares.create({
      token: 'share_legacy_1',
      conversationId: 'conv_xyz',
      permissions: { read: true },
      expiresAt: Date.now() + 86400000,
    })
    // Reset target_id back to '' to simulate a pre-v5 row, then rewind
    // schema-version so runStartupMigration treats this as a v4->v5 upgrade.
    store.kv.set('schema-version', 4)
    store.close?.()

    {
      const db = new Database(join(cacheDir, 'store.db'))
      try {
        db.prepare("UPDATE shares SET target_id = '', target_kind = 'conversation' WHERE token = ?").run(
          'share_legacy_1',
        )
      } finally {
        db.close()
      }
    }

    store = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
    store.init()

    const result = runStartupMigration(store, cacheDir)
    expect(result.toVersion).toBe(SCHEMA_VERSION)
    expect(result.sharesBackfilled).toBeGreaterThanOrEqual(1)

    const dbCheck = new Database(join(cacheDir, 'store.db'))
    try {
      const row = dbCheck
        .prepare('SELECT target_id, target_kind FROM shares WHERE token = ?')
        .get('share_legacy_1') as { target_id: string; target_kind: string }
      expect(row.target_id).toBe('conv_xyz')
      expect(row.target_kind).toBe('conversation')
    } finally {
      dbCheck.close()
    }
  })

  it('migration is idempotent: re-running is a no-op', () => {
    const first = runStartupMigration(store, cacheDir)
    expect(first.toVersion).toBe(SCHEMA_VERSION)
    const second = runStartupMigration(store, cacheDir)
    expect(second.skipped).toBe(true)
  })
})
