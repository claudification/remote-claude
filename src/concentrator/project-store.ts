/**
 * Project Store -- SQLite-backed project registry.
 *
 * Provides stable integer IDs for projects, replacing repeated CWD/scope
 * strings across analytics, cost, and session stores. The projects table
 * is the single source of truth for project identity.
 *
 * Storage: {cacheDir}/projects.db (separate from analytics/cost -- this is
 * authoritative config, not disposable time-series data).
 *
 * ## Scope URI scheme (future-facing)
 *
 * ```
 * {provider}://{address}#{session}
 * ```
 *
 * - provider: claude, fabric, agent, api, ephemeral, ...
 * - address: host/path or opaque ID. Some providers have hosts, some don't.
 * - session fragment: optional, not all providers support sessions
 *
 * Examples:
 * ```
 * claude://my-machine/Users/jonas/projects/remote-claude#a1b2c3d4
 * claude:///Users/jonas/projects/remote-claude          (local, no host)
 * fabric://pipeline/data-etl-nightly
 * agent://openai/asst_abc123
 * ephemeral://uuid-here
 * ```
 *
 * The `scope` column stores the full URI. The `project_uri` column is
 * the canonical project identity URI, indexed for lookup.
 * Integer `id` is what every other table references.
 */

import { Database, type Statement } from 'bun:sqlite'
import { resolve } from 'node:path'
import { cwdToProjectUri, parseProjectUri } from '../shared/project-uri'

// ─── Types ──────────────────────────────────────────────────────────

export interface Project {
  id: number
  scope: string
  slug: string
  label: string | null
  project_uri: string
}

// ─── Module State ───────────────────────────────────────────────────

let db: Database | null = null
let stmtInsert: Statement | null = null
let stmtByScope: Statement | null = null
let stmtById: Statement | null = null
let stmtBySlug: Statement | null = null
let stmtByProjectUri: Statement | null = null
let stmtUpdateLabel: Statement | null = null
let stmtUpdateScope: Statement | null = null

/** In-memory cache: project_uri -> Project (hot path, avoids DB hit on every hook event) */
const projectCache = new Map<string, Project>()

// ─── Slug derivation ────────────────────────────────────────────────

/** Derive a URL-safe slug from a filesystem path (last segment, lowercased) */
export function slugFromPath(fsPath: string): string {
  if (!fsPath) return 'unknown'
  const segments = fsPath.replace(/\/+$/, '').split('/')
  const last = segments[segments.length - 1]
  return (last || 'unknown').toLowerCase().replace(/[^a-z0-9._-]/g, '-')
}

/** Derive a scope URI from a filesystem path (Claude Code default) */
export function scopeFromPath(fsPath: string): string {
  if (!fsPath) return 'claude:///'
  return `claude://${fsPath}`
}

// ─── Init ───────────────────────────────────────────────────────────

const ALL_COLUMNS = 'id, scope, slug, label, project_uri'

