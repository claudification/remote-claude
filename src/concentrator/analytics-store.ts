/**
 * Analytics Store -- SQLite-backed tool-use analytics.
 *
 * Tracks per-turn tool usage sequences, task classification, and one-shot
 * success rates. Designed to be non-blocking: hook events are pushed into
 * an in-memory buffer per session, then flushed to SQLite asynchronously
 * on turn boundaries (Stop/StopFailure) via a batch queue.
 *
 * Completely independent from cost-store -- analytics is interesting but
 * not critical. Errors are logged and swallowed, never propagated to the
 * hook processing pipeline.
 */

import { Database, type Statement } from 'bun:sqlite'
import { resolve } from 'node:path'

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
  sessionId: string
  timestamp: number
  cwd: string
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

/** Per-session accumulator for the current turn's tool events */
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
          sessionId: turn.sessionId,
          cwd: turn.cwd,
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

        // Insert per-tool records
        for (const toolName of turn.tools) {
          stmtInsertToolUse?.run({
            timestamp: turn.timestamp,
            sessionId: turn.sessionId,
            toolName,
          })
        }
      }
    })
    tx()
  } catch (err) {
    console.error(`[analytics] Batch flush failed (${batch.length} turns dropped):`, err)
    // Don't re-queue -- data loss is acceptable for analytics
  }
}

// ─── Module State ───────────────────────────────────────────────────

let db: Database | null = null
let stmtInsertTurn: Statement | null = null
let stmtInsertToolUse: Statement | null = null
let cleanupTimer: ReturnType<typeof setInterval> | null = null

/** Per-session turn accumulators (keyed by sessionId) */
const turnAccumulators = new Map<string, TurnAccumulator>()

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000 // 90 days (longer than cost-store)
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

// ─── Init ───────────────────────────────────────────────────────────

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
        session_id TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '',
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

    db.run(`
      CREATE TABLE IF NOT EXISTS tool_uses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL
      )
    `)

    // Indexes
    db.run('CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON turns(timestamp)')
    db.run('CREATE INDEX IF NOT EXISTS idx_analytics_session ON turns(session_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_analytics_cwd ON turns(cwd)')
    db.run('CREATE INDEX IF NOT EXISTS idx_analytics_category ON turns(task_category)')
    db.run('CREATE INDEX IF NOT EXISTS idx_tool_uses_timestamp ON tool_uses(timestamp)')
    db.run('CREATE INDEX IF NOT EXISTS idx_tool_uses_name ON tool_uses(tool_name)')

    stmtInsertTurn = db.prepare(`
      INSERT INTO turns (timestamp, session_id, cwd, model, account,
        tool_sequence, tool_call_count, task_category, retry_count,
        one_shot, had_error, prompt_snippet)
      VALUES ($timestamp, $sessionId, $cwd, $model, $account,
        $toolSequence, $toolCallCount, $taskCategory, $retryCount,
        $oneShot, $hadError, $promptSnippet)
    `)

    stmtInsertToolUse = db.prepare(`
      INSERT INTO tool_uses (timestamp, session_id, tool_name)
      VALUES ($timestamp, $sessionId, $toolName)
    `)

    // Cleanup on startup + daily
    cleanup()
    cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS)

    // Batch flush timer
    flushTimer = setInterval(flushBatch, FLUSH_INTERVAL_MS)

    const count = (db.query('SELECT COUNT(*) as n FROM turns').get() as { n: number }).n
    console.log(`[analytics] Store initialized: ${dbPath} (${count} turns)`)
  } catch (err) {
    console.error('[analytics] Failed to initialize store:', err)
    // Analytics failure is non-fatal -- concentrator continues without it
    db = null
  }
}

// ─── Hook Event Ingestion (called from session-store) ───────────────

/**
 * Process a hook event for analytics. Called from addEvent() in session-store.
 * MUST be non-blocking -- errors are caught and logged, never thrown.
 */
