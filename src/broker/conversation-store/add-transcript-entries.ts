import { randomUUID } from 'node:crypto'
import type {
  Conversation,
  TranscriptAgentNameEntry,
  TranscriptAssistantEntry,
  TranscriptCustomTitleEntry,
  TranscriptEntry,
  TranscriptPrLinkEntry,
  TranscriptSummaryEntry,
  TranscriptSystemEntry,
  TranscriptUserEntry,
} from '../../shared/protocol'
import type { TranscriptEntryInput } from '../store/types'
import { MAX_TRANSCRIPT_ENTRIES } from './constants'
import { assignTranscriptSeqs, type ConversationStoreContext } from './event-context'
import { handleAssistantEntry } from './transcript-handlers/assistant-entry'
import { detectBgTaskNotifications } from './transcript-handlers/bg-task-notifications'
import { handleMentionNotifications } from './transcript-handlers/mention-notify'
import {
  handleAgentNameEntry,
  handleCustomTitleEntry,
  handlePrLinkEntry,
  handleSummaryEntry,
} from './transcript-handlers/metadata-entry'
import { extractLiveSubagentEntries } from './transcript-handlers/subagent-extraction'
import { handleSystemEntry } from './transcript-handlers/system-entry'
import { handleUserEntry } from './transcript-handlers/user-entry'

/**
 * Persist a batch of transcript entries to the cache + derive conversation-level
 * stats / metadata from them. Re-broadcasts compaction markers and live
 * subagent transcripts. No-op when the conversation isn't registered.
 *
 * Thin orchestrator: cache + seq stamping + dirty flag + stats reset live
 * here, plus post-loop scans for bg-task notifications and live subagent
 * transcripts. Per-entry-type work delegates to typed helpers under
 * `transcript-handlers/`, dispatched through the `entryHandlers` table
 * below. Each helper returns `boolean` indicating whether conversation metadata
 * changed so the orchestrator can decide if a conversation update is warranted.
 */
export function addTranscriptEntries(
  ctx: ConversationStoreContext,
  conversationId: string,
  entries: TranscriptEntry[],
  isInitial: boolean,
): void {
  // Stamp seqs BEFORE cache insert and BEFORE any broadcast the caller does.
  // All entries in `entries` are mutated in place with `entry.seq = N`.
  // Callers (handlers/transcript.ts, handlers/boot-lifecycle.ts) then
  // broadcast the same objects, so the wire payload carries seqs too.
  assignTranscriptSeqs(ctx.transcriptSeqCounters, conversationId, entries, isInitial)
  appendToCache(ctx, conversationId, entries, isInitial)
  persistToStore(ctx, conversationId, entries)
  ctx.dirtyTranscripts.add(conversationId)

  const conv = ctx.conversations.get(conversationId)
  if (!conv) return

  if (!conv.stats || isInitial) resetSessionMetadataAndStats(conv, isInitial)

  let sessionChanged = false
  for (const entry of entries) {
    // gitBranch lives on the base type and applies to any entry
    if (!conv.gitBranch && entry.gitBranch) {
      conv.gitBranch = entry.gitBranch
      sessionChanged = true
    }

    if (entryHandlers[entry.type]?.(ctx, conversationId, conv, entry, isInitial)) {
      sessionChanged = true
    }
  }

  // Post-loop scans: bg task completion + live subagent extraction
  if (detectBgTaskNotifications(conv, entries)) sessionChanged = true
  extractLiveSubagentEntries(ctx, conversationId, entries)

  if (sessionChanged) ctx.scheduleConversationUpdate(conversationId)
}

// ─── per-entry-type dispatch table ─────────────────────────────────────────
//
// Each entry adapts a typed transcript-handler helper to the uniform
// `TranscriptEntryHandler` signature so the orchestrator can dispatch
// through a `Record<entryType, TranscriptEntryHandler>`. The narrow cast
// happens once at the boundary in each adapter; the helpers themselves
// work with the narrow type. Each adapter returns `true` when conversation
// metadata mutated, so the orchestrator can OR the results and decide
// whether to schedule a conversation update.

type TranscriptEntryHandler = (
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  isInitial: boolean,
) => boolean

function dispatchCompacted(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  conv: Conversation,
  _entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  conv.stats.compactionCount++
  return false
}

function dispatchUserEntry(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  isInitial: boolean,
): boolean {
  return handleUserEntry(ctx, conversationId, conv, entry as TranscriptUserEntry, isInitial)
}

