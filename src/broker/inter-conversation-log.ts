/**
 * Inter-Conversation Message Log - append log for messages between conversations.
 * Each entry stores a 200-char preview, conversation IDs, and projects.
 * Backed by StoreDriver KVStore (replaces JSONL file persistence).
 */

import type { KVStore } from './store/types'

export interface InterSessionLogEntry {
  ts: number
  from: { conversationId: string; project: string; name: string }
  to: { conversationId: string; project: string; name: string }
  intent: string
  conversationId: string
  preview: string // first 200 chars
  fullLength: number
}

const MAX_ENTRIES = 10_000
const RETENTION_DAYS = 30
const AGGRESSIVE_RETENTION_DAYS = 7

const KV_KEY = 'inter-session-log'

let kv: KVStore | null = null
let entries: InterSessionLogEntry[] = []

export function initInterSessionLog(store: KVStore): void {
  kv = store
  const raw = kv.get<InterSessionLogEntry[]>(KV_KEY)
  if (raw && Array.isArray(raw)) {
    entries = raw
    // Migrate legacy fields
    for (const entry of entries) {
      const from = entry.from as Record<string, unknown>
      const to = entry.to as Record<string, unknown>
      if (from.cwd && !from.project) from.project = from.cwd
      if (to.cwd && !to.project) to.project = to.cwd
      // Legacy migration removed (breaking change branch)
    }
    compact()
  } else {
    entries = []
  }
}

function save(): void {
  if (!kv) return
  kv.set(KV_KEY, entries)
}

export function appendMessage(entry: InterSessionLogEntry): void {
  entries.push(entry)
  save()
}

export function queryMessages(opts: {
  projectA?: string
  projectB?: string
  project?: string
  limit?: number
  before?: number
}): {
  messages: InterSessionLogEntry[]
  hasMore: boolean
} {
  const limit = Math.min(opts.limit || 50, 200)

  let filtered = entries
  if (opts.projectA && opts.projectB) {
    filtered = entries.filter(
      e =>
        (e.from.project === opts.projectA && e.to.project === opts.projectB) ||
        (e.from.project === opts.projectB && e.to.project === opts.projectA),
    )
  } else if (opts.project) {
    filtered = entries.filter(e => e.from.project === opts.project || e.to.project === opts.project)
  }

  if (opts.before) {
    filtered = filtered.filter(e => e.ts < (opts.before as number))
  }

  // Return most recent, paginated
  const hasMore = filtered.length > limit
  const messages = filtered.slice(-limit)
  return { messages, hasMore }
}

export function purgeMessages(projectA: string, projectB: string): number {
  const before = entries.length
  entries = entries.filter(
    e =>
      !(
        (e.from.project === projectA && e.to.project === projectB) ||
        (e.from.project === projectB && e.to.project === projectA)
      ),
  )
  if (entries.length < before) {
    save()
  }
  return before - entries.length
}

function compact(): void {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  let compacted = entries.filter(e => e.ts > cutoff)

  // If still too large, use aggressive retention
  if (compacted.length > MAX_ENTRIES) {
    const aggressiveCutoff = Date.now() - AGGRESSIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000
    compacted = compacted.filter(e => e.ts > aggressiveCutoff)
  }

  if (compacted.length < entries.length) {
    const removed = entries.length - compacted.length
    entries = compacted
    save()
    console.log(`[inter-session-log] Compacted: removed ${removed} entries, ${entries.length} remaining`)
  } else if (entries.length > 0) {
    console.log(`[inter-session-log] ${entries.length} entries (no compaction needed)`)
  }
}
