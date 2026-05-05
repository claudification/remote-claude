import type { Conversation, TranscriptAssistantEntry } from '../../../shared/protocol'

/**
 * Per-assistant-entry processing: tool count, model fallback, token usage
 * extraction, cost timeline (PTY only). Skips `<synthetic>` assistant
 * blocks (auto-compact summaries, recap, hook-injected) since they aren't
 * real API turns.
 *
 * Returns true when usage was extracted (which mutates lots of stats).
 */
export function handleAssistantEntry(session: Conversation, entry: TranscriptAssistantEntry): boolean {
  const content = entry.message?.content
  if (Array.isArray(content)) {
    session.stats.toolCallCount += content.filter(c => c.type === 'tool_use').length
  }

  // Init message (session.model) is ground truth. Assistant messages strip
  // context-window suffixes like [1m], so only use as a last-resort fallback.
  const assistantModel = entry.message?.model
  if (typeof assistantModel === 'string' && assistantModel !== '<synthetic>' && !session.model) {
    session.model = assistantModel
  }

  return extractUsage(session, entry, assistantModel)
}

function extractUsage(
  session: Conversation,
  entry: TranscriptAssistantEntry,
  assistantModel: string | undefined,
): boolean {
  const usage = entry.message?.usage
  if (!usage || typeof usage.input_tokens !== 'number' || assistantModel === '<synthetic>') return false

  session.tokenUsage = {
    input: usage.input_tokens || 0,
    cacheCreation: usage.cache_creation_input_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    output: usage.output_tokens || 0,
  }

  // Extract 5m/1h cache write split from usage.cache_creation
  const cc = usage.cache_creation
  const cw5m = (cc?.ephemeral_5m_input_tokens as number | undefined) || 0
  const cw1h = (cc?.ephemeral_1h_input_tokens as number | undefined) || 0
  // Fallback: if total cache_creation > sum of 5m+1h, remainder -> 5m bucket
  const cwTotal = usage.cache_creation_input_tokens || 0
  const cwRemainder = Math.max(0, cwTotal - cw5m - cw1h)

  if (cw5m + cwRemainder > 0 || cw1h > 0) {
    session.cacheTtl = cw1h > cw5m + cwRemainder ? '1h' : '5m'
  }

  session.stats.totalInputTokens += (usage.input_tokens || 0) + cwTotal + (usage.cache_read_input_tokens || 0)
  session.stats.totalOutputTokens += usage.output_tokens || 0
  session.stats.totalCacheCreation += cwTotal
  session.stats.totalCacheWrite5m += cw5m + cwRemainder
  session.stats.totalCacheWrite1h += cw1h
  session.stats.totalCacheRead += usage.cache_read_input_tokens || 0

  // Cost timeline snapshot for PTY sessions (headless uses turn_cost from stream backend)
  if (!session.stats.totalCostUsd) {
    if (!session.costTimeline) session.costTimeline = []
    const s = session.stats
    const uncached = Math.max(0, s.totalInputTokens - s.totalCacheCreation - s.totalCacheRead)
    const est =
      (uncached * 15 +
        s.totalOutputTokens * 75 +
        s.totalCacheRead * 1.875 +
        s.totalCacheWrite5m * 18.75 +
        s.totalCacheWrite1h * 30) /
      1_000_000
    session.costTimeline.push({ t: Date.now(), cost: est })
    if (session.costTimeline.length > 500) {
      session.costTimeline = session.costTimeline.slice(-500)
    }
  }

  return true
}
