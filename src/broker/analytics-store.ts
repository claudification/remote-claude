/**
 * Analytics Store -- SQLite-backed tool-use analytics.
 *
 * Tracks per-turn tool usage sequences, task classification, and one-shot
 * success rates. Designed to be non-blocking: hook events are pushed into
 * an in-memory buffer per conversation, then flushed to SQLite asynchronously
 * on turn boundaries (Stop/StopFailure) via a batch queue.
 *
 * Completely independent from cost-store -- analytics is interesting but
 * not critical. Errors are logged and swallowed, never propagated to the
 * hook processing pipeline.
 */

import { Database, type Statement } from 'bun:sqlite'
import { resolve } from 'node:path'
import { cwdToProjectUri } from '../shared/project-uri'
import { getOrCreateProject, getProjectById, getProjectBySlug } from './project-store'

// ─── Types ──────────────────────────────────────────────────────────

/** Tool categories for classification */
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS'])
const BASH_TOOL = 'Bash'
const AGENT_TOOL = 'Agent'

/** Task categories (inspired by CodeBurn but adapted for our data) */
export type TaskCategory =
  | 'coding' // Edit/Write tools present
  | 'debugging' // Coding + fix/error/bug keywords
  | 'refactoring' // Coding + refactor/rename/extract keywords
  | 'testing' // Bash + test/spec keywords
  | 'exploration' // Read/Grep/Glob without edits
  | 'git' // Bash + git commands
  | 'build' // Bash + build/compile/deploy keywords
  | 'conversation' // No tool use, just chat
  | 'delegation' // Agent tool use (sub-agents)
  | 'unknown'

export interface ToolUseEvent {
  toolName: string
  timestamp: number
  success: boolean
  durationMs?: number
}

export interface TurnAnalytics {
  conversationId: string
  timestamp: number
  /** Canonical project identity URI (e.g. claude:///Users/jonas/projects/foo) */
  projectUri: string
  /** Integer FK to projects.id (from project-store) */
  projectId: number
  model: string
  account: string
  /** Ordered tool names used this turn (compact: "Edit,Bash,Edit") */
  toolSequence: string
  /** Number of distinct tool calls */
  toolCallCount: number
  /** Classified task type */
  taskCategory: TaskCategory
  /** Number of edit-bash-edit retry cycles detected */
  retryCount: number
  /** True if the turn completed without retries (one-shot success) */
  oneShot: boolean
  /** Whether the turn ended with an error */
  hadError: boolean
  /** User prompt keywords (first 200 chars, lowercased) */
  promptSnippet: string
  /** Individual tool call names for per-tool stats */
  tools: string[]
}

/** Per-conversation accumulator for the current turn's tool events */
interface TurnAccumulator {
  tools: ToolUseEvent[]
  promptSnippet: string
  startedAt: number
}

// ─── Classification ─────────────────────────────────────────────────

const FIX_KEYWORDS = /\b(fix|bug|error|issue|broken|crash|fail|wrong|debug|trace|stack|exception)\b/i
const REFACTOR_KEYWORDS = /\b(refactor|rename|extract|reorganize|restructure|simplify|clean\s?up|deduplicate|move)\b/i
const TEST_KEYWORDS = /\b(test|spec|assert|expect|vitest|jest|mocha|pytest|coverage)\b/i
const GIT_KEYWORDS = /\b(commit|push|pull|merge|rebase|branch|cherry-?pick|stash|diff|log|blame)\b/i
const BUILD_KEYWORDS = /\b(build|compile|deploy|bundle|package|docker|ci|cd|release|publish)\b/i

