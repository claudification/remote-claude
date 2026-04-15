#!/usr/bin/env bun
/**
 * Mass import historical JSONL transcripts into the analytics store.
 *
 * Reads all transcript files from ~/.claude/projects/ and the concentrator's
 * transcript cache, parses turns, classifies them, and writes to analytics.db.
 *
 * Usage:
 *   bun scripts/import-analytics.ts [--db <path>] [--dir <path>] [--dry-run]
 *
 * Options:
 *   --db <path>    Path to analytics.db (default: ~/.cache/concentrator/analytics.db)
 *   --dir <path>   Path to scan for .jsonl files (default: ~/.claude/projects)
 *   --dry-run      Parse and classify but don't write to DB
 *   --verbose      Show per-file progress
 */

import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// ─── Classification (duplicated from analytics-store to keep script standalone) ──

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS'])
const BASH_TOOL = 'Bash'
const AGENT_TOOL = 'Agent'

type TaskCategory =
  | 'coding'
  | 'debugging'
  | 'refactoring'
  | 'testing'
  | 'exploration'
  | 'git'
  | 'build'
  | 'conversation'
  | 'delegation'
  | 'unknown'

const FIX_KEYWORDS = /\b(fix|bug|error|issue|broken|crash|fail|wrong|debug|trace|stack|exception)\b/i
const REFACTOR_KEYWORDS = /\b(refactor|rename|extract|reorganize|restructure|simplify|clean\s?up|deduplicate|move)\b/i
const TEST_KEYWORDS = /\b(test|spec|assert|expect|vitest|jest|mocha|pytest|coverage)\b/i
const GIT_KEYWORDS = /\b(commit|push|pull|merge|rebase|branch|cherry-?pick|stash|diff|log|blame)\b/i
const BUILD_KEYWORDS = /\b(build|compile|deploy|bundle|package|docker|ci|cd|release|publish)\b/i

function classifyTurn(toolNames: string[], promptSnippet: string): TaskCategory {
  if (toolNames.length === 0) return 'conversation'

  const toolSet = new Set(toolNames)
  const hasEdits = [...toolSet].some(t => EDIT_TOOLS.has(t))
  const hasReads = [...toolSet].some(t => READ_TOOLS.has(t))
  const hasBash = toolSet.has(BASH_TOOL)
  const hasAgent = toolSet.has(AGENT_TOOL)

  if (hasAgent && !hasEdits) return 'delegation'

  if (hasEdits) {
    if (FIX_KEYWORDS.test(promptSnippet)) return 'debugging'
    if (REFACTOR_KEYWORDS.test(promptSnippet)) return 'refactoring'
    return 'coding'
  }

  if (hasBash && !hasEdits) {
    if (TEST_KEYWORDS.test(promptSnippet)) return 'testing'
    if (GIT_KEYWORDS.test(promptSnippet)) return 'git'
    if (BUILD_KEYWORDS.test(promptSnippet)) return 'build'
    if (hasReads) return 'exploration'
    return 'build'
  }

  if (hasReads && !hasEdits && !hasBash) return 'exploration'

  return 'unknown'
}

function deriveProjectId(cwd: string): string {
  if (!cwd) return 'unknown'
  const segments = cwd.replace(/\/+$/, '').split('/')
  return segments[segments.length - 1] || 'unknown'
}

