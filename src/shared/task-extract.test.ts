import { describe, expect, it } from 'bun:test'
import type { TranscriptEntry } from './protocol'
import { extractTodoTasksFromEntries } from './task-extract'

function assistantWithBlock(block: Record<string, unknown>): TranscriptEntry {
  return {
    type: 'assistant',
    uuid: 'u',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [block] },
  } as TranscriptEntry
}

describe('extractTodoTasksFromEntries', () => {
  it('returns null when no entries', () => {
    expect(extractTodoTasksFromEntries([])).toBeNull()
  })

  it('returns null for non-todo tool_use blocks', () => {
    const entry = assistantWithBlock({
      type: 'tool_use',
      kind: 'shell.exec',
      canonicalInput: { command: 'ls' },
    })
    expect(extractTodoTasksFromEntries([entry])).toBeNull()
  })

  it('extracts canonical todo.write block (Claude/ACP shape with activeForm)', () => {
    const entry = assistantWithBlock({
      type: 'tool_use',
      kind: 'todo.write',
      canonicalInput: {
        todos: [
          { content: 'Do thing', status: 'in_progress', activeForm: 'Doing thing' },
          { content: 'Done thing', status: 'completed' },
        ],
      },
    })
    const tasks = extractTodoTasksFromEntries([entry])
    expect(tasks).not.toBeNull()
    expect(tasks).toHaveLength(2)
    expect(tasks?.[0]).toMatchObject({
      id: 'todo-0',
      subject: 'Do thing',
      description: 'Doing thing',
      status: 'in_progress',
      kind: 'todo',
    })
    expect(tasks?.[1]).toMatchObject({ id: 'todo-1', subject: 'Done thing', status: 'completed' })
  })

  it('extracts opencode shape (no activeForm, has priority)', () => {
    const entry = assistantWithBlock({
      type: 'tool_use',
      kind: 'todo.write',
      canonicalInput: {
        todos: [{ content: 'Refactor', status: 'pending', priority: 2 }],
      },
    })
    const tasks = extractTodoTasksFromEntries([entry])
    expect(tasks?.[0]).toMatchObject({
      subject: 'Refactor',
      status: 'pending',
      priority: 2,
      kind: 'todo',
    })
    expect(tasks?.[0].description).toBeUndefined()
  })

  it('falls back to legacy block.input when canonicalInput is missing', () => {
    const entry = assistantWithBlock({
      type: 'tool_use',
      kind: 'todo.write',
      input: { todos: [{ content: 'A', status: 'completed' }] },
    })
    const tasks = extractTodoTasksFromEntries([entry])
    expect(tasks?.[0].subject).toBe('A')
    expect(tasks?.[0].status).toBe('completed')
  })

  it('coerces unknown status to pending', () => {
    const entry = assistantWithBlock({
      type: 'tool_use',
      kind: 'todo.write',
      canonicalInput: { todos: [{ content: 'X', status: 'weird-state' }] },
    })
    const tasks = extractTodoTasksFromEntries([entry])
    expect(tasks?.[0].status).toBe('pending')
  })

  it('returns empty array when todos array is empty (still emits tasks_update to clear list)', () => {
    const entry = assistantWithBlock({
      type: 'tool_use',
      kind: 'todo.write',
      canonicalInput: { todos: [] },
    })
    const tasks = extractTodoTasksFromEntries([entry])
    expect(tasks).toEqual([])
  })

  it('uses the most recent todo.write block if multiple in one batch', () => {
    const e1 = assistantWithBlock({
      type: 'tool_use',
      kind: 'todo.write',
      canonicalInput: { todos: [{ content: 'first', status: 'pending' }] },
    })
    const e2 = assistantWithBlock({
      type: 'tool_use',
      kind: 'todo.write',
      canonicalInput: { todos: [{ content: 'second', status: 'in_progress' }] },
    })
    const tasks = extractTodoTasksFromEntries([e1, e2])
    expect(tasks).toHaveLength(1)
    expect(tasks?.[0].subject).toBe('second')
  })
})