function classifyTurn(tools: ToolUseEvent[], promptSnippet: string): TaskCategory {
  if (tools.length === 0) return 'conversation'

  const toolNames = new Set(tools.map(t => t.toolName))
  const hasEdits = [...toolNames].some(t => EDIT_TOOLS.has(t))
  const hasReads = [...toolNames].some(t => READ_TOOLS.has(t))
  const hasBash = toolNames.has(BASH_TOOL)
  const hasAgent = toolNames.has(AGENT_TOOL)

  // Agent delegation
  if (hasAgent && !hasEdits) return 'delegation'

  // Coding with refinement from keywords
  if (hasEdits) {
    if (FIX_KEYWORDS.test(promptSnippet)) return 'debugging'
    if (REFACTOR_KEYWORDS.test(promptSnippet)) return 'refactoring'
    return 'coding'
  }

  // Bash-only turns: classify by command/prompt keywords
  if (hasBash && !hasEdits) {
    if (TEST_KEYWORDS.test(promptSnippet)) return 'testing'
    if (GIT_KEYWORDS.test(promptSnippet)) return 'git'
    if (BUILD_KEYWORDS.test(promptSnippet)) return 'build'
    // Bash + reads = exploration with verification
    if (hasReads) return 'exploration'
    return 'build' // bash-only defaults to build/ops
  }

  // Read-only turns
  if (hasReads && !hasEdits && !hasBash) return 'exploration'

  return 'unknown'
}

/**
 * Detect edit-bash-edit retry cycles.
 * Pattern: Edit -> Bash -> Edit means "tried, tested, fixed" = 1 retry.
 * Multiple cycles in one turn = multiple retries.
 */
function countRetries(tools: ToolUseEvent[]): number {
  let sawEditBeforeBash = false
  let sawBashAfterEdit = false
  let retries = 0

  for (const t of tools) {
    const isEdit = EDIT_TOOLS.has(t.toolName)
    const isBash = t.toolName === BASH_TOOL

    if (isEdit) {
      if (sawBashAfterEdit) retries++
      sawEditBeforeBash = true
      sawBashAfterEdit = false
    }
    if (isBash && sawEditBeforeBash) {
      sawBashAfterEdit = true
    }
  }

  return retries
}

// ─── Batch Queue ────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 5_000 // Flush every 5 seconds
const FLUSH_BATCH_SIZE = 50 // Or when batch hits 50 records

let batchQueue: TurnAnalytics[] = []
let flushTimer: ReturnType<typeof setInterval> | null = null

function enqueueTurn(turn: TurnAnalytics): void {
  batchQueue.push(turn)
  if (batchQueue.length >= FLUSH_BATCH_SIZE) {
    flushBatch()
  }
}

function flushBatch(): void {
  if (batchQueue.length === 0 || !db) return

  const batch = batchQueue
  batchQueue = []

  try {
    const tx = db.transaction(() => {
      for (const turn of batch) {
        stmtInsertTurn?.run({
          timestamp: turn.timestamp,
          conversationId: turn.conversationId,
          projectUri: turn.projectUri,
          projectId: turn.projectId,
          model: turn.model,
          account: turn.account,
          toolSequence: turn.toolSequence,
          toolCallCount: turn.toolCallCount,
          taskCategory: turn.taskCategory,
          retryCount: turn.retryCount,
          oneShot: turn.oneShot ? 1 : 0,
          hadError: turn.hadError ? 1 : 0,
          promptSnippet: turn.promptSnippet,
        })

        const turnId = (stmtLastRowid?.get() as { id: number }).id
        for (const toolName of turn.tools) {
          stmtInsertToolUse?.run({ turnId, toolName })
        }
      }
    })
    tx()
  } catch (err) {
    console.error(`[analytics] Batch flush failed (${batch.length} turns dropped):`, err)
  }
}

// ─── Module State ───────────────────────────────────────────────────

let db: Database | null = null
let stmtInsertTurn: Statement | null = null
let stmtInsertToolUse: Statement | null = null
let stmtLastRowid: Statement | null = null
let cleanupTimer: ReturnType<typeof setInterval> | null = null

/** Per-conversation turn accumulators (keyed by conversationId) */
const turnAccumulators = new Map<string, TurnAccumulator>()

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Migrate analytics schema:
 * - v1: add project_id TEXT column (no longer created)
 * - v2: project_id becomes INTEGER (FK to projects.id)
 *
 * For existing TEXT project_id data, we recreate the column as INTEGER.
 * Backfill resolves cwd -> project-store -> integer id.
 */
