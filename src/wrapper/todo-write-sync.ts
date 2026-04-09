/**
 * TodoWrite Interceptor - Syncs Claude Code's TodoWrite tool calls to rclaude kanban tasks
 *
 * Scans transcript entries for assistant messages containing TodoWrite tool_use blocks,
 * extracts the todos array, and creates/updates/moves task note files accordingly.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TranscriptAssistantEntry, TranscriptEntry } from '../shared/protocol'
import type { TaskStatus } from './task-notes'

interface TodoItem {
  id?: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority?: 'high' | 'medium' | 'low'
}

const STATUS_MAP: Record<string, TaskStatus> = {
  pending: 'open',
  in_progress: 'in-progress',
  completed: 'done',
}

const STATUSES: TaskStatus[] = ['open', 'in-progress', 'done', 'archived']

function tasksRoot(cwd: string): string {
  return join(cwd, '.claude', '.rclaude', 'tasks')
}

function statusDir(cwd: string, status: TaskStatus): string {
  const d = join(tasksRoot(cwd), status)
  mkdirSync(d, { recursive: true })
  return d
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || `task-${Date.now()}`
  )
}

function toMarkdown(title: string, body: string, priority: string, created: string): string {
  const lines = ['---']
  lines.push(`title: ${title}`)
  lines.push(`priority: ${priority}`)
  lines.push(`created: ${created}`)
  lines.push(`source: TodoWrite`)
  lines.push('---')
  lines.push('')
  lines.push(body)
  return lines.join('\n')
}

/** Find an existing task file by matching its title across all status directories */
function findExistingTask(cwd: string, title: string): { status: TaskStatus; slug: string } | null {
  for (const status of STATUSES) {
    const dir = join(tasksRoot(cwd), status)
    if (!existsSync(dir)) continue
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.md')) continue
        const content = readFileSync(join(dir, file), 'utf8')
        const titleMatch = content.match(/^title:\s*(.+)$/m)
        if (titleMatch && titleMatch[1].trim() === title) {
          return { status, slug: file.replace(/\.md$/, '') }
        }
      }
    } catch {
      // directory read failed, skip
    }
  }
  return null
}

function dedupSlug(dir: string, base: string): string {
  if (!existsSync(join(dir, `${base}.md`))) return base
  for (let i = 2; i < 100; i++) {
    if (!existsSync(join(dir, `${base}-${i}.md`))) return `${base}-${i}`
  }
  return `${base}-${Date.now()}`
}

/**
 * Process a single TodoWrite tool call's todos array.
 * Creates new tasks or updates existing ones (moves between status dirs).
 */
function syncTodos(cwd: string, todos: TodoItem[], debugFn?: (msg: string) => void): void {
  for (const todo of todos) {
    if (!todo.content) continue

    const title = todo.content.length > 120 ? `${todo.content.slice(0, 117)}...` : todo.content
    const targetStatus = STATUS_MAP[todo.status] || 'open'
    const priority = todo.priority || 'medium'

    const existing = findExistingTask(cwd, title)

    if (existing) {
      // Task exists - move if status changed
      if (existing.status !== targetStatus) {
        const fromDir = statusDir(cwd, existing.status)
        const toDir = statusDir(cwd, targetStatus)
        const filename = `${existing.slug}.md`
        try {
          renameSync(join(fromDir, filename), join(toDir, filename))
          debugFn?.(`TodoWrite: moved task "${existing.slug}" from ${existing.status} to ${targetStatus}`)
        } catch (err) {
          debugFn?.(`TodoWrite: failed to move task "${existing.slug}": ${err}`)
        }
      }
    } else {
      // New task - create it
      const dir = statusDir(cwd, targetStatus)
      const slug = dedupSlug(dir, slugify(title))
      const content = toMarkdown(title, todo.content, priority, new Date().toISOString())
      try {
        writeFileSync(join(dir, `${slug}.md`), content, 'utf8')
        debugFn?.(`TodoWrite: created task "${slug}" in ${targetStatus}`)
      } catch (err) {
        debugFn?.(`TodoWrite: failed to create task "${slug}": ${err}`)
      }
    }
  }
}

/**
 * Scan transcript entries for TodoWrite tool_use blocks and sync them to kanban tasks.
 * Call this from sendTranscriptEntriesChunked before forwarding to concentrator.
 */
export function interceptTodoWrite(entries: TranscriptEntry[], cwd: string, debugFn?: (msg: string) => void): void {
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    const assistant = entry as TranscriptAssistantEntry
    if (!assistant.message?.content) continue

    for (const block of assistant.message.content) {
      if (block.type !== 'tool_use' || block.name !== 'TodoWrite') continue
      const input = block.input as { todos?: TodoItem[] } | undefined
      if (!input?.todos || !Array.isArray(input.todos)) continue

      debugFn?.(`TodoWrite intercepted: ${input.todos.length} todo(s)`)
      syncTodos(cwd, input.todos, debugFn)
    }
  }
}
