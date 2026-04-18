import type { Session } from '@/lib/types'

/** Walks sessions once and returns three overlapping views:
 *  - adhoc / normal: mutually exclusive, routed by ad-hoc capability
 *  - ended: status-based view, overlaps with both (so DismissAllEndedButton
 *    sees the same sessions rendered in either list) */
export function partitionSessions(sessions: Session[]) {
  const adhoc: Session[] = []
  const normal: Session[] = []
  const ended: Session[] = []
  for (const s of sessions) {
    if (s.status === 'ended') ended.push(s)
    if (s.capabilities?.includes('ad-hoc')) adhoc.push(s)
    else normal.push(s)
  }
  return { adhoc, normal, ended }
}
