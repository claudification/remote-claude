import { Database } from 'bun:sqlite'
import { join } from 'node:path'

export type RecapStatus = 'queued' | 'gathering' | 'rendering' | 'done' | 'failed' | 'cancelled'
export type RecapPeriodLabel = 'today' | 'yesterday' | 'last_7' | 'last_30' | 'this_week' | 'this_month' | 'custom'
export type RecapLogLevel = 'info' | 'warn' | 'error' | 'debug'

export interface RecapRow {
  id: string
  projectUri: string
  periodLabel: RecapPeriodLabel
  periodStart: number
  periodEnd: number
  timeZone: string
  status: RecapStatus
  progress: number
  phase: string | null
  model: string | null
  inputChars: number
  inputTokens: number
  outputTokens: number
  llmCostUsd: number
  markdown: string | null
  title: string | null
  subtitle: string | null
  error: string | null
  createdAt: number
  createdBy: string | null
  startedAt: number | null
  completedAt: number | null
  dismissedAt: number | null
  signalsJson: string
  signalsHash: string
  inputHash: string | null
  metadataJson: string | null
}

export interface RecapInsert {
  id: string
  projectUri: string
  periodLabel: RecapPeriodLabel
  periodStart: number
  periodEnd: number
  timeZone: string
  signalsJson: string
  signalsHash: string
  createdAt: number
  createdBy?: string
}

export type RecapPatch = Partial<
  Pick<
    RecapRow,
    | 'status'
    | 'progress'
    | 'phase'
    | 'model'
    | 'inputChars'
    | 'inputTokens'
    | 'outputTokens'
    | 'llmCostUsd'
    | 'markdown'
    | 'title'
    | 'subtitle'
    | 'error'
    | 'startedAt'
    | 'completedAt'
    | 'dismissedAt'
    | 'inputHash'
    | 'metadataJson'
  >
>

export interface RecapLogInsert {
  recapId: string
  timestamp: number
  level: RecapLogLevel
  phase: string
  message: string
  data?: unknown
}

export interface RecapLogRow {
  id: number
  recapId: string
  timestamp: number
  level: RecapLogLevel
  phase: string
  message: string
  data: unknown | null
}

export interface RecapChunkInsert {
  id: string
  parentId: string
  chunkKind: 'day' | 'week'
  chunkStart: number
  chunkEnd: number
  markdown: string
  inputChars: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  model: string
  createdAt: number
}

export interface RecapChunkRow extends RecapChunkInsert {}

export interface RecapTagInsert {
  recapId: string
  tag: string
  kind: 'hashtag' | 'keyword' | 'goal' | 'stakeholder'
}

export interface PeriodRecapStore {
  insert(rec: RecapInsert): RecapRow
  get(id: string): RecapRow | null
  list(filter: ListFilter): RecapRow[]
  update(id: string, patch: RecapPatch): void
  delete(id: string): boolean
  appendLog(entry: RecapLogInsert): void
  getLogs(recapId: string): RecapLogRow[]
  insertChunk(chunk: RecapChunkInsert): void
  getChunks(parentId: string): RecapChunkRow[]
  setTags(recapId: string, tags: RecapTagInsert[]): void
  getTags(recapId: string): RecapTagInsert[]
  upsertFts(recapId: string, fields: FtsFields): void
  searchFts(query: string, opts?: { limit?: number; projectUri?: string }): FtsHit[]
  findCacheHit(args: CacheLookupArgs): RecapRow | null
}

export interface ListFilter {
  projectUri?: string
  status?: RecapStatus[]
  limit?: number
}

export interface FtsFields {
  projectUri: string
  title: string
  subtitle: string
  keywords: string
  goals: string
  discoveries: string
  sideEffects: string
  body: string
}

export interface FtsHit {
  recapId: string
  projectUri: string
  snippet: string
  rank: number
}

export interface CacheLookupArgs {
  projectUri: string
  periodStart: number
  periodEnd: number
  signalsHash: string
  freshSinceMs: number
}

export function createPeriodRecapStore(cacheDir: string): PeriodRecapStore {
  const db = new Database(join(cacheDir, 'store.db'), { strict: true })
  return new SqlitePeriodRecapStore(db)
}

class SqlitePeriodRecapStore implements PeriodRecapStore {
  constructor(private readonly db: Database) {}

