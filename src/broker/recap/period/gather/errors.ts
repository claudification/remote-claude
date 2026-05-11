import type { StoreDriver } from '../../../store/types'
import type { ConversationDigest, ErrorDigest, PeriodScope } from './types'

const ERROR_SUBTYPES = new Set([
  'hook_failure',
  'spawn_error',
  'agent_disconnect',
  'launch_failed',
  'chat_api_error',
  'tool_error',
])

// fallow-ignore-next-line complexity
export function gatherErrors(store: StoreDriver, conversations: ConversationDigest[], scope: PeriodScope): ErrorDigest {
  const incidents: ErrorDigest['incidents'] = []
  for (const conv of conversations) {
    const entries = store.transcripts.find(conv.id, {
      after: scope.periodStart,
      before: scope.periodEnd,
      types: ['system'],
      limit: 1_000,
    })
    for (const e of entries) {
      const subtype = e.subtype ?? ''
      if (!ERROR_SUBTYPES.has(subtype)) continue
      incidents.push({
        conversationId: conv.id,
        timestamp: e.timestamp,
        subtype,
        summary: summarise(e.content),
      })
    }
  }
  incidents.sort((a, b) => a.timestamp - b.timestamp)
  return { incidents }
}

function summarise(content: Record<string, unknown>): string {
  const text = typeof content.text === 'string' ? content.text : JSON.stringify(content)
  return text.slice(0, 240)
}
