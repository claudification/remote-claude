/**
 * Canonical prompt assembly for spawn requests.
 *
 * Used by:
 * - Dashboard RunTaskDialog (web/src/components/project-board.tsx)
 * - web/src/lib/task-scoring.ts (re-exports buildTaskPrompt)
 * - Agent Host /workon slash command (when applicable)
 *
 * Single source of truth for:
 * - AUTO_COMMIT_INSTRUCTIONS (auto-commit suffix)
 * - WORKTREE_MERGEBACK_INSTRUCTIONS (worktree merge-back suffix)
 * - <project-task> agent host format
 */

export type TaskMeta = {
  slug: string
  title: string
  status: string
  priority?: string
  tags: string[]
  bodyPreview?: string
  body?: string
}

export const AUTO_COMMIT_INSTRUCTIONS = '\n\nWhen you are done, commit all changes with a descriptive commit message.'

export const WORKTREE_MERGEBACK_INSTRUCTIONS =
  '\n\nIMPORTANT - WORKTREE MERGE-BACK:\nYou are working in a git worktree (isolated branch). Before finishing:\n1. Commit all changes\n2. Merge back to main: run `git rebase main && git fetch . HEAD:main`\n3. If rebase conflicts occur, resolve them and run `git rebase --continue`, then `git fetch . HEAD:main`\n4. Verify: `git log --oneline main -5`\nThis merges your work back to main so it is not stranded on a dead branch.'

export type PromptOptions = {
  autoCommit?: boolean
  worktreeMergeBack?: boolean
  taskWrapper?: TaskMeta
}

/**
 * Wrap a base prompt with optional task agent host and lifecycle suffixes.
 * Order: taskWrapper(base + suffixes) OR base + suffixes.
 */
export function composeSpawnPrompt(basePrompt: string, opts: PromptOptions = {}): string {
  const suffixes =
    (opts.autoCommit ? AUTO_COMMIT_INSTRUCTIONS : '') + (opts.worktreeMergeBack ? WORKTREE_MERGEBACK_INSTRUCTIONS : '')
  if (opts.taskWrapper) {
    return buildTaskPrompt(opts.taskWrapper, suffixes || undefined, basePrompt || undefined)
  }
  return basePrompt + suffixes
}

/**
 * Build a <project-task> wrapped prompt. Canonical source for both the
 * dashboard task runner and the /workon slash command.
 *
 * If `basePrompt` is provided (non-empty), it overrides the task body content.
 */
export function buildTaskPrompt(task: TaskMeta, extraInstructions?: string, basePrompt?: string): string {
  const tagAttrs = [
    `id="${task.slug}"`,
    `title="${task.title.replace(/"/g, '&quot;')}"`,
    task.priority && task.priority !== 'medium' ? `priority="${task.priority}"` : '',
    `status="${task.status}"`,
    task.tags.length ? `tags="${task.tags.join(',')}"` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const content = (basePrompt ?? task.body ?? task.bodyPreview ?? task.title).trim() || task.title
  const instructions = `Set status to in-progress when you start, in-review when complete. Use mcp__rclaude__project_set_status with id="${task.slug}".`
  return `<project-task ${tagAttrs}>\n${content}\n\n${instructions}${extraInstructions || ''}\n</project-task>`
}
