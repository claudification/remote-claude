/**
 * Backup excludes derived FTS artifacts; restore + reopen rebuilds them.
 *
 * Runs under `bun test` only -- needs real bun:sqlite (FTS5 + VACUUM INTO).
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackup, restoreBackup } from '../backup'
import { createSqliteDriver } from '../store/sqlite/driver'

describe('backup: FTS index is stripped from archives, rebuilt on restore', () => {
  let cacheDir: string
  let backupDir: string
  let restoreCacheDir: string

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'bk-cache-'))
    backupDir = mkdtempSync(join(tmpdir(), 'bk-archives-'))
    restoreCacheDir = mkdtempSync(join(tmpdir(), 'bk-restore-'))
  })

  afterEach(() => {
    for (const d of [cacheDir, backupDir, restoreCacheDir]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {}
    }
  })

  it('archive has no transcript_fts table; restore + open repopulates it', async () => {
    // 1. Seed a store with transcript entries -- triggers populate FTS.
    {
      const driver = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
      driver.conversations.create({ id: 'conv-a', scope: 's', agentType: 'claude' })
      driver.transcripts.append('conv-a', 'epoch', [
        {
          type: 'user',
          uuid: 'u-1',
          content: { text: 'authentication migration completed successfully' },
          timestamp: Date.now(),
        },
        {
          type: 'assistant',
          uuid: 'u-2',
          content: { text: 'database schema looks good after the migration' },
          timestamp: Date.now(),
        },
      ])
      // Sanity: FTS finds it before backup.
      const pre = driver.transcripts.search('migration')
      expect(pre.length).toBeGreaterThanOrEqual(1)
      driver.close()
    }

    // 2. Run backup. (createBackup checks for broker.pid -- absence is fine.)
    const archivePath = await createBackup({
      cacheDir,
      destDir: backupDir,
      retainHours: 1,
      retainDays: 1,
    })

    // 3. Restore into a fresh cache dir.
    await restoreBackup(archivePath, restoreCacheDir)

    // 4. Inspect the restored DB BEFORE the broker reopens it: FTS table
    //    should be absent (stripped from snapshot).
    {
      const raw = new Database(join(restoreCacheDir, 'store.db'))
      try {
        const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all() as Array<{
          name: string
        }>
        const names = new Set(tables.map(t => t.name))
        expect(names.has('transcript_fts')).toBe(false)
        expect(names.has('transcript_fts_ai')).toBe(false)
        expect(names.has('transcript_fts_ad')).toBe(false)
        expect(names.has('transcript_fts_au')).toBe(false)
        // Source data is preserved.
        const cnt = raw.prepare('SELECT COUNT(*) AS c FROM transcript_entries').get() as { c: number }
        expect(cnt.c).toBe(2)
      } finally {
        raw.close()
      }
    }

    // 5. Open via the driver -- createSchema recreates FTS + triggers and
    //    backfills from transcript_entries (since FTS is empty).
    const restored = createSqliteDriver({ type: 'sqlite', dataDir: restoreCacheDir })
    try {
      const hits = restored.transcripts.search('migration')
      expect(hits.length).toBeGreaterThanOrEqual(1)
      // Both rows should be searchable -- backfill ran for the whole table.
      const all = restored.transcripts.search('schema OR authentication')
      expect(all.length).toBeGreaterThanOrEqual(2)

      // New writes after restore go through the (recreated) triggers.
      restored.transcripts.append('conv-a', 'epoch', [
        {
          type: 'user',
          uuid: 'u-3',
          content: { text: 'post-restore-marker indexable' },
          timestamp: Date.now(),
        },
      ])
      const post = restored.transcripts.search('post-restore-marker')
      expect(post.length).toBe(1)
    } finally {
      restored.close()
    }
  })

  it('strip is idempotent: re-stripping an already-stripped DB is a no-op', async () => {
    // Seed and back up twice in a row. Both archives should restore cleanly.
    const driver = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
    driver.conversations.create({ id: 'conv-x', scope: 's', agentType: 'claude' })
    driver.transcripts.append('conv-x', 'epoch', [
      { type: 'user', uuid: 'x1', content: { text: 'idempotent strip test' }, timestamp: Date.now() },
    ])
    driver.close()

    const a1 = await createBackup({ cacheDir, destDir: backupDir, retainHours: 99, retainDays: 99 })
    // Sleep long enough for the second timestamp to differ.
    await new Promise(r => setTimeout(r, 1100))
    const a2 = await createBackup({ cacheDir, destDir: backupDir, retainHours: 99, retainDays: 99 })
    expect(a1).not.toBe(a2)

    // Restore the second one and confirm search works.
    await restoreBackup(a2, restoreCacheDir)
    const restored = createSqliteDriver({ type: 'sqlite', dataDir: restoreCacheDir })
    try {
      const hits = restored.transcripts.search('idempotent')
      expect(hits.length).toBe(1)
    } finally {
      restored.close()
    }
  })
})
