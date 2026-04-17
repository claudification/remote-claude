/**
 * Derive a human-readable session label from spawn request hints.
 *
 * Order of preference:
 *   1. explicit `req.name`
 *   2. `task.title`
 *   3. first non-empty line of `req.prompt`
 *
 * Returns `null` when no hint is available -- callers should fall back to
 * the random generator in `./session-names`.
 */

import type { TaskMeta } from './spawn-prompt'
import type { SpawnRequest } from './spawn-schema'

const MAX_NAME_LEN = 60

/** Strip quotes, collapse whitespace, trim, slice to {@link MAX_NAME_LEN}. */
export function sanitizeSessionName(raw: string): string {
  return raw.replace(/['"]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN)
}

export function deriveSessionName(req: Partial<SpawnRequest>, task?: TaskMeta): string | null {
  if (req.name) {
    const n = sanitizeSessionName(req.name)
    if (n) return n
  }
  if (task?.title) {
    const n = sanitizeSessionName(task.title)
    if (n) return n
  }
  if (req.prompt) {
    const firstLine = req.prompt.split('\n').find(l => l.trim().length > 0)
    if (firstLine) {
      const n = sanitizeSessionName(firstLine)
      if (n) return n
    }
  }
  return null
}
