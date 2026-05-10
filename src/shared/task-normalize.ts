import type { TodoTaskStatus } from './protocol'

/**
 * Map free-text todo status values from any agent host (CC TodoWrite, opencode
 * NDJSON, ACP) to the strict `TodoTaskStatus` enum the broker accepts. Unknown
 * values coerce to 'pending' so the wire boundary is the only place statuses
 * are normalized.
 */
const TODO_STATUS_ALIASES: Record<string, TodoTaskStatus> = {
  pending: 'pending',
  open: 'pending',
  todo: 'pending',
  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  inprogress: 'in_progress',
  working: 'in_progress',
  working_on: 'in_progress',
  active: 'in_progress',
  completed: 'completed',
  complete: 'completed',
  done: 'completed',
  finished: 'completed',
  deleted: 'deleted',
  removed: 'deleted',
  cancelled: 'deleted',
  canceled: 'deleted',
}

export function normalizeTodoStatus(raw: unknown): TodoTaskStatus {
  if (typeof raw !== 'string') return 'pending'
  const key = raw.trim().toLowerCase()
  const mapped = TODO_STATUS_ALIASES[key]
  if (mapped) return mapped
  return 'pending'
}
