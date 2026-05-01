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
export function sanitizeConversationName(raw: string): string {
  return raw.replace(/['"]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN)
}

/** Validate an explicit session name. Returns an error string or null if valid. */
export function validateSessionName(name: string, existingNames: Set<string>): string | null {
  const sanitized = sanitizeConversationName(name)
  if (!sanitized) return 'Session name is empty after sanitization'
  if (existingNames.has(sanitized)) return `Session name "${sanitized}" is already in use`
  return null
}

export function deriveConversationName(req: Partial<SpawnRequest>, task?: TaskMeta): string | null {
  if (req.name) {
    const n = sanitizeConversationName(req.name)
    if (n) return n
  }
  if (task?.title) {
    const n = sanitizeConversationName(task.title)
    if (n) return n
  }
  if (req.prompt) {
    const firstLine = req.prompt.split('\n').find(l => l.trim().length > 0)
    if (firstLine) {
      const n = sanitizeConversationName(firstLine)
      if (n) return n
    }
  }
  return null
}
