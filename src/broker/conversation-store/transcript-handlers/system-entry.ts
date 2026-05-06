import type { Conversation, TranscriptSystemEntry } from '../../../shared/protocol'
import { parseRecapContent } from '../../../shared/recap'
import type { ConversationStoreContext } from '../event-context'
import { detectContextModeFromStdout } from '../parsers'

/**
 * Per-system-entry dispatch: compact_boundary, turn_duration, away_summary,
 * local_command. Returns true when conversation metadata changed.
 */
export function handleSystemEntry(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptSystemEntry,
  isInitial: boolean,
): boolean {
  let changed = false

  if (entry.subtype === 'compact_boundary') {
    if (handleCompactBoundary(ctx, conversationId, conv, entry, isInitial)) changed = true
  }

  if (typeof entry.content === 'string' && entry.subtype === 'local_command') {
    if (applyContextMode(conversationId, conv, entry.content)) changed = true
  }

  if (entry.subtype === 'away_summary') {
    if (handleAwaySummaryEntry(conv, entry)) changed = true
  }

  if (!isInitial && entry.subtype === 'turn_duration' && typeof entry.durationMs === 'number') {
    conv.stats.totalApiDurationMs += entry.durationMs
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
  conv: Conversation,
  entry: TranscriptSystemEntry,
  isInitial: boolean,
): boolean {
  if (isInitial) {
    conv.stats.compactionCount++
    conv.compactedAt = new Date(entry.timestamp || 0).getTime()
    return false
  }

  // Live: cross-check against hook-based detection.
  // If hooks already handled this compaction (compactedAt set recently), skip.
  const recentlyCompacted = !!conv.compactedAt && Date.now() - conv.compactedAt < 30_000
  if (recentlyCompacted || conv.compacting) return false

  conv.compactedAt = Date.now()
  conv.stats.compactionCount++
  const marker = { type: 'compacted' as const, timestamp: entry.timestamp || new Date().toISOString() }
  ctx.addTranscriptEntries(conversationId, [marker], false)
  ctx.broadcastToChannel('conversation:transcript', conversationId, {
    type: 'transcript_entries',
    conversationId,
    entries: [marker],
    isInitial: false,
  })
  console.log(`[compact] detected via JSONL compact_boundary (conversation ${conversationId.slice(0, 8)})`)
  return true
}

/**
 * away_summary system entry: extract recap content and flip 'active'
 * to 'idle' (CC writes away_summary precisely because the conversation
 * went idle long enough to need a "what were we doing" summary).
 */
function handleAwaySummaryEntry(conv: Conversation, entry: TranscriptSystemEntry): boolean {
  const content = entry.content
  if (typeof content !== 'string' || !content.trim()) return false
  const parsed = parseRecapContent(content)
  const recapTs = new Date(entry.timestamp || 0).getTime()
  conv.recap = { content: parsed.recap, title: parsed.title || undefined, timestamp: recapTs }
  conv.recapFresh = conv.lastActivity <= recapTs + 10_000
  if (conv.status === 'active') {
    conv.status = 'idle'
  }
  return true
}

/**
 * Detect context mode (`compact` / `default`) from a /model or /context
 * stdout payload and apply it to the session if it changed. Shared between
 * system local_command entries and user entries that wrap stdout in
 * `<local-command-stdout>` blocks.
 */
export function applyContextMode(conversationId: string, conv: Conversation, stdout: string): boolean {
  const mode = detectContextModeFromStdout(stdout)
  if (!mode || conv.contextMode === mode) return false
  conv.contextMode = mode
  console.log(`[meta] context mode: ${mode} (conversation ${conversationId.slice(0, 8)})`)
  return true
}
