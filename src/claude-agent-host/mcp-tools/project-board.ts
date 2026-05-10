import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_VISIBLE_STATUSES, TASK_STATUSES, type TaskStatus } from '../../shared/task-statuses'
import { debug } from '../debug'
import { moveProjectTask } from '../project-tasks'
import type { McpToolContext, ToolDef } from './types'

function formatStatus(s: string): string {
  return s
    .split('-')
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join('-')
}

export function registerProjectBoardTools(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    project_list: {
      description:
        'List tasks from the project board (.rclaude/project/). Returns tasks grouped by status with their frontmatter (title, priority, tags, refs) and relative file paths. By default shows open + in-progress only. To edit tasks, read/write the markdown files directly. To change status, mv the file between status folders.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: [...TASK_STATUSES, 'all'],
            description: `Filter by status folder. Default: all (${DEFAULT_VISIBLE_STATUSES.join(' + ')})`,
          },
          show_done: {
            type: 'boolean',
            description: 'Include done tasks when status is "all" (default: false)',
          },
          show_archived: {
            type: 'boolean',
            description: 'Include archived tasks when status is "all" (default: false)',
          },
          filter: {
            type: 'string',
            description:
              'Filter tasks by glob pattern (matched against title, filename, and tags). Case-insensitive. Examples: "bug*", "*refactor*", "*sqlite*". Wrap in /slashes/ for regex.',
          },
        },
      },
      async handle(params) {
        return handleProjectList(ctx, params)
      },
    },

    project_set_status: {
      description:
        'Move a project task to a different status column on the board. Use the filename (without .md) as the task ID. Avoids needing Bash mv which triggers permission prompts.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: {
            type: 'string',
            description: 'Task filename without .md extension (e.g. "my-task" or "bug-conduit-session")',
          },
          status: {
            type: 'string',
            enum: [...TASK_STATUSES],
            description: 'Target status folder',
          },
        },
        required: ['id', 'status'],
      },
      async handle(params) {
        return handleProjectSetStatus(ctx, params)
      },
    },
  }
}

function handleProjectList(ctx: McpToolContext, params: Record<string, string>) {
  const statusFilter = params.status || 'all'
  let statuses: string[]
  if (statusFilter === 'all') {
    statuses = [...DEFAULT_VISIBLE_STATUSES]
    if (String(params.show_done) === 'true') statuses.push('done')
    if (String(params.show_archived) === 'true') statuses.push('archived')
  } else {
    statuses = [statusFilter]
  }

  let filterRe: RegExp | null = null
  if (params.filter) {
    const f = params.filter
    const regexMatch = f.match(/^\/(.+)\/([gimsuy]*)$/)
    if (regexMatch) {
      filterRe = new RegExp(regexMatch[1], regexMatch[2] || 'i')
    } else {
      const escaped = f.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
      filterRe = new RegExp(escaped, 'i')
    }
  }

  const dialogCwd = ctx.getDialogCwd()
  const projectDir = join(dialogCwd, '.rclaude', 'project')
  const results: string[] = []
  for (const status of statuses) {
    const dir = join(projectDir, status)
    try {
      const files = readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .map(f => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      for (const { name: file } of files) {
        try {
          const content = readFileSync(join(dir, file), 'utf-8')
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
          const fm = fmMatch ? fmMatch[1] : ''

          if (filterRe) {
            const titleMatch = fm.match(/title:\s*["']?(.+?)["']?\s*$/m)
            const title = titleMatch ? titleMatch[1] : ''
            const tagsMatch = fm.match(/tags:\s*\[([^\]]*)\]/m)
            const tags = tagsMatch ? tagsMatch[1] : ''
            const searchable = `${file} ${title} ${tags}`
            if (!filterRe.test(searchable)) continue
          }

          const relPath = `.rclaude/project/${status}/${file}`
          results.push(`## ${relPath}\n${fm}`)
        } catch {
          /* skip unreadable */
        }
      }
    } catch {
      /* dir doesn't exist yet */
    }
  }
  const output =
    results.length > 0
      ? results.join('\n\n')
      : params.filter
        ? `No tasks matching "${params.filter}". Try a broader pattern.`
        : 'No tasks found. Create one with: Write .rclaude/project/open/my-task.md'
  debug(
    `[channel] project_list: ${results.length} tasks (filter=${statusFilter}${params.filter ? `, pattern=${params.filter}` : ''})`,
  )
  return { content: [{ type: 'text', text: output }] }
}

function handleProjectSetStatus(ctx: McpToolContext, params: Record<string, string>) {
  const taskId = params.id
  const targetStatus = params.status as TaskStatus
  if (!taskId) return { content: [{ type: 'text', text: 'Error: id is required' }], isError: true }
  if (!(TASK_STATUSES as readonly string[]).includes(targetStatus))
    return { content: [{ type: 'text', text: `Error: invalid status "${targetStatus}"` }], isError: true }

  const dialogCwd = ctx.getDialogCwd()
  const allStatuses = TASK_STATUSES
  let fromStatus: TaskStatus | null = null
  for (const s of allStatuses) {
    const dir = join(dialogCwd, '.rclaude', 'project', s)
    try {
      if (readdirSync(dir).includes(`${taskId}.md`)) {
        fromStatus = s
        break
      }
    } catch {}
  }
  if (!fromStatus) return { content: [{ type: 'text', text: `Task "${taskId}" not found` }], isError: true }
  if (fromStatus === targetStatus)
    return { content: [{ type: 'text', text: `"${taskId}" is already ${formatStatus(targetStatus)}` }] }

  let taskTitle = taskId
  try {
    const raw = readFileSync(join(dialogCwd, '.rclaude', 'project', fromStatus, `${taskId}.md`), 'utf-8')
    const titleMatch = raw.match(/^title:\s*(.+)$/m)
    if (titleMatch?.[1]) taskTitle = titleMatch[1].trim()
  } catch {}

  const newSlug = moveProjectTask(dialogCwd, taskId, fromStatus, targetStatus)
  if (!newSlug) return { content: [{ type: 'text', text: 'Failed to move task' }], isError: true }
  ctx.callbacks.onProjectChanged?.()
  debug(`[channel] set_task_status: ${taskId} ${fromStatus} -> ${targetStatus} (slug: ${newSlug})`)
  const newPath = `.rclaude/project/${targetStatus}/${newSlug}.md`
  const renamed = newSlug !== taskId ? ` (renamed to "${newSlug}")` : ''
  return {
    content: [
      {
        type: 'text',
        text: `Moved "${taskTitle}" from ${formatStatus(fromStatus)} to ${formatStatus(targetStatus)}${renamed}\nThe task file is now located at ${newPath}`,
      },
    ],
  }
}
