import type {
  TranscriptAgentNameEntry,
  TranscriptAssistantEntry,
  TranscriptCustomTitleEntry,
  TranscriptEntry,
  TranscriptPrLinkEntry,
  TranscriptSummaryEntry,
  TranscriptSystemEntry,
  TranscriptUserEntry,
} from '../../shared/protocol'
import { MAX_TRANSCRIPT_ENTRIES } from './constants'
import { assignTranscriptSeqs, type ConversationStoreContext } from './event-context'
import { handleAssistantEntry } from './transcript-handlers/assistant-entry'
import { detectBgTaskNotifications } from './transcript-handlers/bg-task-notifications'
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
 * Persist a batch of transcript entries to the cache + derive session-level
 * stats / metadata from them. Re-broadcasts compaction markers and live
 * subagent transcripts. No-op when the conversation isn't registered.
 *
 * Thin orchestrator: cache + seq stamping live here; per-entry-type work
 * delegates to typed helpers under `transcript-handlers/`. Each helper
 * returns `boolean` indicating whether session metadata changed so this
 * function can decide if a session update is warranted.
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
  ctx.dirtyTranscripts.add(conversationId)

  const session = ctx.conversations.get(conversationId)
  if (!session) return

  if (!session.stats || isInitial) resetSessionMetadataAndStats(session, isInitial)

  let sessionChanged = false
  for (const entry of entries) {
    // gitBranch lives on the base type and applies to any entry
    if (!session.gitBranch && entry.gitBranch) {
      session.gitBranch = entry.gitBranch
      sessionChanged = true
    }

    if (entry.type === 'compacted') {
      session.stats.compactionCount++
      continue
    }

    if (entry.type === 'user') {
      if (handleUserEntry(ctx, conversationId, session, entry as TranscriptUserEntry, isInitial)) sessionChanged = true
      continue
    }

    if (entry.type === 'assistant') {
      if (handleAssistantEntry(session, entry as TranscriptAssistantEntry)) sessionChanged = true
      continue
    }

    if (entry.type === 'system') {
      if (handleSystemEntry(ctx, conversationId, session, entry as TranscriptSystemEntry, isInitial)) {
        sessionChanged = true
      }
      continue
    }

    if (entry.type === 'summary') {
      if (handleSummaryEntry(conversationId, session, entry as TranscriptSummaryEntry)) sessionChanged = true
      continue
    }

    if (entry.type === 'custom-title') {
      if (handleCustomTitleEntry(conversationId, session, entry as TranscriptCustomTitleEntry)) sessionChanged = true
      continue
    }

    if (entry.type === 'agent-name') {
      if (handleAgentNameEntry(conversationId, session, entry as TranscriptAgentNameEntry)) sessionChanged = true
      continue
    }

    if (entry.type === 'pr-link') {
      if (handlePrLinkEntry(conversationId, session, entry as TranscriptPrLinkEntry)) sessionChanged = true
    }
  }

  // Post-loop scans: bg task completion + live subagent extraction
  if (detectBgTaskNotifications(session, entries)) sessionChanged = true
  extractLiveSubagentEntries(ctx, conversationId, entries)

  if (sessionChanged) ctx.scheduleConversationUpdate(conversationId)
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
  session: NonNullable<ReturnType<ConversationStoreContext['conversations']['get']>>,
  isInitial: boolean,
): void {
  // Reset metadata + stats on initial load to avoid double-counting when
  // the transcript watcher re-reads the full file (restart, reconnect,
  // truncation recovery). Preserve user-set titles (set via spawn dialog).
  if (isInitial) {
    session.summary = undefined
    if (!session.titleUserSet) session.title = undefined
    session.agentName = undefined
    session.prLinks = undefined
  }
  session.stats = {
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
