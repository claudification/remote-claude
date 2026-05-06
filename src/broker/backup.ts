import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { BUILD_VERSION } from '../shared/version'

const DATABASES = ['store.db', 'analytics.db', 'projects.db'] as const
const FLAT_FILES = ['auth.json', 'auth.secret', 'sentinel-registry.json'] as const

const BACKUP_PREFIX = 'backup-'
const BACKUP_PATTERN = /^backup-(\d{8}-\d{6})\.tar\.gz$/

export interface BackupManifest {
  timestamp: string
  hostname: string
  version: {
    gitHash: string
    gitHashShort: string
    branch: string
    buildTime: string
    dirty: boolean
  }
  files: Array<{
    path: string
    size: number
    sha256: string
  }>
  durationMs: number
}

export interface BackupInfo {
  filename: string
  timestamp: Date
  size: number
}

export interface BackupCreateOptions {
  cacheDir: string
  destDir: string
  includeBlobs?: boolean
  retainHours?: number
  retainDays?: number
}

function formatTimestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return [
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`,
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`,
  ].join('-')
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// Map of database name -> derived artifacts (FTS tables, triggers) that are
// fully rebuildable from base tables. Stripped from snapshots; recreated by
// createSchema()'s backfill logic on next startup.
const DERIVED_ARTIFACTS: Record<string, { triggers: string[]; tables: string[] }> = {
  'store.db': {
    triggers: ['transcript_fts_ai', 'transcript_fts_ad', 'transcript_fts_au'],
    tables: ['transcript_fts'],
  },
}

function stripDerivedArtifacts(dbPath: string, dbName: string): void {
  const spec = DERIVED_ARTIFACTS[dbName]
  if (!spec) return
  const db = new Database(dbPath)
  try {
    // Drop triggers BEFORE the FTS table -- otherwise dropping the table
    // fires the AFTER DELETE trigger row-by-row, which is slow and writes
    // to the FTS shadows we're about to discard anyway.
    for (const t of spec.triggers) {
      db.run(`DROP TRIGGER IF EXISTS ${t}`)
    }
    for (const t of spec.tables) {
      db.run(`DROP TABLE IF EXISTS ${t}`)
    }
    db.run('VACUUM')
  } finally {
    db.close()
  }
}