  insert(rec: RecapInsert): RecapRow {
    this.db
      .prepare(
        `INSERT INTO recaps (id, project_uri, period_label, period_start, period_end, time_zone,
           status, progress, signals_json, signals_hash, created_at, created_by)
         VALUES ($id, $projectUri, $periodLabel, $periodStart, $periodEnd, $timeZone,
           'queued', 0, $signalsJson, $signalsHash, $createdAt, $createdBy)`,
      )
      .run({
        id: rec.id,
        projectUri: rec.projectUri,
        periodLabel: rec.periodLabel,
        periodStart: rec.periodStart,
        periodEnd: rec.periodEnd,
        timeZone: rec.timeZone,
        signalsJson: rec.signalsJson,
        signalsHash: rec.signalsHash,
        createdAt: rec.createdAt,
        createdBy: rec.createdBy ?? null,
      })
    const row = this.get(rec.id)
    if (!row) throw new Error(`recap ${rec.id} vanished after insert`)
    return row
  }

  get(id: string): RecapRow | null {
    const row = this.db.prepare('SELECT * FROM recaps WHERE id = $id').get({ id }) as RawRecapRow | undefined
    return row ? hydrate(row) : null
  }

  // fallow-ignore-next-line complexity
  list(filter: ListFilter): RecapRow[] {
    const limit = filter.limit ?? 50
    const conditions: string[] = []
    const bind: Record<string, unknown> = { limit }
    if (filter.projectUri) {
      conditions.push('project_uri = $projectUri')
      bind.projectUri = filter.projectUri
    }
    if (filter.status?.length) {
      const placeholders = filter.status.map((_, i) => `$status${i}`).join(',')
      conditions.push(`status IN (${placeholders})`)
      filter.status.forEach((s, i) => {
        bind[`status${i}`] = s
      })
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const sql = `SELECT * FROM recaps ${where} ORDER BY created_at DESC LIMIT $limit`
    return (this.db.prepare(sql).all(bind as never) as RawRecapRow[]).map(hydrate)
  }

  // fallow-ignore-next-line complexity
  update(id: string, patch: RecapPatch): void {
    const setClauses: string[] = []
    const bind: Record<string, unknown> = { id }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      const column = camelToSnake(key)
      setClauses.push(`${column} = $${key}`)
      bind[key] = value
    }
    if (setClauses.length === 0) return
    this.db.prepare(`UPDATE recaps SET ${setClauses.join(', ')} WHERE id = $id`).run(bind as never)
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM recaps WHERE id = $id').run({ id })
    return result.changes > 0
  }

  appendLog(entry: RecapLogInsert): void {
    this.db
      .prepare(
        `INSERT INTO recap_logs (recap_id, timestamp, level, phase, message, data_json)
         VALUES ($recapId, $timestamp, $level, $phase, $message, $dataJson)`,
      )
      .run({
        recapId: entry.recapId,
        timestamp: entry.timestamp,
        level: entry.level,
        phase: entry.phase,
        message: entry.message,
        dataJson: entry.data === undefined ? null : JSON.stringify(entry.data),
      })
  }

  getLogs(recapId: string): RecapLogRow[] {
    const rows = this.db
      .prepare('SELECT * FROM recap_logs WHERE recap_id = $recapId ORDER BY timestamp ASC, id ASC')
      .all({ recapId }) as Array<{
      id: number
      recap_id: string
      timestamp: number
      level: RecapLogLevel
      phase: string
      message: string
      data_json: string | null
    }>
    return rows.map(r => ({
      id: r.id,
      recapId: r.recap_id,
      timestamp: r.timestamp,
      level: r.level,
      phase: r.phase,
      message: r.message,
      data: r.data_json ? safeParseJson(r.data_json) : null,
    }))
  }

  insertChunk(chunk: RecapChunkInsert): void {
    this.db
      .prepare(
        `INSERT INTO recap_chunks (id, parent_id, chunk_kind, chunk_start, chunk_end, markdown,
            input_chars, input_tokens, output_tokens, cost_usd, model, created_at)
         VALUES ($id, $parentId, $chunkKind, $chunkStart, $chunkEnd, $markdown,
            $inputChars, $inputTokens, $outputTokens, $costUsd, $model, $createdAt)`,
      )
      .run(chunk as never)
  }

