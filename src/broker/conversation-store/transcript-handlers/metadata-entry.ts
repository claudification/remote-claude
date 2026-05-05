import type {
  Conversation,
  TranscriptAgentNameEntry,
  TranscriptCustomTitleEntry,
  TranscriptPrLinkEntry,
  TranscriptSummaryEntry,
} from '../../../shared/protocol'

/**
 * Top-level transcript entries that carry session metadata. Each one mutates
 * a single session field; returns true when something actually changed so
 * the orchestrator can trigger a session update.
 */

export function handleSummaryEntry(
  conversationId: string,
  session: Conversation,
  entry: TranscriptSummaryEntry,
): boolean {
  const s = entry.summary
  if (typeof s !== 'string' || !s.trim()) return false
  session.summary = s.trim()
  console.log(`[meta] summary: "${session.summary.slice(0, 60)}" (session ${conversationId.slice(0, 8)})`)
  return true
}

export function handleCustomTitleEntry(
  conversationId: string,
  session: Conversation,
  entry: TranscriptCustomTitleEntry,
): boolean {
  const t = entry.customTitle
  if (typeof t !== 'string' || !t.trim()) return false
  session.title = t.trim()
  console.log(`[meta] title: "${session.title}" (session ${conversationId.slice(0, 8)})`)
  return true
}

export function handleAgentNameEntry(
  conversationId: string,
  session: Conversation,
  entry: TranscriptAgentNameEntry,
): boolean {
  const n = entry.agentName
  if (typeof n !== 'string' || !n.trim()) return false
  session.agentName = n.trim()
  console.log(`[meta] agent: "${session.agentName}" (session ${conversationId.slice(0, 8)})`)
  return true
}

export function handlePrLinkEntry(
  conversationId: string,
  session: Conversation,
  entry: TranscriptPrLinkEntry,
): boolean {
  const { prNumber, prUrl, prRepository } = entry
  if (!prNumber || !prUrl) return false
  if (!session.prLinks) session.prLinks = []
  // Deduplicate by prUrl
  if (session.prLinks.some(p => p.prUrl === prUrl)) return false
  session.prLinks.push({
    prNumber,
    prUrl,
    prRepository: prRepository || '',
    timestamp: entry.timestamp || new Date().toISOString(),
  })
  console.log(
    `[meta] pr-link: ${prRepository}#${prNumber} (session ${conversationId.slice(0, 8)}, total: ${session.prLinks.length})`,
  )
  return true
}