function dispatchAssistantEntry(
  ctx: ConversationStoreContext,
  _conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  isInitial: boolean,
): boolean {
  const assistantEntry = entry as TranscriptAssistantEntry
  const changed = handleAssistantEntry(conv, assistantEntry)
  handleMentionNotifications(ctx, conv, assistantEntry, isInitial)
  return changed
}

function dispatchSystemEntry(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  isInitial: boolean,
): boolean {
  return handleSystemEntry(ctx, conversationId, conv, entry as TranscriptSystemEntry, isInitial)
}

function dispatchSummaryEntry(
  _ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  return handleSummaryEntry(conversationId, conv, entry as TranscriptSummaryEntry)
}

function dispatchCustomTitleEntry(
  _ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  return handleCustomTitleEntry(conversationId, conv, entry as TranscriptCustomTitleEntry)
}

function dispatchAgentNameEntry(
  _ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  return handleAgentNameEntry(conversationId, conv, entry as TranscriptAgentNameEntry)
}

function dispatchPrLinkEntry(
  _ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  return handlePrLinkEntry(conversationId, conv, entry as TranscriptPrLinkEntry)
}

const entryHandlers: Record<string, TranscriptEntryHandler> = {
  compacted: dispatchCompacted,
  user: dispatchUserEntry,
  assistant: dispatchAssistantEntry,
  system: dispatchSystemEntry,
  summary: dispatchSummaryEntry,
  'custom-title': dispatchCustomTitleEntry,
  'agent-name': dispatchAgentNameEntry,
  'pr-link': dispatchPrLinkEntry,
}

/**
 * Persist transcript entries to the StoreDriver so they're queryable via the
 * FTS5 search index. The append uses INSERT OR IGNORE on (conversation_id, uuid)
 * so re-reading the same JSONL on hydrate / reconnect skips duplicates without
 * blowing up. Entries without a uuid get one synthesized -- the live wire
 * format makes uuid optional, but the store treats it as the dedup key.
 *
 * Failures are swallowed: if the store is misconfigured or the underlying DB
 * is in a weird state, transcript ingest must keep working for the dashboard.
 * Search just won't find these entries until things recover.
 */
function persistToStore(ctx: ConversationStoreContext, conversationId: string, entries: TranscriptEntry[]): void {
  if (!ctx.store || entries.length === 0) return
  const inputs: TranscriptEntryInput[] = []
  for (const e of entries) {
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Date.now()
    inputs.push({
      type: e.type,
      subtype:
        typeof (e as Record<string, unknown>).subtype === 'string'
          ? ((e as Record<string, unknown>).subtype as string)
          : undefined,
      uuid: e.uuid || randomUUID(),
      content: e as unknown as Record<string, unknown>,
      timestamp: Number.isFinite(ts) ? ts : Date.now(),
    })
  }
  try {
    ctx.store.transcripts.append(conversationId, 'live', inputs)
  } catch (err) {
    // Don't break ingest if the store is unhappy. Log via console so it shows up
    // in broker stderr without dragging in the broker logger here.
    console.error('[transcript-store] append failed:', err instanceof Error ? err.message : err)
  }
}

function appendToCache(
  ctx: ConversationStoreContext,
  conversationId: string,
  entries: TranscriptEntry[],
  isInitial: boolean,
): void {
  if (isInitial) {
    ctx.transcriptCache.set(conversationId, entries.slice(-MAX_TRANSCRIPT_ENTRIES))
    return
  }
  const existing = ctx.transcriptCache.get(conversationId) || []
  existing.push(...entries)
  if (existing.length > MAX_TRANSCRIPT_ENTRIES) {
    ctx.transcriptCache.set(conversationId, existing.slice(-MAX_TRANSCRIPT_ENTRIES))
  } else {
    ctx.transcriptCache.set(conversationId, existing)
  }
}

function resetSessionMetadataAndStats(
  conv: NonNullable<ReturnType<ConversationStoreContext['conversations']['get']>>,
  isInitial: boolean,
): void {
  // Reset metadata + stats on initial load to avoid double-counting when
  // the transcript watcher re-reads the full file (restart, reconnect,
  // truncation recovery). Preserve user-set titles (set via spawn dialog).
  if (isInitial) {
    conv.summary = undefined
    if (!conv.titleUserSet) conv.title = undefined
    conv.agentName = undefined
    conv.prLinks = undefined
  }
  conv.stats = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreation: 0,
    totalCacheWrite5m: 0,
    totalCacheWrite1h: 0,
    totalCacheRead: 0,
    turnCount: 0,
    toolCallCount: 0,
    compactionCount: 0,
    linesAdded: 0,
    linesRemoved: 0,
    totalApiDurationMs: 0,
  }
}
