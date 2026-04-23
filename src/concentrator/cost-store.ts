/**
 * Cost reporting store -- SQLite-backed, 30-day retention.
 * Stores per-turn cost and token data, materializes hourly rollups.
 * Uses bun:sqlite with WAL mode and prepared statements for performance.
 */

import { Database, type Statement } from 'bun:sqlite'
import { resolve } from 'node:path'
import { cwdToProjectUri } from '../shared/project-uri'

// bun:sqlite's query().all/get() accept named param objects but the TS types are narrow.
// These wrappers handle the cast for dynamic query building.
type Binds = Record<string, string | number | null>

function queryAll(d: Database, sql: string, binds?: Binds): unknown[] {
  const stmt = d.query(sql)
  return binds ? stmt.all(binds as never) : stmt.all()
}

function queryGet(d: Database, sql: string, binds?: Binds): unknown {
  const stmt = d.query(sql)
  return binds ? stmt.get(binds as never) : stmt.get()
}

// ─── Types ──────────────────────────────────────────────────────────

export interface TurnRecord {
  timestamp: number
  sessionId: string
  cwd: string
  projectUri: string
  account: string
  orgId: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  exactCost: boolean
}

export interface HourlyRow {
  hour: string
  account: string
  model: string
  cwd: string
  projectUri: string
  turnCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

export interface CostSummary {
  period: string
  totalCostUsd: number
  totalTurns: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  topProjects: Array<{ cwd: string; projectUri: string; costUsd: number; turns: number }>
  topModels: Array<{ model: string; costUsd: number; turns: number }>
}

// ─── Module state ───────────────────────────────────────────────────

let db: Database | null = null
let stmtInsertTurn: Statement | null = null
let stmtDeleteOldTurns: Statement | null = null
let stmtDeleteOldHourly: Statement | null = null
let cleanupTimer: ReturnType<typeof setInterval> | null = null

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours

// ─── Init ───────────────────────────────────────────────────────────

export function initCostStore(cacheDir: string): void {
  const dbPath = resolve(cacheDir, 'cost-data.db')
  db = new Database(dbPath, { strict: true })

  // Performance tuning
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = NORMAL')
  db.run('PRAGMA cache_size = -8000') // 8MB cache (modest -- this isn't a heavy DB)

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      project_uri TEXT NOT NULL DEFAULT '',
      account TEXT NOT NULL DEFAULT '',
      org_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      exact_cost INTEGER NOT NULL DEFAULT 0
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS hourly_stats (
      hour TEXT NOT NULL,
      account TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      project_uri TEXT NOT NULL DEFAULT '',
      turn_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (hour, account, model, cwd)
    )
  `)

  // Indexes for query performance
  db.run('CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns(timestamp)')
  db.run('CREATE INDEX IF NOT EXISTS idx_turns_cwd ON turns(cwd)')
  db.run('CREATE INDEX IF NOT EXISTS idx_turns_account ON turns(account)')
  db.run('CREATE INDEX IF NOT EXISTS idx_hourly_hour ON hourly_stats(hour)')

  // Migration: add project_uri columns to existing tables
  const turnCols = db.query("PRAGMA table_info('turns')").all() as Array<{ name: string }>
  if (!turnCols.some(c => c.name === 'project_uri')) {
    db.run('ALTER TABLE turns ADD COLUMN project_uri TEXT')
    db.run("UPDATE turns SET project_uri = 'claude:///' || cwd WHERE project_uri IS NULL AND cwd != ''")
    db.run('CREATE INDEX IF NOT EXISTS idx_turns_project_uri ON turns(project_uri)')
    console.log('[cost] Migrated turns: added project_uri column')
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_turns_project_uri ON turns(project_uri)')

  const hourlyCols = db.query("PRAGMA table_info('hourly_stats')").all() as Array<{ name: string }>
  if (!hourlyCols.some(c => c.name === 'project_uri')) {
    db.run('ALTER TABLE hourly_stats ADD COLUMN project_uri TEXT')
    db.run("UPDATE hourly_stats SET project_uri = 'claude:///' || cwd WHERE project_uri IS NULL AND cwd != ''")
    db.run('CREATE INDEX IF NOT EXISTS idx_hourly_project_uri ON hourly_stats(project_uri)')
    console.log('[cost] Migrated hourly_stats: added project_uri column')
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_hourly_project_uri ON hourly_stats(project_uri)')

  // Prepare insert statement (reused on every turn)
  stmtInsertTurn = db.prepare(`
    INSERT INTO turns (timestamp, session_id, cwd, project_uri, account, org_id, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_usd, exact_cost)
    VALUES ($timestamp, $sessionId, $cwd, $projectUri, $account, $orgId, $model,
      $inputTokens, $outputTokens, $cacheReadTokens, $cacheWriteTokens,
      $costUsd, $exactCost)
  `)

  // Prepare cleanup statements
  stmtDeleteOldTurns = db.prepare('DELETE FROM turns WHERE timestamp < $cutoff')
  stmtDeleteOldHourly = db.prepare('DELETE FROM hourly_stats WHERE hour < $cutoffHour')

  // Run cleanup on startup + every 24h
  cleanup()
  cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS)

  const count = (db.query('SELECT COUNT(*) as n FROM turns').get() as { n: number }).n
  console.log(`[cost] Store initialized: ${dbPath} (${count} turns)`)
}

// ─── Delta tracking ─────────────────────────────────────────────────

// Track cumulative values per session to compute per-turn deltas.
// Session stats are cumulative -- we need deltas for meaningful per-turn records.
const lastSnapshot = new Map<
  string,
  { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUsd: number }
>()

// ─── Insert ─────────────────────────────────────────────────────────

export function recordTurn(record: TurnRecord): void {
  if (!stmtInsertTurn) return
  stmtInsertTurn.run({
    timestamp: record.timestamp,
    sessionId: record.sessionId,
    cwd: record.cwd,
    projectUri: record.projectUri,
    account: record.account,
    orgId: record.orgId,
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    costUsd: record.costUsd,
    exactCost: record.exactCost ? 1 : 0,
  })
}

/**
 * Record a turn using cumulative session values -- computes deltas internally.
 * Callers pass the session's total token/cost values; this function subtracts
 * the previous snapshot to get per-turn deltas. Skips if no delta detected.
 */
export function recordTurnFromCumulatives(params: {
  timestamp: number
  sessionId: string
  cwd: string
  account: string
  orgId: string
  model: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheRead: number
  totalCacheWrite: number
  totalCostUsd: number
  exactCost: boolean
}): void {
  if (!stmtInsertTurn) return

  const prev = lastSnapshot.get(params.sessionId) || {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
  }

  const dIn = params.totalInputTokens - prev.inputTokens
  const dOut = params.totalOutputTokens - prev.outputTokens
  const dCR = params.totalCacheRead - prev.cacheRead
  const dCW = params.totalCacheWrite - prev.cacheWrite
  const dCost = params.totalCostUsd - prev.costUsd

  // Skip if no new tokens (e.g. duplicate events)
  if (dIn <= 0 && dOut <= 0) return

  recordTurn({
    timestamp: params.timestamp,
    sessionId: params.sessionId,
    cwd: params.cwd,
    projectUri: cwdToProjectUri(params.cwd),
    account: params.account,
    orgId: params.orgId,
    model: params.model,
    inputTokens: dIn,
    outputTokens: dOut,
    cacheReadTokens: dCR,
    cacheWriteTokens: dCW,
    costUsd: Math.max(0, dCost),
    exactCost: params.exactCost,
  })

  lastSnapshot.set(params.sessionId, {
    inputTokens: params.totalInputTokens,
    outputTokens: params.totalOutputTokens,
    cacheRead: params.totalCacheRead,
    cacheWrite: params.totalCacheWrite,
    costUsd: params.totalCostUsd,
  })
}

// ─── Query: raw turns ───────────────────────────────────────────────

interface TurnQueryParams {
  from?: number
  to?: number
  account?: string
  model?: string
  cwd?: string
  limit?: number
  offset?: number
}

export function queryTurns(params: TurnQueryParams): { rows: TurnRecord[]; total: number } {
  if (!db) return { rows: [], total: 0 }

  const conditions: string[] = []
  const binds: Binds = {}

  if (params.from) {
    conditions.push('timestamp >= $from')
    binds.from = params.from
  }
  if (params.to) {
    conditions.push('timestamp <= $to')
    binds.to = params.to
  }
  if (params.account) {
    conditions.push('account = $account')
    binds.account = params.account
  }
  if (params.model) {
    conditions.push('model LIKE $model')
    binds.model = `%${params.model}%`
  }
  if (params.cwd) {
    conditions.push('cwd = $cwd')
    binds.cwd = params.cwd
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.min(params.limit || 100, 1000)
  const offset = params.offset || 0

  const countRow = queryGet(db, `SELECT COUNT(*) as n FROM turns ${where}`, binds) as { n: number }
  const rows = queryAll(
    db,
    `SELECT timestamp, session_id, cwd, COALESCE(project_uri, '') as project_uri,
    account, org_id, model,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    cost_usd, exact_cost
    FROM turns ${where} ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${offset}`,
    binds,
  ) as Array<Record<string, unknown>>

  return {
    total: countRow.n,
    rows: rows.map(r => ({
      timestamp: r.timestamp as number,
      sessionId: r.session_id as string,
      cwd: r.cwd as string,
      projectUri: (r.project_uri as string) || '',
      account: r.account as string,
      orgId: r.org_id as string,
      model: r.model as string,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      cacheReadTokens: r.cache_read_tokens as number,
      cacheWriteTokens: r.cache_write_tokens as number,
      costUsd: r.cost_usd as number,
      exactCost: !!(r.exact_cost as number),
    })),
  }
}

// ─── Query: hourly aggregation ──────────────────────────────────────

interface HourlyQueryParams {
  from?: number
  to?: number
  account?: string
  model?: string
  cwd?: string
  groupBy?: 'hour' | 'day'
}

export function queryHourly(params: HourlyQueryParams): HourlyRow[] {
  if (!db) return []

  // Materialize any stale rollups first
  materializeHourly(params.from, params.to)

  const conditions: string[] = []
  const binds: Binds = {}

  if (params.from) {
    conditions.push('hour >= $from')
    binds.from = toHourKey(params.from)
  }
  if (params.to) {
    conditions.push('hour <= $to')
    binds.to = toHourKey(params.to)
  }
  if (params.account) {
    conditions.push('account = $account')
    binds.account = params.account
  }
  if (params.model) {
    conditions.push('model LIKE $model')
    binds.model = `%${params.model}%`
  }
  if (params.cwd) {
    conditions.push('cwd = $cwd')
    binds.cwd = params.cwd
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // Group by day if requested (aggregate hour keys to date prefix)
  if (params.groupBy === 'day') {
    const rows = queryAll(
      db,
      `SELECT substr(hour, 1, 10) as hour, account, model, cwd,
      MIN(project_uri) as project_uri,
      SUM(turn_count) as turn_count, SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens, SUM(cache_read_tokens) as cache_read_tokens,
      SUM(cache_write_tokens) as cache_write_tokens, SUM(cost_usd) as cost_usd
      FROM hourly_stats ${where}
      GROUP BY substr(hour, 1, 10), account, model, cwd
      ORDER BY hour`,
      binds,
    ) as Array<Record<string, unknown>>
    return rows.map(mapHourlyRow)
  }

  const rows = queryAll(db, `SELECT * FROM hourly_stats ${where} ORDER BY hour`, binds) as Array<
    Record<string, unknown>
  >
  return rows.map(mapHourlyRow)
}

// ─── Query: summary ─────────────────────────────────────────────────

export function querySummary(period: '24h' | '7d' | '30d'): CostSummary {
  if (!db) {
    return {
      period,
      totalCostUsd: 0,
      totalTurns: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      topProjects: [],
      topModels: [],
    }
  }

  const cutoff = Date.now() - periodToMs(period)

  const b = { cutoff }
  const totals = queryGet(
    db,
    `SELECT COUNT(*) as turns,
    COALESCE(SUM(cost_usd), 0) as cost,
    COALESCE(SUM(input_tokens), 0) as input_t,
    COALESCE(SUM(output_tokens), 0) as output_t,
    COALESCE(SUM(cache_read_tokens), 0) as cache_r,
    COALESCE(SUM(cache_write_tokens), 0) as cache_w
    FROM turns WHERE timestamp >= $cutoff`,
    b,
  ) as Record<string, number>

  const topProjects = queryAll(
    db,
    `SELECT project_uri, MIN(cwd) as cwd, SUM(cost_usd) as cost, COUNT(*) as turns
    FROM turns WHERE timestamp >= $cutoff
    GROUP BY project_uri ORDER BY cost DESC LIMIT 10`,
    b,
  ) as Array<{ project_uri: string; cwd: string; cost: number; turns: number }>

  const topModels = queryAll(
    db,
    `SELECT model, SUM(cost_usd) as cost, COUNT(*) as turns
    FROM turns WHERE timestamp >= $cutoff
    GROUP BY model ORDER BY cost DESC LIMIT 10`,
    b,
  ) as Array<{ model: string; cost: number; turns: number }>

  return {
    period,
    totalCostUsd: totals.cost,
    totalTurns: totals.turns,
    totalInputTokens: totals.input_t,
    totalOutputTokens: totals.output_t,
    totalCacheReadTokens: totals.cache_r,
    totalCacheWriteTokens: totals.cache_w,
    topProjects: topProjects.map(p => ({
      cwd: p.cwd,
      projectUri: p.project_uri || '',
      costUsd: p.cost,
      turns: p.turns,
    })),
    topModels: topModels.map(m => ({ model: m.model, costUsd: m.cost, turns: m.turns })),
  }
}

// ─── Hourly rollup materialization ──────────────────────────────────

function materializeHourly(from?: number, to?: number): void {
  if (!db) return

  const cutoffFrom = from || Date.now() - 31 * 24 * 60 * 60 * 1000
  const cutoffTo = to || Date.now()

  // Find the latest materialized hour
  const latest = db.query('SELECT MAX(hour) as h FROM hourly_stats').get() as { h: string | null }
  const latestMs = latest.h ? new Date(latest.h).getTime() : 0

  // Only materialize completed hours (not the current one)
  const currentHour = toHourKey(Date.now())
  const startMs = Math.max(cutoffFrom, latestMs ? new Date(latestMs).getTime() : cutoffFrom)

  // Upsert hourly rollups from turns that are newer than latest materialized
  db.prepare(
    `INSERT OR REPLACE INTO hourly_stats (hour, account, model, cwd, project_uri,
      turn_count, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, cost_usd)
    SELECT
      strftime('%Y-%m-%dT%H:00:00Z', timestamp / 1000, 'unixepoch') as hour,
      account, model, cwd, COALESCE(project_uri, '') as project_uri,
      COUNT(*) as turn_count,
      SUM(input_tokens), SUM(output_tokens),
      SUM(cache_read_tokens), SUM(cache_write_tokens),
      SUM(cost_usd)
    FROM turns
    WHERE timestamp >= $start AND timestamp <= $end
      AND strftime('%Y-%m-%dT%H:00:00Z', timestamp / 1000, 'unixepoch') != $currentHour
    GROUP BY hour, account, model, cwd, project_uri`,
  ).run({ start: startMs, end: cutoffTo, currentHour })
}

// ─── Cleanup ────────────────────────────────────────────────────────

function cleanup(): void {
  if (!db) return
  const cutoff = Date.now() - RETENTION_MS
  const cutoffHour = toHourKey(cutoff)

  const turnsDeleted = stmtDeleteOldTurns?.run({ cutoff })
  const hourlyDeleted = stmtDeleteOldHourly?.run({ cutoffHour })

  if ((turnsDeleted?.changes ?? 0) > 0 || (hourlyDeleted?.changes ?? 0) > 0) {
    console.log(
      `[cost] Cleanup: ${turnsDeleted?.changes ?? 0} turns, ${hourlyDeleted?.changes ?? 0} hourly rows removed (>30d)`,
    )
  }
}

// ─── Shutdown ───────────────────────────────────────────────────────

export function closeCostStore(): void {
  if (cleanupTimer) clearInterval(cleanupTimer)
  if (db) {
    db.run('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    db = null
    stmtInsertTurn = null
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function toHourKey(ms: number): string {
  const d = new Date(ms)
  d.setMinutes(0, 0, 0)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function periodToMs(period: '24h' | '7d' | '30d'): number {
  switch (period) {
    case '24h':
      return 24 * 60 * 60 * 1000
    case '7d':
      return 7 * 24 * 60 * 60 * 1000
    case '30d':
      return 30 * 24 * 60 * 60 * 1000
  }
}

function mapHourlyRow(r: Record<string, unknown>): HourlyRow {
  return {
    hour: r.hour as string,
    account: r.account as string,
    model: r.model as string,
    cwd: r.cwd as string,
    projectUri: (r.project_uri as string) || '',
    turnCount: r.turn_count as number,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    cacheReadTokens: r.cache_read_tokens as number,
    cacheWriteTokens: r.cache_write_tokens as number,
    costUsd: r.cost_usd as number,
  }
}