  getChunks(parentId: string): RecapChunkRow[] {
    const rows = this.db
      .prepare('SELECT * FROM recap_chunks WHERE parent_id = $parentId ORDER BY chunk_start')
      .all({ parentId }) as Array<{
      id: string
      parent_id: string
      chunk_kind: 'day' | 'week'
      chunk_start: number
      chunk_end: number
      markdown: string
      input_chars: number
      input_tokens: number
      output_tokens: number
      cost_usd: number
      model: string
      created_at: number
    }>
    return rows.map(r => ({
      id: r.id,
      parentId: r.parent_id,
      chunkKind: r.chunk_kind,
      chunkStart: r.chunk_start,
      chunkEnd: r.chunk_end,
      markdown: r.markdown,
      inputChars: r.input_chars,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costUsd: r.cost_usd,
      model: r.model,
      createdAt: r.created_at,
    }))
  }

  setTags(recapId: string, tags: RecapTagInsert[]): void {
    this.db.prepare('DELETE FROM recap_tags WHERE recap_id = $recapId').run({ recapId })
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO recap_tags (recap_id, tag, kind) VALUES ($recapId, $tag, $kind)',
    )
    for (const t of tags) stmt.run({ recapId: t.recapId, tag: t.tag, kind: t.kind })
  }

  getTags(recapId: string): RecapTagInsert[] {
    return this.db
      .prepare('SELECT recap_id AS recapId, tag, kind FROM recap_tags WHERE recap_id = $recapId')
      .all({ recapId }) as RecapTagInsert[]
  }

  upsertFts(recapId: string, fields: FtsFields): void {
    this.db.prepare('DELETE FROM recaps_fts WHERE recap_id = $recapId').run({ recapId })
    this.db
      .prepare(
        `INSERT INTO recaps_fts (recap_id, project_uri, title, subtitle, keywords, goals, discoveries, side_effects, body)
         VALUES ($recapId, $projectUri, $title, $subtitle, $keywords, $goals, $discoveries, $sideEffects, $body)`,
      )
      .run({ recapId, ...fields })
  }

  searchFts(query: string, opts: { limit?: number; projectUri?: string } = {}): FtsHit[] {
    const limit = opts.limit ?? 20
    const where = opts.projectUri ? 'AND project_uri = $projectUri' : ''
    const bind: Record<string, unknown> = { query, limit }
    if (opts.projectUri) bind.projectUri = opts.projectUri
    const rows = this.db
      .prepare(
        `SELECT recap_id AS recapId, project_uri AS projectUri,
            snippet(recaps_fts, 8, '<mark>', '</mark>', '...', 12) AS snippet,
            rank
         FROM recaps_fts
         WHERE recaps_fts MATCH $query ${where}
         ORDER BY rank
         LIMIT $limit`,
      )
      .all(bind as never) as FtsHit[]
    return rows
  }

  findCacheHit(args: CacheLookupArgs): RecapRow | null {
    const cutoff = Date.now() - args.freshSinceMs
    const row = this.db
      .prepare(
        `SELECT * FROM recaps
         WHERE project_uri = $projectUri
           AND period_start = $periodStart
           AND period_end = $periodEnd
           AND signals_hash = $signalsHash
           AND status = 'done'
           AND completed_at >= $cutoff
         ORDER BY completed_at DESC
         LIMIT 1`,
      )
      .get({
        projectUri: args.projectUri,
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
        signalsHash: args.signalsHash,
        cutoff,
      }) as RawRecapRow | undefined
    return row ? hydrate(row) : null
  }
}

interface RawRecapRow {
  id: string
  project_uri: string
  period_label: RecapPeriodLabel
  period_start: number
  period_end: number
  time_zone: string
  status: RecapStatus
  progress: number
  phase: string | null
  model: string | null
  input_chars: number
  input_tokens: number
  output_tokens: number
  llm_cost_usd: number
  markdown: string | null
  title: string | null
  subtitle: string | null
  error: string | null
  created_at: number
  created_by: string | null
  started_at: number | null
  completed_at: number | null
  dismissed_at: number | null
  signals_json: string
  signals_hash: string
  input_hash: string | null
  metadata_json: string | null
}

function hydrate(row: RawRecapRow): RecapRow {
  return {
    id: row.id,
    projectUri: row.project_uri,
    periodLabel: row.period_label,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    timeZone: row.time_zone,
    status: row.status,
    progress: row.progress,
    phase: row.phase,
    model: row.model,
    inputChars: row.input_chars,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    llmCostUsd: row.llm_cost_usd,
    markdown: row.markdown,
    title: row.title,
    subtitle: row.subtitle,
    error: row.error,
    createdAt: row.created_at,
    createdBy: row.created_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    dismissedAt: row.dismissed_at,
    signalsJson: row.signals_json,
    signalsHash: row.signals_hash,
    inputHash: row.input_hash,
    metadataJson: row.metadata_json,
  }
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`)
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
