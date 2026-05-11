/**
 * broker-cli `termination` subcommand
 *
 * Read-only access to the NDJSON termination log. Runs against the same
 * cache dir as the broker (defaults to ~/.cache/broker, override with
 * --cache-dir). Inside the Docker container the cache dir is the
 * `concentrator-data` volume; invoke via:
 *
 *   docker exec broker broker-cli termination list
 *   docker exec broker broker-cli termination show <conversationId>
 *   docker exec broker broker-cli termination grep <text>
 *
 * Subcommands:
 *   list   -- newest-first table of recent terminations (filters: --source, --initiator, --days, --limit)
 *   show   -- all terminations for one conversationId (--conv <id> or positional)
 *   grep   -- substring search across NDJSON (case-sensitive)
 *
 * Useful filters:
 *   --source <enum>        Single value or comma-separated list
 *   --initiator <string>   Exact match (e.g. "user:lisa", "system:reaper")
 *   --days <N>             Window (default 7, max 30 = retention)
 *   --limit <N>            Max rows (default 50 for list/grep, all for show)
 *   --json                 Emit raw JSON records, one per line
 */

import type { TerminationSource } from '../../shared/protocol'
import { createTerminationLog, type TerminationRecord } from '../termination-log'
import type { ParsedArgs } from './parse-args'

function parseSources(arg: string): TerminationSource[] | undefined {
  if (!arg) return undefined
  return arg.split(',').map(s => s.trim()) as TerminationSource[]
}

function formatRow(rec: TerminationRecord): string {
  const ts = rec.ts.replace('T', ' ').replace('Z', '')
  const cid = rec.conversationId.slice(0, 8)
  const src = rec.source.padEnd(28)
  const initiator = rec.initiator ?? '-'
  const note = rec.detail?.note ?? ''
  const title = rec.title ? ` "${rec.title}"` : ''
  return `${ts}  ${cid}  ${src}  ${initiator.padEnd(20)}  ${note}${title}`
}

function tableHeader(): string {
  return `TIMESTAMP                 CONV      SOURCE                        INITIATOR             NOTE\n${'-'.repeat(120)}`
}

export function handleTermination(args: ParsedArgs): void {
  const log = createTerminationLog(args.cacheDir)
  const sub = args.subCommand || 'list'

  if (sub === 'list') {
    const days = Number.parseInt(args.daysArg, 10) || 7
    const limit = Number.parseInt(args.limitArg, 10) || 50
    const records = log.query({
      days,
      limit,
      source: parseSources(args.sourceArg),
      initiator: args.initiatorArg || undefined,
      grep: args.grepArg || undefined,
    })
    if (args.jsonFlag) {
      for (const rec of records) console.log(JSON.stringify(rec))
      return
    }
    if (records.length === 0) {
      console.log(`No terminations in the last ${days} days matching filters.`)
      return
    }
    console.log(tableHeader())
    for (const rec of records) console.log(formatRow(rec))
    console.log(`\n${records.length} record(s)`)
    return
  }

  if (sub === 'show') {
    const conversationId = args.conversationIdArg
    if (!conversationId) {
      console.error('ERROR: provide --conv <conversationId>')
      process.exit(1)
    }
    const records = log.query({ conversationId, days: 30, limit: 100 })
    if (records.length === 0) {
      console.log(`No terminations found for ${conversationId} in the last 30 days.`)
      return
    }
    if (args.jsonFlag) {
      for (const rec of records) console.log(JSON.stringify(rec))
      return
    }
    console.log(tableHeader())
    for (const rec of records) console.log(formatRow(rec))
    console.log(`\n${records.length} record(s) for ${conversationId}`)
    for (const rec of records) {
      if (rec.detail && Object.keys(rec.detail).length > 0) {
        console.log(`\n${rec.ts} detail:`)
        console.log(`  ${JSON.stringify(rec.detail, null, 2).split('\n').join('\n  ')}`)
      }
    }
    return
  }

  if (sub === 'grep') {
    const needle = args.grepArg || args.queryArg
    if (!needle) {
      console.error('ERROR: provide --grep <text> or positional argument')
      process.exit(1)
    }
    const days = Number.parseInt(args.daysArg, 10) || 30
    const records = log.query({ days, grep: needle, limit: 1000 })
    if (records.length === 0) {
      console.log(`No matches for "${needle}" in the last ${days} days.`)
      return
    }
    if (args.jsonFlag) {
      for (const rec of records) console.log(JSON.stringify(rec))
      return
    }
    console.log(tableHeader())
    for (const rec of records) console.log(formatRow(rec))
    console.log(`\n${records.length} match(es) for "${needle}"`)
    return
  }

  console.error(`Unknown termination subcommand: ${sub}`)
  console.error('Available: list, show, grep')
  process.exit(1)
}