function countRetries(toolNames: string[]): number {
  let sawEditBeforeBash = false
  let sawBashAfterEdit = false
  let retries = 0

  for (const name of toolNames) {
    const isEdit = EDIT_TOOLS.has(name)
    const isBash = name === BASH_TOOL

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

// ─── JSONL Parsing ──────────────────────────────────────────────────

interface Turn {
  sessionId: string
  cwd: string
  model: string
  timestamp: number
  promptSnippet: string
  toolNames: string[]
}

function parseTranscript(filePath: string): Turn[] {
  const turns: Turn[] = []
  let fileContent: string

  try {
    fileContent = readFileSync(filePath, 'utf-8')
    if (!fileContent) return turns
  } catch {
    return turns
  }

  const lines = fileContent.split('\n')

  let sessionId = ''
  let cwd = ''
  let model = ''
  let currentPrompt = ''
  let currentTools: string[] = []
  let turnTimestamp = 0
  let inTurn = false

  for (const line of lines) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    const type = entry.type as string

    // Extract session metadata from first entry
    if (!sessionId && entry.sessionId) {
      sessionId = entry.sessionId as string
    }
    if (!cwd && entry.cwd) {
      cwd = entry.cwd as string
    }

    if (type === 'user') {
      // If we were in a turn, finalize the previous one
      if (inTurn && currentTools.length > 0) {
        turns.push({
          sessionId,
          cwd,
          model,
          timestamp: turnTimestamp,
          promptSnippet: currentPrompt,
          toolNames: currentTools,
        })
      }

      // Start new turn
      const msg = entry.message as Record<string, unknown> | undefined
      const content = msg?.content
      if (typeof content === 'string') {
        currentPrompt = content.slice(0, 200).toLowerCase()
      } else if (Array.isArray(content)) {
        // Tool results are user entries but not prompts - skip them
        const textParts = content.filter((c: Record<string, unknown>) => c.type === 'text')
        if (textParts.length > 0) {
          currentPrompt = String((textParts[0] as Record<string, unknown>).text || '')
            .slice(0, 200)
            .toLowerCase()
        } else {
          // This is a tool_result entry, not a new prompt - don't reset
          continue
        }
      }
      currentTools = []
      turnTimestamp = (entry.timestamp as number) || Date.now()
      inTurn = true
    } else if (type === 'assistant') {
      const msg = entry.message as Record<string, unknown> | undefined
      const content = msg?.content as Array<Record<string, unknown>> | undefined
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' && block.name) {
            currentTools.push(block.name as string)
          }
        }
      }
      // Extract model
      if (entry.model && typeof entry.model === 'string') {
        model = entry.model
      }
    }
  }

  // Don't forget the last turn
  if (inTurn && currentTools.length > 0) {
    turns.push({
      sessionId,
      cwd,
      model,
      timestamp: turnTimestamp,
      promptSnippet: currentPrompt,
      toolNames: currentTools,
    })
  }

  return turns
}

// ─── File Discovery ─────────────────────────────────────────────────

function findJsonlFiles(dir: string, maxDepth = 6): string[] {
  const results: string[] = []

  function walk(current: string, depth: number) {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }

    for (const name of entries) {
      if (name.startsWith('.')) continue
      const full = join(current, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          // Skip subagents dir for cleaner data
          if (name === 'subagents') continue
          walk(full, depth + 1)
        } else if (name.endsWith('.jsonl') && st.size > 0) {
          results.push(full)
        }
      } catch {}
    }
  }

  walk(dir, 0)
  return results
}

