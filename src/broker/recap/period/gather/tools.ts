import type { StoreDriver, TranscriptEntryRecord } from '../../../store/types'
import type { ConversationDigest, PeriodScope, ToolUseDigest } from './types'

export function gatherToolUse(
  store: StoreDriver,
  conversations: ConversationDigest[],
  scope: PeriodScope,
): ToolUseDigest {
  const perConversation: ToolUseDigest['perConversation'] = []
  for (const conv of conversations) {
    const counts = countToolUses(store, conv.id, scope)
    if (counts.total === 0) continue
    perConversation.push({ conversationId: conv.id, perTool: counts.perTool, total: counts.total })
  }
  return { perConversation }
}

function countToolUses(store: StoreDriver, id: string, scope: PeriodScope) {
  const entries = store.transcripts.find(id, {
    after: scope.periodStart,
    before: scope.periodEnd,
    types: ['assistant'],
    limit: 5_000,
  })
  const counter = new Map<string, number>()
  let total = 0
  for (const e of entries) {
    const tools = extractToolNames(e)
    for (const name of tools) {
      counter.set(name, (counter.get(name) ?? 0) + 1)
      total++
    }
  }
  const perTool = Array.from(counter.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
  return { perTool, total }
}

function extractToolNames(entry: TranscriptEntryRecord): string[] {
  const message = (entry.content as { message?: { content?: unknown } }).message
  const blocks = message?.content
  if (!Array.isArray(blocks)) return []
  return blocks.filter((b): b is { type: 'tool_use'; name: string } => isToolUseBlock(b)).map(b => b.name)
}

function isToolUseBlock(b: unknown): boolean {
  return typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_use'
}
