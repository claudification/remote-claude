import type { StoreDriver, TaskRecord } from '../../../store/types'
import type { ConversationDigest, PeriodScope, TaskDigest } from './types'

export function gatherTasks(store: StoreDriver, conversations: ConversationDigest[], scope: PeriodScope): TaskDigest {
  const doneInPeriod: TaskDigest['doneInPeriod'] = []
  const createdInPeriod: TaskDigest['createdInPeriod'] = []
  const inProgress: TaskDigest['inProgress'] = []
  for (const conv of conversations) {
    const tasks = store.tasks.getForConversation(conv.id)
    for (const t of tasks) classify(t, conv.id, scope, { doneInPeriod, createdInPeriod, inProgress })
  }
  return { doneInPeriod, createdInPeriod, inProgress }
}

// fallow-ignore-next-line complexity
function classify(t: TaskRecord, conversationId: string, scope: PeriodScope, buckets: TaskDigest) {
  const created = t.createdAt ?? 0
  const updated = t.updatedAt ?? created
  const completed = t.completedAt ?? null
  const inWindow = (ts: number | null) => ts != null && ts >= scope.periodStart && ts <= scope.periodEnd
  const name = t.name ?? t.id
  if (t.status === 'in_progress') {
    buckets.inProgress.push({ id: t.id, conversationId, name })
  }
  if (t.status === 'done' && (inWindow(completed) || inWindow(updated))) {
    buckets.doneInPeriod.push({ id: t.id, conversationId, name, updatedAt: completed ?? updated })
  }
  if (inWindow(created)) {
    buckets.createdInPeriod.push({
      id: t.id,
      conversationId,
      name,
      createdAt: created,
      status: t.status,
    })
  }
}
