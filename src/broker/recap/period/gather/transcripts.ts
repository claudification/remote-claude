import type { StoreDriver, TranscriptEntryRecord } from '../../../store/types'
import { extractUserPromptsAndFinals, type PeriodTurn } from '../../shared/transcript-extract'
import type { ConversationDigest, PeriodScope, TranscriptDigest } from './types'

export function gatherTranscripts(
  store: StoreDriver,
  conversations: ConversationDigest[],
  scope: PeriodScope,
  includeInternals = false,
): TranscriptDigest[] {
  return conversations.map(conv => ({
    conversationId: conv.id,
    conversationTitle: conv.title,
    turns: digestForConversation(store, conv.id, scope, includeInternals),
  }))
}

function digestForConversation(
  store: StoreDriver,
  id: string,
  scope: PeriodScope,
  includeInternals: boolean,
): PeriodTurn[] {
  const entries = store.transcripts.find(id, {
    after: scope.periodStart,
    before: scope.periodEnd,
    limit: 1000,
  })
  if (entries.length === 0) return []
  return extractUserPromptsAndFinals(entries.map(toLooseTranscriptEntry), { includeInternals })
}

function toLooseTranscriptEntry(rec: TranscriptEntryRecord): never {
  return {
    type: rec.type,
    uuid: rec.uuid,
    timestamp: rec.timestamp,
    ...(rec.subtype ? { subtype: rec.subtype } : {}),
    ...rec.content,
  } as never
}