export function recordHookEvent(
  sessionId: string,
  hookEvent: string,
  data: Record<string, unknown>,
  sessionMeta: { cwd: string; model: string; account: string },
): void {
  if (!db) return

  try {
    // UserPromptSubmit: start a new turn accumulator
    if (hookEvent === 'UserPromptSubmit') {
      const prompt = String(data.prompt || '')
        .slice(0, 200)
        .toLowerCase()
      turnAccumulators.set(sessionId, {
        tools: [],
        promptSnippet: prompt,
        startedAt: Date.now(),
      })
      return
    }

    // PreToolUse: record tool invocation (we use Pre because Post may not fire on timeout)
    if (hookEvent === 'PreToolUse') {
      const acc = turnAccumulators.get(sessionId)
      if (acc) {
        acc.tools.push({
          toolName: String(data.tool_name || ''),
          timestamp: Date.now(),
          success: true, // optimistic, flipped on PostToolUseFailure
        })
      }
      return
    }

    // PostToolUseFailure: mark the last matching tool as failed
    if (hookEvent === 'PostToolUseFailure') {
      const acc = turnAccumulators.get(sessionId)
      if (acc) {
        const toolName = String(data.tool_name || '')
        // Find last tool with this name and mark failed
        for (let i = acc.tools.length - 1; i >= 0; i--) {
          if (acc.tools[i].toolName === toolName && acc.tools[i].success) {
            acc.tools[i].success = false
            break
          }
        }
      }
      return
    }

    // Stop / StopFailure: finalize the turn and enqueue for batch write
    if (hookEvent === 'Stop' || hookEvent === 'StopFailure') {
      const acc = turnAccumulators.get(sessionId)
      if (!acc) return
      turnAccumulators.delete(sessionId)

      // Skip empty turns (no tool calls and no prompt = not interesting)
      if (acc.tools.length === 0 && !acc.promptSnippet) return

      const retryCount = countRetries(acc.tools)
      const hasEdits = acc.tools.some(t => EDIT_TOOLS.has(t.toolName))
      const taskCategory = classifyTurn(acc.tools, acc.promptSnippet)

      const turn: TurnAnalytics = {
        sessionId,
        timestamp: Date.now(),
        cwd: sessionMeta.cwd,
        model: sessionMeta.model,
        account: sessionMeta.account,
        toolSequence: acc.tools.map(t => t.toolName).join(','),
        toolCallCount: acc.tools.length,
        taskCategory,
        retryCount,
        // One-shot = had edits, zero retries, no error
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

/**
 * Clear the turn accumulator for a session (e.g. on session end).
 */
export function clearSession(sessionId: string): void {
  turnAccumulators.delete(sessionId)
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
  totalTurns: number
  oneShotRate: number // 0-1
  avgRetries: number
  taskBreakdown: Array<{ category: TaskCategory; count: number; oneShotRate: number }>
  topTools: Array<{ toolName: string; count: number }>
  topProjects: Array<{ cwd: string; turns: number; oneShotRate: number }>
}

export function querySummary(period: '24h' | '7d' | '30d' | '90d'): AnalyticsSummary {
  const cutoff = Date.now() - periodToMs(period)
  const b = { cutoff }

  const totals = queryGet(
    `SELECT COUNT(*) as turns,
      COALESCE(AVG(CASE WHEN tool_call_count > 0 AND one_shot = 1 THEN 1.0
                       WHEN tool_call_count > 0 AND one_shot = 0 THEN 0.0 END), 0) as one_shot_rate,
      COALESCE(AVG(retry_count), 0) as avg_retries
    FROM turns WHERE timestamp >= $cutoff`,
    b,
  ) as { turns: number; one_shot_rate: number; avg_retries: number } | null

  const taskBreakdown = queryAll(
    `SELECT task_category as category, COUNT(*) as count,
      COALESCE(AVG(CASE WHEN one_shot = 1 THEN 1.0
                       WHEN one_shot = 0 AND tool_call_count > 0 THEN 0.0 END), 0) as one_shot_rate
    FROM turns WHERE timestamp >= $cutoff
    GROUP BY task_category ORDER BY count DESC`,
    b,
  ) as Array<{ category: TaskCategory; count: number; one_shot_rate: number }>

  const topTools = queryAll(
    `SELECT tool_name as toolName, COUNT(*) as count
    FROM tool_uses WHERE timestamp >= $cutoff
    GROUP BY tool_name ORDER BY count DESC LIMIT 20`,
    b,
  ) as Array<{ toolName: string; count: number }>

  const topProjects = queryAll(
    `SELECT cwd, COUNT(*) as turns,
      COALESCE(AVG(CASE WHEN one_shot = 1 THEN 1.0
                       WHEN one_shot = 0 AND tool_call_count > 0 THEN 0.0 END), 0) as one_shot_rate
    FROM turns WHERE timestamp >= $cutoff
    GROUP BY cwd ORDER BY turns DESC LIMIT 10`,
    b,
  ) as Array<{ cwd: string; turns: number; one_shot_rate: number }>

  return {
    period,
    totalTurns: totals?.turns || 0,
    oneShotRate: totals?.one_shot_rate || 0,
    avgRetries: totals?.avg_retries || 0,
    taskBreakdown: taskBreakdown.map(r => ({
      category: r.category,
      count: r.count,
      oneShotRate: r.one_shot_rate,
    })),
    topTools,
    topProjects: topProjects.map(r => ({
      cwd: r.cwd,
      turns: r.turns,
      oneShotRate: r.one_shot_rate,
    })),
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
): AnalyticsTimeSeries[] {
  const cutoff = Date.now() - periodToMs(period)
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
    FROM turns WHERE timestamp >= $cutoff
    GROUP BY bucket ORDER BY bucket`,
    { cutoff },
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

export function queryModelComparison(period: '24h' | '7d' | '30d' | '90d'): ModelAnalytics[] {
  const cutoff = Date.now() - periodToMs(period)

  const rows = queryAll(
    `SELECT model, COUNT(*) as turns,
      COALESCE(AVG(CASE WHEN one_shot = 1 THEN 1.0
                       WHEN one_shot = 0 AND tool_call_count > 0 THEN 0.0 END), 0) as one_shot_rate,
      COALESCE(AVG(retry_count), 0) as avg_retries,
      SUM(CASE WHEN task_category = 'coding' THEN 1 ELSE 0 END) as coding_turns
    FROM turns WHERE timestamp >= $cutoff AND model != ''
    GROUP BY model ORDER BY turns DESC`,
    { cutoff },
  ) as Array<Record<string, unknown>>

  return rows.map(r => ({
    model: r.model as string,
    turns: r.turns as number,
    oneShotRate: r.one_shot_rate as number,
    avgRetries: r.avg_retries as number,
    codingTurns: r.coding_turns as number,
  }))
}

// ─── Mass Import ────────────────────────────────────────────────────

/**
 * Import a pre-built TurnAnalytics record (for mass import script).
 * Bypasses the accumulator -- the caller has already classified the turn.
 */
export function importTurn(turn: TurnAnalytics): void {
  enqueueTurn(turn)
}

/** Force flush the batch queue (for import scripts and shutdown) */
export function flush(): void {
  flushBatch()
}

// ─── Cleanup ────────────────────────────────────────────────────────

function cleanup(): void {
  if (!db) return
  try {
    const cutoff = Date.now() - RETENTION_MS
    const turnsDeleted = db.prepare('DELETE FROM turns WHERE timestamp < $cutoff').run({ cutoff })
    const toolsDeleted = db.prepare('DELETE FROM tool_uses WHERE timestamp < $cutoff').run({ cutoff })

    if ((turnsDeleted?.changes ?? 0) > 0 || (toolsDeleted?.changes ?? 0) > 0) {
      console.log(
        `[analytics] Cleanup: ${turnsDeleted?.changes ?? 0} turns, ${toolsDeleted?.changes ?? 0} tool_uses removed (>90d)`,
      )
    }
  } catch (err) {
    console.error('[analytics] Cleanup failed:', err)
  }
}

// ─── Shutdown ───────────────────────────────────────────────────────

export function closeAnalyticsStore(): void {
  if (flushTimer) clearInterval(flushTimer)
  if (cleanupTimer) clearInterval(cleanupTimer)

  // Final flush
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
