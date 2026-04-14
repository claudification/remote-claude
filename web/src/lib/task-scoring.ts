import { Fzf } from 'fzf'
import type { ProjectTaskMeta } from '@/hooks/use-project'

/** Build the <project-task> prompt sent to CC when "Work on this" / /workon is used. */
export function buildTaskPrompt(
  task: {
    slug: string
    title: string
    status: string
    priority?: string
    tags: string[]
    bodyPreview?: string
    body?: string
  },
  extraInstructions?: string,
): string {
  const tagAttrs = [
    `id="${task.slug}"`,
    `title="${task.title.replace(/"/g, '&quot;')}"`,
    task.priority && task.priority !== 'medium' ? `priority="${task.priority}"` : '',
    `status="${task.status}"`,
    task.tags.length ? `tags="${task.tags.join(',')}"` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const content = (task.body ?? task.bodyPreview ?? task.title).trim() || task.title
  const instructions = `Set status to in-progress when you start, in-review when complete. Use mcp__rclaude__project_set_status with id="${task.slug}".`
  return `<project-task ${tagAttrs}>\n${content}\n\n${instructions}${extraInstructions || ''}\n</project-task>`
}

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