function isBrokerRunning(cacheDir: string): boolean {
  const pidFile = join(cacheDir, 'broker.pid')
  if (!existsSync(pidFile)) return false
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function parseBackupTimestamp(filename: string): Date | null {
  const m = filename.match(BACKUP_PATTERN)
  if (!m) return null
  const d = m[1]
  return new Date(
    parseInt(d.slice(0, 4), 10),
    parseInt(d.slice(4, 6), 10) - 1,
    parseInt(d.slice(6, 8), 10),
    parseInt(d.slice(9, 11), 10),
    parseInt(d.slice(11, 13), 10),
    parseInt(d.slice(13, 15), 10),
  )
}

// ── Create ──────────────────────────────────────────────────────

export async function createBackup(opts: BackupCreateOptions): Promise<string> {
  const { cacheDir, destDir, includeBlobs = false, retainHours = 24, retainDays = 7 } = opts
  const start = Date.now()
  const now = new Date()
  const tag = formatTimestamp(now)
  const tmpDir = join(destDir, `_tmp_backup_${tag}`)
  const archiveName = `${BACKUP_PREFIX}${tag}.tar.gz`
  const archivePath = join(destDir, archiveName)

  mkdirSync(destDir, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })

  const manifestFiles: BackupManifest['files'] = []

  try {
    console.log('Backing up databases...')
    for (const dbName of DATABASES) {
      const srcPath = join(cacheDir, dbName)
      if (!existsSync(srcPath)) {
        console.log(`  skip ${dbName} (not found)`)
        continue
      }
      const destPath = join(tmpDir, dbName)
      const db = new Database(srcPath)
      try {
        db.run(`VACUUM INTO '${destPath}'`)
      } finally {
        db.close()
      }

      // Strip derived/rebuildable artifacts from the snapshot so the archive
      // stays lean. The FTS5 index over transcript_entries.content is fully
      // rebuildable from the source rows -- the broker's schema bootstrap
      // (createSchema) detects an empty FTS table with non-empty source rows
      // and backfills automatically on next startup.
      stripDerivedArtifacts(destPath, dbName)

      const size = statSync(destPath).size
      manifestFiles.push({ path: dbName, size, sha256: sha256File(destPath) })
      console.log(`  ${dbName}: ${(size / 1024 / 1024).toFixed(1)} MB`)
    }

    console.log('Copying config files...')
    for (const name of FLAT_FILES) {
      const srcPath = join(cacheDir, name)
      if (!existsSync(srcPath)) {
        console.log(`  skip ${name} (not found)`)
        continue
      }
      copyFileSync(srcPath, join(tmpDir, name))
      const size = statSync(join(tmpDir, name)).size
      manifestFiles.push({ path: name, size, sha256: sha256File(join(tmpDir, name)) })
      console.log(`  ${name}: ${(size / 1024).toFixed(1)} KB`)
    }

    if (includeBlobs) {
      const blobDir = join(cacheDir, 'blobs')
      if (existsSync(blobDir)) {
        console.log('Copying blobs...')
        const destBlobDir = join(tmpDir, 'blobs')
        mkdirSync(destBlobDir, { recursive: true })
        const cp = Bun.spawn(['cp', '-a', `${blobDir}/.`, destBlobDir], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
        await cp.exited
        let totalSize = 0
        let count = 0
        for (const f of readdirSync(destBlobDir)) {
          const st = statSync(join(destBlobDir, f))
          if (st.isFile()) {
            totalSize += st.size
            count++
          }
        }
        manifestFiles.push({ path: 'blobs/', size: totalSize, sha256: '(directory)' })
        console.log(`  blobs: ${count} files, ${(totalSize / 1024 / 1024).toFixed(1)} MB`)
      }
    }

    const manifest: BackupManifest = {
      timestamp: now.toISOString(),
      hostname: hostname(),
      version: {
        gitHash: BUILD_VERSION.gitHash,
        gitHashShort: BUILD_VERSION.gitHashShort,
        branch: BUILD_VERSION.branch,
        buildTime: BUILD_VERSION.buildTime,
        dirty: BUILD_VERSION.dirty,
      },
      files: manifestFiles,
      durationMs: 0,
    }

    await Bun.write(join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

    console.log('Compressing...')
    const tar = Bun.spawn(['tar', '-czf', archivePath, '-C', tmpDir, '.'], {
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const tarExit = await tar.exited
    if (tarExit !== 0) {
      const stderr = await new Response(tar.stderr).text()
      throw new Error(`tar failed (exit ${tarExit}): ${stderr}`)
    }

    manifest.durationMs = Date.now() - start

    const archiveSize = statSync(archivePath).size
    const totalData = manifestFiles.reduce((s, f) => s + f.size, 0)
    const ratio = totalData > 0 ? ((1 - archiveSize / totalData) * 100).toFixed(1) : '0'

    console.log(`\nBackup complete: ${archiveName}`)
    console.log(`  Archive:  ${(archiveSize / 1024 / 1024).toFixed(1)} MB (${ratio}% compression)`)
    console.log(`  Source:   ${(totalData / 1024 / 1024).toFixed(1)} MB`)
    console.log(`  Duration: ${manifest.durationMs}ms`)
    console.log(`  Broker:   ${BUILD_VERSION.gitHashShort} (${BUILD_VERSION.branch})`)

    pruneBackups(destDir, retainHours, retainDays)

    return archivePath
  } finally {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── List ────────────────────────────────────────────────────────

export function listBackups(destDir: string): BackupInfo[] {
  if (!existsSync(destDir)) return []

  const results: BackupInfo[] = []
  for (const filename of readdirSync(destDir).sort().reverse()) {
    const ts = parseBackupTimestamp(filename)
    if (!ts) continue
    results.push({ filename, timestamp: ts, size: statSync(join(destDir, filename)).size })
  }
  return results
}

// ── Restore ─────────────────────────────────────────────────────

export async function restoreBackup(archivePath: string, cacheDir: string): Promise<void> {
  if (!existsSync(archivePath)) throw new Error(`Archive not found: ${archivePath}`)
  if (isBrokerRunning(cacheDir)) {
    throw new Error('Broker is running -- stop it before restoring (broker.pid is active)')
  }

  const tmpDir = join(cacheDir, '_tmp_restore')
  mkdirSync(tmpDir, { recursive: true })

  try {
    console.log(`Extracting ${archivePath}...`)
    const tar = Bun.spawn(['tar', '-xzf', archivePath, '-C', tmpDir], {
      stdout: 'ignore',
      stderr: 'pipe',
    })
    if ((await tar.exited) !== 0) {
      throw new Error(`tar extract failed: ${await new Response(tar.stderr).text()}`)
    }

    const manifestPath = join(tmpDir, 'manifest.json')
    if (!existsSync(manifestPath)) throw new Error('Archive has no manifest.json -- cannot verify')
    const manifest: BackupManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))

    console.log(`Backup from: ${manifest.timestamp}`)
    console.log(`Broker:      ${manifest.version.gitHashShort} (${manifest.version.branch})`)
    console.log('Verifying checksums...')

    for (const entry of manifest.files) {
      if (entry.sha256 === '(directory)') continue
      const filePath = join(tmpDir, entry.path)
      if (!existsSync(filePath)) throw new Error(`Missing file: ${entry.path}`)
      const actual = sha256File(filePath)
      if (actual !== entry.sha256) {
        throw new Error(
          `Checksum mismatch: ${entry.path} (expected ${entry.sha256.slice(0, 12)}..., got ${actual.slice(0, 12)}...)`,
        )
      }
      console.log(`  ${entry.path}: OK`)
    }

    console.log('Restoring files...')
    for (const entry of manifest.files) {
      const srcPath = join(tmpDir, entry.path)
      if (entry.sha256 === '(directory)') {
        if (existsSync(srcPath)) {
          const destPath = join(cacheDir, entry.path)
          mkdirSync(destPath, { recursive: true })
          const cp = Bun.spawn(['cp', '-a', `${srcPath}/.`, destPath], {
            stdout: 'ignore',
            stderr: 'ignore',
          })
          await cp.exited
          console.log(`  ${entry.path} restored`)
        }
        continue
      }
      copyFileSync(srcPath, join(cacheDir, entry.path))
      console.log(`  ${entry.path}: ${(entry.size / 1024 / 1024).toFixed(2)} MB`)
    }

    console.log(`\nRestore complete. ${manifest.files.length} files from ${manifest.timestamp}`)
  } finally {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ── Prune ───────────────────────────────────────────────────────

function pruneBackups(destDir: string, retainHours: number, retainDays: number): void {
  const backups = listBackups(destDir)
  if (backups.length === 0) return

  const now = Date.now()
  const hourCutoff = now - retainHours * 3600_000
  const dayCutoff = now - retainDays * 86400_000

  const dailyKeepers = new Set<string>()
  const toKeep = new Set<string>()

  for (const b of backups) {
    const ts = b.timestamp.getTime()
    const dayKey = b.timestamp.toISOString().slice(0, 10)

    if (ts >= hourCutoff) {
      toKeep.add(b.filename)
    } else if (ts >= dayCutoff && !dailyKeepers.has(dayKey)) {
      dailyKeepers.add(dayKey)
      toKeep.add(b.filename)
    }
  }

  const toDelete = backups.filter(b => !toKeep.has(b.filename))
  if (toDelete.length > 0) {
    console.log(`\nRetention: keeping ${toKeep.size}, pruning ${toDelete.length} old backup(s)`)
    for (const b of toDelete) {
      rmSync(join(destDir, b.filename))
      console.log(`  deleted ${b.filename}`)
    }
  }
}
