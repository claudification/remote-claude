import { Fzf } from 'fzf'
import type { ProjectTaskMeta } from '@/hooks/use-project'

/** Build the <project-task> prompt sent to CC. Re-exported from shared for single-source consistency. */
export { buildTaskPrompt, type TaskMeta } from '@shared/spawn-prompt'

export function statusBoost(status: string): number {
  return status === 'in-progress' ? 1.5 : status === 'open' ? 1.3 : 1
}

/** Fuzzy-match and sort project tasks by relevance + status weight. Returns all tasks sorted by status when query is empty. */
export function scoreAndSortTasks(tasks: ProjectTaskMeta[], query: string): ProjectTaskMeta[] {
  if (!query) {
    return [...tasks].sort((a, b) => statusBoost(b.status) - statusBoost(a.status))
  }

  const fzf = new Fzf(tasks, {
    selector: (t: ProjectTaskMeta) => `${t.title} ${t.slug} ${t.status} ${t.priority || ''}`,
    casing: 'case-insensitive',
  })

  return fzf
    .find(query)
    .sort((a, b) => b.score * statusBoost(b.item.status) - a.score * statusBoost(a.item.status))
    .map(r => r.item)
}
