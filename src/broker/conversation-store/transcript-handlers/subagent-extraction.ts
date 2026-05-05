import type { TranscriptEntry, TranscriptProgressEntry } from '../../../shared/protocol'
import type { ConversationStoreContext } from '../event-context'

/**
 * Extract live subagent progress entries from a parent transcript batch.
 * During runtime CC embeds agent progress in the parent transcript with a
 * `data.agentId` discriminant; we move those entries into the per-agent
 * subagent transcript cache and broadcast on the dedicated channel, then
 * filter them out of the parent cache (so the parent UI doesn't re-render
 * subagent chatter inline).
 */
export function extractLiveSubagentEntries(
  ctx: ConversationStoreContext,
  conversationId: string,
  entries: TranscriptEntry[],
): void {
  const agentEntries = collectByAgent(entries)
  if (agentEntries.size === 0) return

  for (const [agentId, agentBatch] of agentEntries) {
    console.log(
      `[transcript] ${conversationId.slice(0, 8)}... live agent ${agentId.slice(0, 7)} ${agentBatch.length} entries from parent`,
    )
    ctx.addSubagentTranscriptEntries(conversationId, agentId, agentBatch, false)
    ctx.broadcastToChannel(
      'conversation:subagent_transcript',
      conversationId,
      {
        type: 'subagent_transcript',
        conversationId,
        agentId,
        entries: agentBatch,
        isInitial: false,
      },
      agentId,
    )
  }

  // Filter extracted entries out of the parent cache (they were copied, not moved)
  const agentEntrySet = new Set([...agentEntries.values()].flat())
  const cached = ctx.transcriptCache.get(conversationId)
  if (cached) {
    ctx.transcriptCache.set(
      conversationId,
      cached.filter(e => !agentEntrySet.has(e)),
    )
  }
}

function collectByAgent(entries: TranscriptEntry[]): Map<string, TranscriptEntry[]> {
  const out = new Map<string, TranscriptEntry[]>()
  for (const entry of entries) {
    if (entry.type !== 'progress') continue
    const agentId = (entry as TranscriptProgressEntry).data?.agentId
    if (typeof agentId !== 'string') continue
    let batch = out.get(agentId)
    if (!batch) {
      batch = []
      out.set(agentId, batch)
    }
    batch.push(entry)
  }
  return out
}