function migrate(d: Database): void {
  try {
    const cols = d.query("PRAGMA table_info('turns')").all() as Array<{ name: string; type: string }>
    const projectCol = cols.find(c => c.name === 'project_id')

    if (!projectCol) {
      d.run('ALTER TABLE turns ADD COLUMN project_id INTEGER NOT NULL DEFAULT 0')
      backfillProjectIds(d)
      console.log('[analytics] Migrated: added project_id INTEGER column')
    } else if (projectCol.type === 'TEXT') {
      d.run('ALTER TABLE turns ADD COLUMN project_id_int INTEGER NOT NULL DEFAULT 0')
      backfillProjectIds(d, 'project_id_int')
      d.run('DROP INDEX IF EXISTS idx_analytics_project')
      d.run('ALTER TABLE turns DROP COLUMN project_id')
      d.run('ALTER TABLE turns RENAME COLUMN project_id_int TO project_id')
      d.run('CREATE INDEX IF NOT EXISTS idx_analytics_project ON turns(project_id)')
      console.log('[analytics] Migrated: project_id TEXT -> INTEGER')
    }
  } catch (err) {
    console.error('[analytics] Migration failed:', err)
  }

  try {
    const uriCols = d.query("PRAGMA table_info('turns')").all() as Array<{ name: string }>
    if (!uriCols.some(c => c.name === 'project_uri')) {
      d.run('ALTER TABLE turns ADD COLUMN project_uri TEXT')
      d.run(
        `UPDATE turns SET project_uri =
           'claude://default' || CASE WHEN substr(cwd, 1, 1) = '/' THEN cwd ELSE '/' || cwd END
         WHERE project_uri IS NULL AND cwd != ''`,
      )
      d.run('CREATE INDEX IF NOT EXISTS idx_analytics_project_uri ON turns(project_uri)')
      console.log('[analytics] Migrated: added project_uri column')
    }
  } catch (err) {
    console.error('[analytics] project_uri migration failed:', err)
  }
}

/** Backfill project_id from cwd via project-store */
function backfillProjectIds(d: Database, column = 'project_id'): void {
  const cols = d.query("PRAGMA table_info('turns')").all() as Array<{ name: string }>
  if (!cols.some(c => c.name === 'cwd')) return

  const cwds = d.query("SELECT DISTINCT cwd FROM turns WHERE cwd != ''").all() as Array<{ cwd: string }>
  for (const { cwd } of cwds) {
    const projectUri = cwdToProjectUri(cwd)
    const project = getOrCreateProject(projectUri)
    d.prepare(`UPDATE turns SET ${column} = $pid WHERE cwd = $cwd`).run({ pid: project.id, cwd })
  }
  if (cwds.length > 0) {
    console.log(`[analytics] Backfilled project_id for ${cwds.length} distinct cwds`)
  }
}

/**
 * V2 migration: fix broken timestamps + restructure tool_uses.
 *
 * 1. Old code stored timestamps as ISO text strings. Cleanup compared
 *    them to integer epoch millis -- always false in SQLite (text > int).
 *    Result: cleanup never deleted anything. DB grew to ~500MB.
 * 2. tool_uses stored (timestamp, conversation_id, tool_name) per call
 *    -- 36-char conversation_id repeated 3.3M times. New schema uses
 *    (turn_id, tool_name) with an integer FK to turns.id.
 */
function migrateToolUsesV2(d: Database): void {
  const cols = d.query("PRAGMA table_info('tool_uses')").all() as Array<{ name: string }>
  if (!cols.some(c => c.name === 'conversation_id')) return

  console.log('[analytics] v2 migration: fixing timestamps, restructuring tool_uses...')
  const t0 = Date.now()

  d.run(
    "UPDATE turns SET timestamp = CAST(strftime('%s', timestamp) AS INTEGER) * 1000 WHERE typeof(timestamp) = 'text'",
  )

  const cutoff = Date.now() - RETENTION_MS
  d.prepare('DELETE FROM turns WHERE timestamp < $cutoff').run({ cutoff })

  d.run('DROP TABLE tool_uses')
  d.run('CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, turn_id INTEGER NOT NULL, tool_name TEXT NOT NULL)')

  const insertStmt = d.prepare('INSERT INTO tool_uses (turn_id, tool_name) VALUES ($turnId, $toolName)')
  const turns = d.query("SELECT id, tool_sequence FROM turns WHERE tool_sequence != ''").all() as Array<{
    id: number
    tool_sequence: string
  }>

  let backfilled = 0
  const backfillTx = d.transaction(() => {
    for (const turn of turns) {
      for (const toolName of turn.tool_sequence.split(',')) {
        if (toolName) {
          insertStmt.run({ turnId: turn.id, toolName })
          backfilled++
        }
      }
    }
  })
  backfillTx()

  d.run('VACUUM')

  console.log(
    `[analytics] v2 migration complete in ${Date.now() - t0}ms: ${turns.length} turns, ${backfilled} tool_uses backfilled`,
  )
}

