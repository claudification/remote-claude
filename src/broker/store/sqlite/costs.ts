import type { Database } from 'bun:sqlite'
import { normalizeProjectUri } from '../../../shared/project-uri'
import type {
  CostPeriod,
  CostStore,
  CostSummary,
  CumulativeTurnInput,
  HourlyFilter,
  HourlyRow,
  TurnFilter,
  TurnRecord,
} from '../types'

function normalizeUri(uri: string): string {
  if (!uri) return uri
  try {
    return normalizeProjectUri(uri)
  } catch {
    return uri
  }
}

type Binds = Record<string, string | number | null>

function queryAll(db: Database, sql: string, binds?: Binds): unknown[] {
  const stmt = db.query(sql)
  return binds ? stmt.all(binds as never) : stmt.all()
}

function queryGet(db: Database, sql: string, binds?: Binds): unknown {
  const stmt = db.query(sql)
  return binds ? stmt.get(binds as never) : stmt.get()
}

function toHourKey(ms: number): string {
  const d = new Date(ms)
  d.setMinutes(0, 0, 0)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function periodToMs(period: CostPeriod): number {
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
    projectUri: (r.project_uri as string) || '',
    turnCount: r.turn_count as number,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    cacheReadTokens: r.cache_read_tokens as number,
    cacheWriteTokens: r.cache_write_tokens as number,
    costUsd: r.cost_usd as number,
  }
}

interface SessionSnapshot {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
}