// ─── Main ───────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2)
  const dbIdx = args.indexOf('--db')
  const dirIdx = args.indexOf('--dir')
  const dryRun = args.includes('--dry-run')
  const verbose = args.includes('--verbose')

  const dbPath = dbIdx >= 0 ? resolve(args[dbIdx + 1]) : join(homedir(), '.cache', 'concentrator', 'analytics.db')
  const scanDir = dirIdx >= 0 ? resolve(args[dirIdx + 1]) : join(homedir(), '.claude', 'projects')

  console.log(`Analytics Import`)
  console.log(`  DB: ${dbPath}`)
  console.log(`  Scan: ${scanDir}`)
  console.log(`  Dry run: ${dryRun}`)
  console.log()

  if (!existsSync(scanDir)) {
    console.error(`Directory not found: ${scanDir}`)
    process.exit(1)
  }

  // Find all JSONL files
  console.log('Discovering transcript files...')
  const files = findJsonlFiles(scanDir)
  console.log(`Found ${files.length} transcript files`)

  // Open DB (create if needed)
  let db: Database | null = null
  if (!dryRun) {
    db = new Database(dbPath, { strict: true })
    db.run('PRAGMA journal_mode = WAL')
    db.run('PRAGMA synchronous = OFF') // Speed over safety for bulk import
    db.run('PRAGMA cache_size = -32000') // 32MB cache for import

    // Create tables if they don't exist (same schema as analytics-store)
    db.run(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL DEFAULT '',
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

    db.run('CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON turns(timestamp)')
    db.run('CREATE INDEX IF NOT EXISTS idx_analytics_session ON turns(session_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_analytics_cwd ON turns(cwd)')
    db.run('CREATE INDEX IF NOT EXISTS idx_analytics_project ON turns(project_id)')
    db.run('CREATE INDEX IF NOT EXISTS idx_analytics_category ON turns(task_category)')
    db.run('CREATE INDEX IF NOT EXISTS idx_tool_uses_timestamp ON tool_uses(timestamp)')
    db.run('CREATE INDEX IF NOT EXISTS idx_tool_uses_name ON tool_uses(tool_name)')
  }

  // Check existing data to skip duplicates
  let existingSessions = new Set<string>()
  if (db) {
    const rows = db.query('SELECT DISTINCT session_id FROM turns').all() as Array<{ session_id: string }>
    existingSessions = new Set(rows.map(r => r.session_id))
    if (existingSessions.size > 0) {
      console.log(`Skipping ${existingSessions.size} already-imported sessions`)
    }
  }

  const stmtTurn = db?.prepare(`
    INSERT INTO turns (timestamp, session_id, cwd, project_id, model, account,
      tool_sequence, tool_call_count, task_category, retry_count,
      one_shot, had_error, prompt_snippet)
    VALUES ($timestamp, $sessionId, $cwd, $projectId, $model, $account,
      $toolSequence, $toolCallCount, $taskCategory, $retryCount,
      $oneShot, $hadError, $promptSnippet)
  `)

  const stmtToolUse = db?.prepare(`
    INSERT INTO tool_uses (timestamp, session_id, tool_name)
    VALUES ($timestamp, $sessionId, $toolName)
  `)

  // Stats
  let totalFiles = 0
  let totalTurns = 0
  let skippedSessions = 0
  const categoryCounts = new Map<string, number>()

  // Process in batches with transactions
  const BATCH_SIZE = 100
  let batchCount = 0

  const insertBatch = db?.transaction((turns: Turn[]) => {
    for (const turn of turns) {
      const retryCount = countRetries(turn.toolNames)
      const hasEdits = turn.toolNames.some(t => EDIT_TOOLS.has(t))
      const taskCategory = classifyTurn(turn.toolNames, turn.promptSnippet)

      stmtTurn?.run({
        timestamp: turn.timestamp,
        sessionId: turn.sessionId,
        cwd: turn.cwd,
        projectId: deriveProjectId(turn.cwd),
        model: turn.model,
        account: '',
        toolSequence: turn.toolNames.join(','),
        toolCallCount: turn.toolNames.length,
        taskCategory,
        retryCount,
        oneShot: hasEdits && retryCount === 0 ? 1 : 0,
        hadError: 0,
        promptSnippet: turn.promptSnippet,
      })

      for (const toolName of turn.toolNames) {
        stmtToolUse?.run({
          timestamp: turn.timestamp,
          sessionId: turn.sessionId,
          toolName,
        })
      }
    }
  })

  let pendingTurns: Turn[] = []

  for (const file of files) {
    totalFiles++

    const turns = parseTranscript(file)
    if (turns.length === 0) continue

    // Skip if session already imported
    const sid = turns[0].sessionId
    if (sid && existingSessions.has(sid)) {
      skippedSessions++
      continue
    }

    if (verbose) {
      const shortPath = file.replace(homedir(), '~')
      console.log(`  ${shortPath}: ${turns.length} turns`)
    }

    totalTurns += turns.length

    // Always classify for stats (even in dry run)
    for (const turn of turns) {
      const taskCategory = classifyTurn(turn.toolNames, turn.promptSnippet)
      categoryCounts.set(taskCategory, (categoryCounts.get(taskCategory) || 0) + 1)
    }

    if (!dryRun) {
      pendingTurns.push(...turns)
      if (pendingTurns.length >= BATCH_SIZE) {
        insertBatch?.(pendingTurns)
        batchCount++
        pendingTurns = []

        if (batchCount % 10 === 0) {
          process.stdout.write(`\r  Processed ${totalFiles}/${files.length} files, ${totalTurns} turns...`)
        }
      }
    }
  }

  // Flush remaining
  if (pendingTurns.length > 0) {
    insertBatch?.(pendingTurns)
  }

  if (db) {
    db.run('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
  }

  console.log()
  console.log(`Done!`)
  console.log(`  Files scanned: ${totalFiles}`)
  console.log(`  Sessions skipped (already imported): ${skippedSessions}`)
  console.log(`  Turns imported: ${totalTurns}`)
  console.log()
  console.log('Task breakdown:')
  const sorted = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])
  for (const [category, count] of sorted) {
    const pct = ((count / totalTurns) * 100).toFixed(1)
    console.log(`  ${category.padEnd(15)} ${String(count).padStart(6)} (${pct}%)`)
  }
}

main()