// ─── Init ─────────────────────────────────────────────────────────

export function initAnalyticsStore(cacheDir: string): void {
  try {
    const dbPath = resolve(cacheDir, 'analytics.db')
    db = new Database(dbPath, { strict: true })

    db.run('PRAGMA journal_mode = WAL')
    db.run('PRAGMA synchronous = NORMAL')
    db.run('PRAGMA cache_size = -4000') // 4MB cache

    db.run(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        conversation_id TEXT NOT NULL,
        project_uri TEXT NOT NULL DEFAULT '',
        project_id INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL DEFAULT '',
        account TEXT NOT NULL DEFAULT '',
        tool_sequence TEXT NOT NULL DEFAULT '',
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        task_category TEXT NOT NULL DEFAULT 'unknown',
        retry_count INTEGER NOT NULL DEFAULT 0,
        one_shot INTEGER NOT NULL DEFAULT 0,
        had_error INTEGER NOT NULL DEFAULT 0,
        prompt_snippet TEXT NOT NULL DEFAULT ''
      )
    `)

    // Column migrations (project_id, project_uri)
    migrate(db)

    // Drop legacy cwd column
    const cwdCols = db.query("PRAGMA table_info('turns')").all() as Array<{ name: string }>
    if (cwdCols.some(c => c.name === 'cwd')) {
      db.run('DROP INDEX IF EXISTS idx_analytics_cwd')
      db.run('ALTER TABLE turns DROP COLUMN cwd')
      console.log('[analytics] Migrated turns: dropped cwd column')
    }

    // V2: fix timestamps + restructure tool_uses (one-time, ~500MB -> ~20MB)
    migrateToolUsesV2(db)

    // New schema: turn_id FK replaces (timestamp, conversation_id) per row
    db.run(`
      CREATE TABLE IF NOT EXISTS tool_uses (
        id INTEGER PRIMARY KEY,
        turn_id INTEGER NOT NULL,
        tool_name TEXT NOT NULL
      )
    `)

    // Indexes
    db.run('CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON turns(timestamp)')
    db.run('CREATE INDEX IF NOT EXISTS idx_analytics_conversation ON turns(conversation_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_analytics_project_uri ON turns(project_uri)')
    db.run('CREATE INDEX IF NOT EXISTS idx_analytics_project ON turns(project_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_analytics_category ON turns(task_category)')
    db.run('CREATE INDEX IF NOT EXISTS idx_tool_uses_turn ON tool_uses(turn_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_tool_uses_name ON tool_uses(tool_name)')

    stmtInsertTurn = db.prepare(`
      INSERT INTO turns (timestamp, conversation_id, project_uri, project_id, model, account,
        tool_sequence, tool_call_count, task_category, retry_count,
        one_shot, had_error, prompt_snippet)
      VALUES ($timestamp, $conversationId, $projectUri, $projectId, $model, $account,
        $toolSequence, $toolCallCount, $taskCategory, $retryCount,
        $oneShot, $hadError, $promptSnippet)
    `)

    stmtInsertToolUse = db.prepare('INSERT INTO tool_uses (turn_id, tool_name) VALUES ($turnId, $toolName)')

    stmtLastRowid = db.prepare('SELECT last_insert_rowid() as id')

    // Cleanup on startup + daily
    cleanup()
    cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS)

    // Batch flush timer
    flushTimer = setInterval(flushBatch, FLUSH_INTERVAL_MS)

    const count = (db.query('SELECT COUNT(*) as n FROM turns').get() as { n: number }).n
    console.log(`[analytics] Store initialized: ${dbPath} (${count} turns)`)
  } catch (err) {
    console.error('[analytics] Failed to initialize store:', err)
    db = null
  }
}

// ─── Hook Event Ingestion (called from conversation-store) ───────────────

/**
 * Process a hook event for analytics. Called from addEvent() in session-store.
 * MUST be non-blocking -- errors are caught and logged, never thrown.
 */
export function recordHookEvent(
  conversationId: string,
  hookEvent: string,
  data: Record<string, unknown>,
  sessionMeta: { projectUri: string; model: string; account: string; projectLabel?: string },
): void {
  if (!db) return

  try {
    if (hookEvent === 'UserPromptSubmit') {
      const prompt = String(data.prompt || '')
        .slice(0, 200)
        .toLowerCase()
      turnAccumulators.set(conversationId, {
        tools: [],
        promptSnippet: prompt,
        startedAt: Date.now(),
      })
      return
    }

    if (hookEvent === 'PreToolUse') {
      const acc = turnAccumulators.get(conversationId)
      if (acc) {
        acc.tools.push({
          toolName: String(data.tool_name || ''),
          timestamp: Date.now(),
          success: true,
        })
      }
      return
    }

    if (hookEvent === 'PostToolUseFailure') {
      const acc = turnAccumulators.get(conversationId)
      if (acc) {
        const toolName = String(data.tool_name || '')
        for (let i = acc.tools.length - 1; i >= 0; i--) {
          if (acc.tools[i].toolName === toolName && acc.tools[i].success) {
            acc.tools[i].success = false
            break
          }
        }
      }
      return
    }

    if (hookEvent === 'Stop' || hookEvent === 'StopFailure') {
      const acc = turnAccumulators.get(conversationId)
      if (!acc) return
      turnAccumulators.delete(conversationId)

      if (acc.tools.length === 0 && !acc.promptSnippet) return

      const retryCount = countRetries(acc.tools)
      const hasEdits = acc.tools.some(t => EDIT_TOOLS.has(t.toolName))
      const taskCategory = classifyTurn(acc.tools, acc.promptSnippet)

      const turn: TurnAnalytics = {
        conversationId,
        timestamp: Date.now(),
        projectUri: sessionMeta.projectUri,
        projectId: getOrCreateProject(sessionMeta.projectUri, sessionMeta.projectLabel).id,
        model: sessionMeta.model,
        account: sessionMeta.account,
        toolSequence: acc.tools.map(t => t.toolName).join(','),
        toolCallCount: acc.tools.length,
        taskCategory,
        retryCount,
        oneShot: hasEdits && retryCount === 0 && hookEvent !== 'StopFailure',
        hadError: hookEvent === 'StopFailure',
        promptSnippet: acc.promptSnippet,
        tools: acc.tools.map(t => t.toolName),
      }

      enqueueTurn(turn)
    }
  } catch (err) {
    console.error(`[analytics] Error processing ${hookEvent}:`, err)
  }
}

export function clearSession(conversationId: string): void {
  turnAccumulators.delete(conversationId)
}

// ─── Queries ────────────────────────────────────────────────────────

type Binds = Record<string, string | number | null>

function queryAll(sql: string, binds?: Binds): unknown[] {
  if (!db) return []
  const stmt = db.query(sql)
  return binds ? stmt.all(binds as never) : stmt.all()
}

function queryGet(sql: string, binds?: Binds): unknown {
  if (!db) return null
  const stmt = db.query(sql)
  return binds ? stmt.get(binds as never) : stmt.get()
}

export interface AnalyticsSummary {
  period: string
  project?: string
  totalTurns: number
  oneShotRate: number // 0-1
  avgRetries: number
  taskBreakdown: Array<{ category: TaskCategory; count: number; oneShotRate: number }>
  topTools: Array<{ toolName: string; count: number }>
  topProjects: Array<{
    projectId: number
    projectUri: string
    slug: string
    label: string | null
    turns: number
    oneShotRate: number
  }>
}

export function querySummary(period: '24h' | '7d' | '30d' | '90d', project?: string): AnalyticsSummary {
  const cutoff = Date.now() - periodToMs(period)
  const { where, binds } = buildFilter(cutoff, project)

  const totals = queryGet(
    `SELECT COUNT(*) as turns,
      COALESCE(AVG(CASE WHEN tool_call_count > 0 AND one_shot = 1 THEN 1.0
                       WHEN tool_call_count > 0 AND one_shot = 0 THEN 0.0 END), 0) as one_shot_rate,
      COALESCE(AVG(retry_count), 0) as avg_retries
    FROM turns ${where}`,
    binds,
  ) as { turns: number; one_shot_rate: number; avg_retries: number } | null

  const taskBreakdown = queryAll(
    `SELECT task_category as category, COUNT(*) as count,
      COALESCE(AVG(CASE WHEN one_shot = 1 THEN 1.0
                       WHEN one_shot = 0 AND tool_call_count > 0 THEN 0.0 END), 0) as one_shot_rate
    FROM turns ${where}
    GROUP BY task_category ORDER BY count DESC`,
    binds,
  ) as Array<{ category: TaskCategory; count: number; one_shot_rate: number }>

  // Top tools via turn_id FK JOIN. Column names in $where (timestamp,
  // project_uri, project_id) only exist on turns, so they resolve
  // unambiguously despite bare names in the WHERE clause.
  const topTools = queryAll(
    `SELECT tu.tool_name as toolName, COUNT(*) as count
    FROM tool_uses tu JOIN turns t ON tu.turn_id = t.id
    ${where}
    GROUP BY tu.tool_name ORDER BY count DESC LIMIT 20`,
    binds,
  ) as Array<{ toolName: string; count: number }>

  const topProjects = queryAll(
    `SELECT project_uri, MAX(project_id) as project_id, COUNT(*) as turns,
      COALESCE(AVG(CASE WHEN one_shot = 1 THEN 1.0
                       WHEN one_shot = 0 AND tool_call_count > 0 THEN 0.0 END), 0) as one_shot_rate
    FROM turns ${where}
    GROUP BY project_uri ORDER BY turns DESC LIMIT 10`,
    binds,
  ) as Array<{ project_uri: string; project_id: number; turns: number; one_shot_rate: number }>

  return {
    period,
    project,
    totalTurns: totals?.turns || 0,
    oneShotRate: totals?.one_shot_rate || 0,
    avgRetries: totals?.avg_retries || 0,
    taskBreakdown: taskBreakdown.map(r => ({
      category: r.category,
      count: r.count,
      oneShotRate: r.one_shot_rate,
    })),
    topTools,
    topProjects: topProjects.map(r => {
      const p = r.project_id ? getProjectById(r.project_id) : null
      return {
        projectId: r.project_id,
        projectUri: r.project_uri || '',
        slug: p?.slug || 'unknown',
        label: p?.label || null,
        turns: r.turns,
        oneShotRate: r.one_shot_rate,
      }
    }),
  }
}

/** Hourly/daily aggregation for charts */
export interface AnalyticsTimeSeries {
  bucket: string
  turns: number
  oneShotRate: number
  retries: number
  codingTurns: number
  debuggingTurns: number
  explorationTurns: number
}

export function queryTimeSeries(
  period: '24h' | '7d' | '30d',
  granularity: 'hour' | 'day' = 'hour',
  project?: string,
): AnalyticsTimeSeries[] {
  const cutoff = Date.now() - periodToMs(period)
  const { where, binds } = buildFilter(cutoff, project)
  const fmt = granularity === 'day' ? '%Y-%m-%d' : '%Y-%m-%dT%H:00'

  const rows = queryAll(
    `SELECT strftime('${fmt}', timestamp / 1000, 'unixepoch') as bucket,
      COUNT(*) as turns,
      COALESCE(AVG(CASE WHEN one_shot = 1 THEN 1.0
                       WHEN one_shot = 0 AND tool_call_count > 0 THEN 0.0 END), 0) as one_shot_rate,
      SUM(retry_count) as retries,
      SUM(CASE WHEN task_category = 'coding' THEN 1 ELSE 0 END) as coding_turns,
      SUM(CASE WHEN task_category = 'debugging' THEN 1 ELSE 0 END) as debugging_turns,
      SUM(CASE WHEN task_category = 'exploration' THEN 1 ELSE 0 END) as exploration_turns
    FROM turns ${where}
    GROUP BY bucket ORDER BY bucket`,
    binds,
  ) as Array<Record<string, unknown>>

  return rows.map(r => ({
    bucket: r.bucket as string,
    turns: r.turns as number,
    oneShotRate: r.one_shot_rate as number,
    retries: r.retries as number,
    codingTurns: r.coding_turns as number,
    debuggingTurns: r.debugging_turns as number,
    explorationTurns: r.exploration_turns as number,
  }))
}

/** Per-model one-shot comparison */
export interface ModelAnalytics {
  model: string
  turns: number
  oneShotRate: number
  avgRetries: number
  codingTurns: number
}

export function queryModelComparison(period: '24h' | '7d' | '30d' | '90d', project?: string): ModelAnalytics[] {
  const cutoff = Date.now() - periodToMs(period)
  const { where, binds } = buildFilter(cutoff, project)
  const modelWhere = `${where} AND model != ''`

  const rows = queryAll(
    `SELECT model, COUNT(*) as turns,
      COALESCE(AVG(CASE WHEN one_shot = 1 THEN 1.0
                       WHEN one_shot = 0 AND tool_call_count > 0 THEN 0.0 END), 0) as one_shot_rate,
      COALESCE(AVG(retry_count), 0) as avg_retries,
      SUM(CASE WHEN task_category = 'coding' THEN 1 ELSE 0 END) as coding_turns
    FROM turns ${modelWhere}
    GROUP BY model ORDER BY turns DESC`,
    binds,
  ) as Array<Record<string, unknown>>

  return rows.map(r => ({
    model: r.model as string,
    turns: r.turns as number,
    oneShotRate: r.one_shot_rate as number,
    avgRetries: r.avg_retries as number,
    codingTurns: r.coding_turns as number,
  }))
}

// ─── Query helpers ──────────────────────────────────────────────────

function buildFilter(cutoff: number, project?: string): { where: string; binds: Binds } {
  if (project) {
    if (project.includes('://')) {
      return {
        where: 'WHERE timestamp >= $cutoff AND project_uri = $projectUri',
        binds: { cutoff, projectUri: project },
      }
    }
    let projectId: number
    const parsed = Number(project)
    if (!Number.isNaN(parsed)) {
      projectId = parsed
    } else {
      const p = getProjectBySlug(project)
      if (!p) return { where: 'WHERE timestamp >= $cutoff AND 0', binds: { cutoff } }
      projectId = p.id
    }
    return {
      where: 'WHERE timestamp >= $cutoff AND project_id = $projectId',
      binds: { cutoff, projectId },
    }
  }
  return {
    where: 'WHERE timestamp >= $cutoff',
    binds: { cutoff },
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────

function cleanup(): void {
  if (!db) return
  try {
    const cutoff = Date.now() - RETENTION_MS

    // Delete tool_uses for expired turns first (FK dependency)
    db.prepare('DELETE FROM tool_uses WHERE turn_id IN (SELECT id FROM turns WHERE timestamp < $cutoff)').run({
      cutoff,
    })

    const result = db.prepare('DELETE FROM turns WHERE timestamp < $cutoff').run({ cutoff })
    const deleted = (result as unknown as { changes: number } | undefined)?.changes ?? 0

    if (deleted > 0) {
      console.log(`[analytics] Cleanup: removed ${deleted} expired turns (>30d)`)
      db.run('VACUUM')
    }
  } catch (err) {
    console.error('[analytics] Cleanup failed:', err)
  }
}

// ─── Shutdown ───────────────────────────────────────────────────────

export function closeAnalyticsStore(): void {
  if (flushTimer) clearInterval(flushTimer)
  if (cleanupTimer) clearInterval(cleanupTimer)

  flushBatch()

  if (db) {
    try {
      db.run('PRAGMA wal_checkpoint(TRUNCATE)')
      db.close()
    } catch (err) {
      console.error('[analytics] Error closing database:', err)
    }
    db = null
    stmtInsertTurn = null
    stmtInsertToolUse = null
    stmtLastRowid = null
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function periodToMs(period: string): number {
  switch (period) {
    case '24h':
      return 24 * 60 * 60 * 1000
    case '7d':
      return 7 * 24 * 60 * 60 * 1000
    case '30d':
      return 30 * 24 * 60 * 60 * 1000
    case '90d':
      return 90 * 24 * 60 * 60 * 1000
    default:
      return 30 * 24 * 60 * 60 * 1000
  }
}
