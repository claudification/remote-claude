/**
 * Extract canonical TodoWrite blocks from transcript entries and synthesize
 * a TaskInfo[] for the broker's `tasks_update` side-channel.
 *
 * Used by the opencode and ACP agent hosts: both translate their backend's
 * TodoWrite tool into a canonical `kind === 'todo.write'` block before the
 * entry hits the wire, so a single shared scanner works for both. The Claude
 * agent host has its own raw-name interceptor (transcript-manager.ts) because
 * Claude's headless stream skips the canonical translator step.
 *
 * Returns null when no TodoWrite block was seen (no message to send).
 */

import type { TaskInfo, TranscriptEntry } from './protocol'
import { normalizeTodoStatus } from './task-normalize'

interface RawTodo {
  content?: unknown
  status?: unknown
  activeForm?: unknown
  priority?: unknown
}

export function extractTodoTasksFromEntries(entries: TranscriptEntry[]): TaskInfo[] | null {
  let tasks: TaskInfo[] | null = null
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    const msg = (entry as Record<string, unknown>).message as Record<string, unknown> | undefined
    const content = msg?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type !== 'tool_use') continue
      if (block.kind !== 'todo.write') continue
      const input = (block.canonicalInput ?? block.input) as { todos?: unknown } | undefined
      const todos = Array.isArray(input?.todos) ? (input.todos as RawTodo[]) : []
      const now = Date.now()
      tasks = todos.map((todo, i) => {
        const info: TaskInfo = {
          id: `todo-${i}`,
          subject: typeof todo.content === 'string' ? todo.content : '',
          status: normalizeTodoStatus(todo.status),
          kind: 'todo',
          updatedAt: now,
        }
        if (typeof todo.activeForm === 'string') info.description = todo.activeForm
        if (typeof todo.priority === 'number') info.priority = todo.priority
        return info
      })
    }
  }
  return tasks
}
