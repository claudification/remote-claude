/**
 * Termination Log -- daily-rotated NDJSON of every conversation termination.
 *
 * Why NDJSON not SQLite: terminations are append-only, low-volume, and we
 * want them grep-able from a shell. SQLite would be overkill and would
 * couple termination diagnostics to the store's WAL/migration story.
 *
 * Layout:
 *   {cacheDir}/terminations/2026-05-11.ndjson
 *   {cacheDir}/terminations/2026-05-12.ndjson
 *   ...
 *
 * Retention: 30 days. Sweep runs on startup + daily.
 *
 * Search: use `broker-cli termination` from inside the broker container
 * (the cacheDir is the docker volume `concentrator-data`). The CLI is also
 * a thin grep wrapper around the same files.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { TerminationDetail, TerminationSource } from '../shared/protocol'

const DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_DAYS = 30
const SUBDIR = 'terminations'

export interface TerminationRecord {
  /** ISO 8601 timestamp at termination */
  ts: string
  /** Conversation that ended */
  conversationId: string
  /** Typed source enum */
  source: TerminationSource
  /** Auth principal or system actor that initiated the kill */
  initiator?: string
  /** Project URI of the ended conversation (for filtering) */
  project?: string
  /** Conversation title at time of death (for human grepping) */
  title?: string
  /** Structured extra context */
  detail?: TerminationDetail
}

export interface TerminationLog {
  /** Append a record to today's NDJSON file. Best-effort, never throws. */
  append(rec: TerminationRecord): void
  /** Read records from the last N days, optionally filtered. */
  query(opts?: TerminationQuery): TerminationRecord[]
  /** Path to today's file (useful for tests and docs). */
  todayFile(): string
  /** Run the retention sweep now. Returns number of files deleted. */
  sweep(): number
}

export interface TerminationQuery {
  /** Lookback window in days. Default 7. Cap 30 (retention). */
  days?: number
  conversationId?: string
  source?: TerminationSource | TerminationSource[]
  initiator?: string
  /** Free-text contains-match against JSON-stringified record. */
  grep?: string
  /** Hard cap on result count. Default 1000. */
  limit?: number
}

function dateStamp(d = new Date()): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Construct a TerminationLog rooted at `{cacheDir}/terminations/`.
 * Caller invokes startSweep() if they want the daily retention loop.
 */
export function createTerminationLog(cacheDir: string): TerminationLog {
  const dir = join(cacheDir, SUBDIR)
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.error(`[termination-log] mkdir failed: ${err} -- log writes will be skipped`)
  }

  function todayFile(): string {
    return join(dir, `${dateStamp()}.ndjson`)
  }

  function append(rec: TerminationRecord): void {
    try {
      const line = `${JSON.stringify(rec)}\n`
      appendFileSync(todayFile(), line, { encoding: 'utf8' })
    } catch (err) {
      // Best-effort: a broken termination log shouldn't break the broker.
      console.error(`[termination-log] append failed for ${rec.conversationId}: ${err}`)
    }
  }

  function listFiles(): string[] {
    try {
      return readdirSync(dir)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f))
        .sort()
        .reverse()
        .map(f => join(dir, f))
    } catch {
      return []
    }
  }

  function query(opts: TerminationQuery = {}): TerminationRecord[] {
    const days = Math.min(opts.days ?? 7, RETENTION_DAYS)
    const limit = opts.limit ?? 1000
    const cutoff = Date.now() - days * DAY_MS
    const sources = opts.source ? (Array.isArray(opts.source) ? new Set(opts.source) : new Set([opts.source])) : null

    const results: TerminationRecord[] = []
    for (const file of listFiles()) {
      let content: string
      try {
        content = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      // Iterate newest-line-first within each file. Files are date-sorted
      // newest-first; individual lines are appended chronologically, so we
      // read forward then reverse to get newest-first overall.
      const lines = content.split('\n').filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        if (results.length >= limit) return results
        let rec: TerminationRecord
        try {
          rec = JSON.parse(lines[i])
        } catch {
          continue
        }
        const tsMs = Date.parse(rec.ts)
        if (Number.isFinite(tsMs) && tsMs < cutoff) return results
        if (opts.conversationId && rec.conversationId !== opts.conversationId) continue
        if (sources && !sources.has(rec.source)) continue
        if (opts.initiator && rec.initiator !== opts.initiator) continue
        if (opts.grep && !lines[i].includes(opts.grep)) continue
        results.push(rec)
      }
    }
    return results
  }

  function sweep(): number {
    const cutoff = Date.now() - RETENTION_DAYS * DAY_MS
    let deleted = 0
    for (const path of listFiles()) {
      try {
        const mtime = statSync(path).mtimeMs
        if (mtime < cutoff) {
          unlinkSync(path)
          deleted++
        }
      } catch {
        /* file gone, fine */
      }
    }
    return deleted
  }

  return { append, query, todayFile, sweep }
}

/**
 * Start the daily retention sweep on a created log. Idempotent; caller
 * holds the returned timer if they want to stop it.
 */
export function startTerminationLogSweep(log: TerminationLog): NodeJS.Timeout {
  const run = () => {
    try {
      const n = log.sweep()
      if (n > 0) console.log(`[termination-log] swept ${n} expired NDJSON files (>${RETENTION_DAYS}d)`)
    } catch (err) {
      console.error(`[termination-log] sweep crashed -- swallowing: ${err}`)
    }
  }
  run()
  return setInterval(run, DAY_MS)
}
