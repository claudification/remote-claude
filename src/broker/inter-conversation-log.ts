/**
 * Inter-Conversation Message Log - append log for messages between conversations.
 * Each entry stores a 200-char preview, conversation IDs, and projects.
 * Backed by StoreDriver.messages (SQLite message_log table).
 */

import type { MessageStore } from './store/types'

export interface InterConversationLogEntry {
  ts: number
  from: { conversationId: string; project: string; name: string }
  to: { conversationId: string; project: string; name: string }
  intent: string
  conversationId: string
  preview: string // first 200 chars
  fullLength: number
}

const MAX_ENTRIES = 10_000
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

let store: MessageStore | null = null

export function initInterConversationLog(messageStore: MessageStore): void {
  store = messageStore
  store.compactLog(RETENTION_MS, MAX_ENTRIES)
}

export function appendMessage(entry: InterConversationLogEntry): void {
  if (!store) return
  store.log({
    fromScope: entry.from.project,
    toScope: entry.to.project,
    fromConversationId: entry.from.conversationId,
    toConversationId: entry.to.conversationId,
    fromName: entry.from.name,
    toName: entry.to.name,
    content: entry.preview,
    intent: entry.intent,
    conversationId: entry.conversationId,
    fullLength: entry.fullLength,
    createdAt: entry.ts,
  })
}

export function queryMessages(opts: {
  projectA?: string
  projectB?: string
  project?: string
  limit?: number
  before?: number
}): {
  messages: InterConversationLogEntry[]
  hasMore: boolean
} {
  if (!store) return { messages: [], hasMore: false }

  const limit = Math.min(opts.limit || 50, 200)

  // Use scope filter for single-project or conversation-pair queries
  const scope = opts.projectA || opts.project
  const entries = store.queryLog({
    scope,
    limit: limit + 1, // fetch one extra to detect hasMore
    before: opts.before,
  })

  // Post-filter for project pair (SQLite only does single-scope filter)
  let filtered = entries
  if (opts.projectA && opts.projectB) {
    filtered = entries.filter(
      e =>
        (e.fromScope === opts.projectA && e.toScope === opts.projectB) ||
        (e.fromScope === opts.projectB && e.toScope === opts.projectA),
    )
  }

  const hasMore = filtered.length > limit
  const messages = filtered.slice(0, limit).map(
    (e): InterConversationLogEntry => ({
      ts: e.createdAt,
      from: {
        conversationId: e.fromConversationId || '',
        project: e.fromScope,
        name: e.fromName || e.fromScope,
      },
      to: {
        conversationId: e.toConversationId || '',
        project: e.toScope,
        name: e.toName || e.toScope,
      },
      intent: e.intent || '',
      conversationId: e.conversationId || '',
      preview: e.content || '',
      fullLength: e.fullLength || (e.content?.length ?? 0),
    }),
  )

  return { messages, hasMore }
}

export function purgeMessages(projectA: string, projectB: string): number {
  if (!store) return 0
  return store.purgeLog(projectA, projectB)
}