export function createSqliteCostStore(db: Database): CostStore {
  const stmtInsertTurn = db.prepare(`
    INSERT INTO turns (timestamp, session_id, project_uri, account, org_id, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_usd, exact_cost)
    VALUES ($timestamp, $sessionId, $projectUri, $account, $orgId, $model,
      $inputTokens, $outputTokens, $cacheReadTokens, $cacheWriteTokens,
      $costUsd, $exactCost)
  `)

  const stmtDeleteOldTurns = db.prepare('DELETE FROM turns WHERE timestamp < $cutoff')
  const stmtDeleteOldHourly = db.prepare('DELETE FROM hourly_stats WHERE hour < $cutoffHour')

  const stmtMaterializeHourly = db.prepare(
    `INSERT OR REPLACE INTO hourly_stats (hour, account, model, project_uri,
      turn_count, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, cost_usd)
    SELECT
      strftime('%Y-%m-%dT%H:00:00Z', timestamp / 1000, 'unixepoch') as hour,
      account, model, COALESCE(project_uri, '') as project_uri,
      COUNT(*) as turn_count,
      SUM(input_tokens), SUM(output_tokens),
      SUM(cache_read_tokens), SUM(cache_write_tokens),
      SUM(cost_usd)
    FROM turns
    WHERE timestamp >= $start AND timestamp <= $end
      AND strftime('%Y-%m-%dT%H:00:00Z', timestamp / 1000, 'unixepoch') != $currentHour
    GROUP BY hour, account, model, project_uri`,
  )

  // Per-session cumulative snapshots live in memory -- cheap, reset on restart.
  // After a restart the first turn becomes an outlier (full cumulative as delta);
  // this matches the behavior of the old file-level cost-store.ts.
  const lastSnapshot = new Map<string, SessionSnapshot>()

  function materializeHourly(from?: number, to?: number): void {
    const cutoffFrom = from ?? Date.now() - 31 * 24 * 60 * 60 * 1000
    const cutoffTo = to ?? Date.now()
    const currentHour = toHourKey(Date.now())
    stmtMaterializeHourly.run({ start: cutoffFrom, end: cutoffTo, currentHour })
  }

  function recordTurn(record: TurnRecord): void {
    stmtInsertTurn.run({
      timestamp: record.timestamp,
      sessionId: record.sessionId,
      projectUri: normalizeUri(record.projectUri),
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

  function recordTurnFromCumulatives(params: CumulativeTurnInput): boolean {
    const prev = lastSnapshot.get(params.conversationId) ?? {
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

    if (dIn <= 0 && dOut <= 0) return false

    recordTurn({
      timestamp: params.timestamp,
      sessionId: params.conversationId,
      projectUri: normalizeUri(params.projectUri),
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

    lastSnapshot.set(params.conversationId, {
      inputTokens: params.totalInputTokens,
      outputTokens: params.totalOutputTokens,
      cacheRead: params.totalCacheRead,
      cacheWrite: params.totalCacheWrite,
      costUsd: params.totalCostUsd,
    })
    return true
  }

  function queryTurns(filter: TurnFilter): { rows: TurnRecord[]; total: number } {
    const conditions: string[] = []
    const binds: Binds = {}

    if (filter.from) {
      conditions.push('timestamp >= $from')
      binds.from = filter.from
    }
    if (filter.to) {
      conditions.push('timestamp <= $to')
      binds.to = filter.to
    }
    if (filter.account) {
      conditions.push('account = $account')
      binds.account = filter.account
    }
    if (filter.model) {
      conditions.push('model LIKE $model')
      binds.model = `%${filter.model}%`
    }
    if (filter.projectUri) {
      conditions.push('project_uri = $projectUri')
      binds.projectUri = filter.projectUri
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = Math.min(filter.limit ?? 100, 1000)
    const offset = filter.offset ?? 0

    const countRow = queryGet(db, `SELECT COUNT(*) as n FROM turns ${where}`, binds) as { n: number }
    const rows = queryAll(
      db,
      `SELECT timestamp, session_id, COALESCE(project_uri, '') as project_uri,
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

  function queryHourly(filter: HourlyFilter): HourlyRow[] {
    materializeHourly(filter.from, filter.to)

    const conditions: string[] = []
    const binds: Binds = {}

    if (filter.from) {
      conditions.push('hour >= $from')
      binds.from = toHourKey(filter.from)
    }
    if (filter.to) {
      conditions.push('hour <= $to')
      binds.to = toHourKey(filter.to)
    }
    if (filter.account) {
      conditions.push('account = $account')
      binds.account = filter.account
    }
    if (filter.model) {
      conditions.push('model LIKE $model')
      binds.model = `%${filter.model}%`
    }
    if (filter.projectUri) {
      conditions.push('project_uri = $projectUri')
      binds.projectUri = filter.projectUri
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    if (filter.groupBy === 'day') {
      const rows = queryAll(
        db,
        `SELECT substr(hour, 1, 10) as hour, account, model,
        MIN(project_uri) as project_uri,
        SUM(turn_count) as turn_count, SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens, SUM(cache_read_tokens) as cache_read_tokens,
        SUM(cache_write_tokens) as cache_write_tokens, SUM(cost_usd) as cost_usd
        FROM hourly_stats ${where}
        GROUP BY substr(hour, 1, 10), account, model
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

  function querySummary(period: CostPeriod): CostSummary {
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
      `SELECT project_uri, SUM(cost_usd) as cost, COUNT(*) as turns
      FROM turns WHERE timestamp >= $cutoff
      GROUP BY project_uri ORDER BY cost DESC LIMIT 10`,
      b,
    ) as Array<{ project_uri: string; cost: number; turns: number }>

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
        projectUri: p.project_uri || '',
        costUsd: p.cost,
        turns: p.turns,
      })),
      topModels: topModels.map(m => ({ model: m.model, costUsd: m.cost, turns: m.turns })),
    }
  }

  function pruneOlderThan(cutoffMs: number): { turns: number; hourly: number } {
    const cutoffHour = toHourKey(cutoffMs)
    const turnsResult = stmtDeleteOldTurns.run({ cutoff: cutoffMs })
    const hourlyResult = stmtDeleteOldHourly.run({ cutoffHour })
    return { turns: turnsResult.changes ?? 0, hourly: hourlyResult.changes ?? 0 }
  }

  return {
    recordTurn,
    recordTurnFromCumulatives,
    queryTurns,
    queryHourly,
    querySummary,
    pruneOlderThan,
  }
}