export function initProjectStore(cacheDir: string): void {
  const dbPath = resolve(cacheDir, 'projects.db')
  db = new Database(dbPath, { strict: true })

  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = NORMAL')
  db.run('PRAGMA cache_size = -2000') // 2MB -- small table

  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL,
      label TEXT
    )
  `)

  db.run('CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug)')

  // Migration: add project_uri column if it doesn't exist
  const columns = db.prepare("PRAGMA table_info('projects')").all() as Array<{ name: string }>
  const hasProjectUri = columns.some(c => c.name === 'project_uri')

  if (!hasProjectUri) {
    db.run('ALTER TABLE projects ADD COLUMN project_uri TEXT')
    // Backfill: project_uri = cwdToProjectUri(cwd) for existing rows (only if cwd column exists)
    const hasCwd = columns.some(c => c.name === 'cwd')
    if (hasCwd) {
      const rows = db.prepare('SELECT id, cwd FROM projects WHERE project_uri IS NULL').all() as Array<{
        id: number
        cwd: string
      }>
      const backfill = db.prepare('UPDATE projects SET project_uri = $project_uri WHERE id = $id')
      for (const row of rows) {
        backfill.run({ project_uri: cwdToProjectUri(row.cwd), id: row.id })
      }
      console.log(`[projects] Migrated ${rows.length} rows: backfilled project_uri`)
    }
  }

  // Ensure any remaining NULLs are backfilled (only possible if cwd column still exists)
  const currentCols = db.query("PRAGMA table_info('projects')").all() as Array<{ name: string }>
  const hasCwdCol = currentCols.some(c => c.name === 'cwd')
  if (hasCwdCol) {
    const nullCount = (
      db.prepare('SELECT COUNT(*) as n FROM projects WHERE project_uri IS NULL').get() as { n: number }
    ).n
    if (nullCount > 0) {
      const rows = db.prepare('SELECT id, cwd FROM projects WHERE project_uri IS NULL').all() as Array<{
        id: number
        cwd: string
      }>
      const backfill = db.prepare('UPDATE projects SET project_uri = $project_uri WHERE id = $id')
      for (const row of rows) {
        backfill.run({ project_uri: cwdToProjectUri(row.cwd), id: row.id })
      }
      console.log(`[projects] Backfilled ${nullCount} NULL project_uri values`)
    }
  }

  // Create unique index on project_uri (after backfill, all values are non-null)
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_project_uri ON projects(project_uri)')

  // Migration: drop cwd column (project_uri is now the canonical identity)
  // SQLite can't DROP COLUMN on a column with an inline UNIQUE constraint, so recreate the table.
  const cwdCols = db.query("PRAGMA table_info('projects')").all() as Array<{ name: string }>
  if (cwdCols.some(c => c.name === 'cwd')) {
    db.run('BEGIN TRANSACTION')
    db.run(`CREATE TABLE projects_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL,
      label TEXT,
      project_uri TEXT
    )`)
    db.run(
      'INSERT INTO projects_new (id, scope, slug, label, project_uri) SELECT id, scope, slug, label, project_uri FROM projects',
    )
    db.run('DROP TABLE projects')
    db.run('ALTER TABLE projects_new RENAME TO projects')
    db.run('CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug)')
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_project_uri ON projects(project_uri)')
    db.run('COMMIT')
    console.log('[projects] Migrated: recreated table without cwd column')
  }

  stmtInsert = db.prepare(`
    INSERT INTO projects (scope, slug, label, project_uri) VALUES ($scope, $slug, $label, $project_uri)
  `)
  stmtByScope = db.prepare(`SELECT ${ALL_COLUMNS} FROM projects WHERE scope = $scope`)
  stmtById = db.prepare(`SELECT ${ALL_COLUMNS} FROM projects WHERE id = $id`)
  stmtBySlug = db.prepare(`SELECT ${ALL_COLUMNS} FROM projects WHERE slug = $slug`)
  stmtByProjectUri = db.prepare(`SELECT ${ALL_COLUMNS} FROM projects WHERE project_uri = $project_uri`)
  stmtUpdateLabel = db.prepare('UPDATE projects SET label = $label WHERE id = $id')
  stmtUpdateScope = db.prepare('UPDATE projects SET scope = $scope WHERE id = $id')

  const count = (db.query('SELECT COUNT(*) as n FROM projects').get() as { n: number }).n
  console.log(`[projects] Store initialized: ${dbPath} (${count} projects)`)
}

// ─── Lookup / Create ────────────────────────────────────────────────

/**
 * Get or create a project by project URI. This is the primary entry point --
 * called on every hook event to resolve project URI -> integer project_id.
 *
 * Uses in-memory cache keyed by project URI for the hot path.
 * Cache miss -> DB lookup -> DB insert.
 */
export function getOrCreateProject(projectUri: string, label?: string): Project {
  // Hot path: cache hit
  const cached = projectCache.get(projectUri)
  if (cached) {
    if (label && label !== cached.label) {
      cached.label = label
      stmtUpdateLabel?.run({ label, id: cached.id })
    }
    return cached
  }

  // Cache miss: check DB by project URI
  const existing = stmtByProjectUri?.get({ project_uri: projectUri }) as Project | undefined

  if (existing) {
    if (label && label !== existing.label) {
      existing.label = label
      stmtUpdateLabel?.run({ label, id: existing.id })
    }
    projectCache.set(projectUri, existing)
    return existing
  }

  // Not in DB: create
  const parsed = parseProjectUri(projectUri)
  const slug = slugFromPath(parsed.path)
  const scope = scopeFromPath(parsed.path)
  stmtInsert?.run({ scope, slug, label: label || null, project_uri: projectUri })

  // Re-fetch to get the auto-assigned id
  const created = stmtByProjectUri?.get({ project_uri: projectUri }) as Project
  projectCache.set(projectUri, created)
  return created
}

/** Lookup by integer ID (for display/API) */
export function getProjectById(id: number): Project | null {
  return (stmtById?.get({ id }) as Project) || null
}

/** Lookup by slug (for API filtering: ?project=remote-claude) */
export function getProjectBySlug(slug: string): Project | null {
  return (stmtBySlug?.get({ slug }) as Project) || null
}

/** Lookup by scope URI */
export function getProjectByScope(scope: string): Project | null {
  return (stmtByScope?.get({ scope }) as Project) || null
}

/** Lookup by project URI */
export function getProjectByUri(projectUri: string): Project | null {
  return (stmtByProjectUri?.get({ project_uri: projectUri }) as Project) || null
}

/** List all projects (for admin UI, dashboards) */
export function listProjects(): Project[] {
  if (!db) return []
  return db.query(`SELECT ${ALL_COLUMNS} FROM projects ORDER BY id`).all() as Project[]
}

/** Update the scope URI for a project (for future migration to custom URIs) */
export function updateProjectScope(id: number, scope: string): void {
  stmtUpdateScope?.run({ scope, id })
  for (const [, p] of projectCache) {
    if (p.id === id) {
      p.scope = scope
      break
    }
  }
}

// ─── Shutdown ───────────────────────────────────────────────────────

export function closeProjectStore(): void {
  if (db) {
    try {
      db.run('PRAGMA wal_checkpoint(TRUNCATE)')
      db.close()
    } catch (err) {
      console.error('[projects] Error closing database:', err)
    }
    db = null
    stmtInsert = null
    stmtByScope = null
    stmtById = null
    stmtBySlug = null
    stmtByProjectUri = null
    stmtUpdateLabel = null
    stmtUpdateScope = null
    projectCache.clear()
  }
}
