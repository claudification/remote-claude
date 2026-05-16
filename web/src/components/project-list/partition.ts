import type { Conversation } from '@/lib/types'

/** Walks conversations once and returns three overlapping views:
 *  - adhoc / normal: mutually exclusive, routed by ad-hoc capability
 *  - ended: status-based view, overlaps with both (so DismissAllEndedButton
 *    sees the same conversations rendered in either list) */
export function partitionConversations(conversations: Conversation[]) {
  const adhoc: Conversation[] = []
  const normal: Conversation[] = []
  const ended: Conversation[] = []
  for (const s of conversations) {
    if (s.status === 'ended') ended.push(s)
    if (s.capabilities?.includes('ad-hoc')) adhoc.push(s)
    else normal.push(s)
  }
  return { adhoc, normal, ended }
}
