import type { ServerWebSocket } from 'bun'
import type { Conversation, HookEvent, TranscriptEntry } from '../../shared/protocol'
import type { StoreDriver } from '../store/types'
import type { ControlPanelMessage } from './types'

/**
 * Shared state + behavior the addEvent / addTranscriptEntries extracted
 * functions need from the createConversationStore factory closure.
 *
 * Built once at factory construction; passed by reference to keep the
 * extracted functions stateless and unit-testable.
 */
export interface ConversationStoreContext {
  conversations: Map<string, Conversation>
  conversationSockets: Map<string, Map<string, ServerWebSocket<unknown>>>

  transcriptCache: Map<string, TranscriptEntry[]>
  transcriptSeqCounters: Map<string, number>
  subagentTranscriptCache: Map<string, TranscriptEntry[]>
  subagentTranscriptSeqCounters: Map<string, number>
  dirtyTranscripts: Set<string>
  processedClipboardIds: Set<string>
  pendingAgentDescriptions: Map<string, string[]>
  lastTranscriptKick: Map<string, number>
  /**
   * Hashes of mention-notifications already fired, keyed by
   * `${conversationId}:${entryUuid}:${userName}`. Prevents duplicate pushes
   * when the same assistant entry is re-ingested (reconnect, re-stream,
   * sentinel revive). Bounded by mentionNotifyCap with FIFO-ish eviction
   * inside the dispatch helper.
   */
  notifiedMentions: Set<string>

  store?: StoreDriver

  // Behavior: provided by factory because they touch other closure state
  scheduleConversationUpdate: (conversationId: string) => void
  broadcastToChannel: (
    channel: 'conversation:events' | 'conversation:transcript' | 'conversation:subagent_transcript',
    conversationId: string,
    message: unknown,
    agentId?: string,
  ) => void
  broadcastConversationScoped: (message: ControlPanelMessage, project: string) => void
  // addTranscriptEntries calls itself recursively (PreCompact/PostCompact markers).
  // Provide via context so addEvent can call it without forming a cyclic import.
  addTranscriptEntries: (conversationId: string, entries: TranscriptEntry[], isInitial: boolean) => void
  addSubagentTranscriptEntries: (
    conversationId: string,
    agentId: string,
    entries: TranscriptEntry[],
    isInitial: boolean,
  ) => void
}

export function assignTranscriptSeqs(
  counters: Map<string, number>,
  key: string,
  entries: TranscriptEntry[],
  reset: boolean,
): void {
  if (reset) counters.set(key, 0)
  let seq = counters.get(key) ?? 0
  for (const e of entries) {
    e.seq = ++seq
  }
  counters.set(key, seq)
}

export type { HookEvent, TranscriptEntry }
