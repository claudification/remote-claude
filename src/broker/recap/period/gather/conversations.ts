import type { StoreDriver } from '../../../store/types'
import type { ConversationDigest, PeriodScope } from './types'

// fallow-ignore-next-line complexity
export function gatherConversations(store: StoreDriver, scope: PeriodScope): ConversationDigest[] {
  const out: ConversationDigest[] = []
  for (const projectUri of scope.projectUris) {
    const summaries = store.conversations.listByScope(projectUri)
    for (const s of summaries) {
      const created = (s as { createdAt?: number }).createdAt ?? 0
      const updated = (s as { lastActivity?: number }).lastActivity ?? created
      const inWindow =
        (created >= scope.periodStart && created <= scope.periodEnd) ||
        (updated >= scope.periodStart && updated <= scope.periodEnd)
      if (!inWindow) continue
      out.push({
        id: s.id,
        title: (s as { title?: string }).title ?? '',
        projectUri,
        status: s.status,
        createdAt: created,
        updatedAt: updated,
        turnCount: (s as { stats?: { turns?: number } }).stats?.turns ?? 0,
      })
    }
  }
  out.sort((a, b) => a.createdAt - b.createdAt)
  return out
}
