import type { Conversation, TranscriptSystemEntry } from '../../../shared/protocol'
import type { ConversationStoreContext } from '../event-context'
import { detectContextModeFromStdout } from '../parsers'

/**
 * Per-system-entry dispatch: compact_boundary, turn_duration, away_summary,
 * local_command. Returns true when session metadata changed.
 */
export function handleSystemEntry(
  ctx: ConversationStoreContext,
  conversationId: string,
  session: Conversation,
  entry: TranscriptSystemEntry,
  isInitial: boolean,
): boolean {
  let changed = false

  if (entry.subtype === 'compact_boundary') {
    if (handleCompactBoundary(ctx, conversationId, session, entry, isInitial)) changed = true
  }

  if (typeof entry.content === 'string' && entry.subtype === 'local_command') {
    if (applyContextMode(conversationId, session, entry.content)) changed = true
  }

  if (entry.subtype === 'away_summary') {
    if (handleAwaySummaryEntry(session, entry)) changed = true
  }

  if (!isInitial && entry.subtype === 'turn_duration' && typeof entry.durationMs === 'number') {
    session.stats.totalApiDurationMs += entry.durationMs
    changed = true
  }

  return changed
}

/**
 * Native CC compact_boundary system entry: count it, cross-check against
 * hook-based detection so we don't double-mark, emit a synthetic
 * `compacted` marker on live updates when hooks didn't already.
 */
function handleCompactBoundary(
  ctx: ConversationStoreContext,
  conversationId: string,
  session: Conversation,
  entry: TranscriptSystemEntry,
  isInitial: boolean,
): boolean {
  if (isInitial) {
    session.stats.compactionCount++
    session.compactedAt = new Date(entry.timestamp || 0).getTime()
    return false
  }

  // Live: cross-check against hook-based detection.
  // If hooks already handled this compaction (compactedAt set recently), skip.
  const recentlyCompacted = !!session.compactedAt && Date.now() - session.compactedAt < 30_000
  if (recentlyCompacted || session.compacting) return false

  session.compactedAt = Date.now()
  session.stats.compactionCount++
  const marker = { type: 'compacted' as const, timestamp: entry.timestamp || new Date().toISOString() }
  ctx.addTranscriptEntries(conversationId, [marker], false)
  ctx.broadcastToChannel('conversation:transcript', conversationId, {
    type: 'transcript_entries',
    conversationId,
    entries: [marker],
    isInitial: false,
  })
  console.log(`[compact] detected via JSONL compact_boundary (session ${conversationId.slice(0, 8)})`)
  return true
}

/**
 * away_summary system entry: extract recap content and flip 'active'
 * to 'idle' (CC writes away_summary precisely because the conversation
 * went idle long enough to need a "what were we doing" summary).
 */
function handleAwaySummaryEntry(session: Conversation, entry: TranscriptSystemEntry): boolean {
  const content = entry.content
  if (typeof content !== 'string' || !content.trim()) return false
  const recapTs = new Date(entry.timestamp || 0).getTime()
  session.recap = { content: content.trim(), timestamp: recapTs }
  session.recapFresh = session.lastActivity <= recapTs + 10_000
  if (session.status === 'active') {
    session.status = 'idle'
  }
  return true
}

/**
 * Detect context mode (`compact` / `default`) from a /model or /context
 * stdout payload and apply it to the session if it changed. Shared between
 * system local_command entries and user entries that wrap stdout in
 * `<local-command-stdout>` blocks.
 */
export function applyContextMode(conversationId: string, session: Conversation, stdout: string): boolean {
  const mode = detectContextModeFromStdout(stdout)
  if (!mode || session.contextMode === mode) return false
  session.contextMode = mode
  console.log(`[meta] context mode: ${mode} (session ${conversationId.slice(0, 8)})`)
  return true
}
