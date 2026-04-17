/**
 * Resolve the effective context window (in tokens) for a Claude Code session.
 *
 * Priority:
 *   1. Explicit context mode parsed from /model or /context stdout (authoritative).
 *   2. Variant suffix on the model id (`-1m` / `[1m]`) -- explicit 1M opt-in.
 *   3. Known default-1M models (Opus 4.7+).
 *   4. Fallback: Claude Code's 200K default.
 */
export function resolveContextWindow(model: string | undefined, contextMode?: '1m' | 'standard'): number {
  if (contextMode === '1m') return 1_000_000
  if (contextMode === 'standard') return 200_000
  if (!model) return 200_000
  if (/(-1m|\[1m\])/i.test(model)) return 1_000_000
  if (isDefault1MModel(model)) return 1_000_000
  return 200_000
}

/** Derive context mode from a model string (e.g. launch config model).
 * Returns '1m' if the model has a 1M variant suffix or is a default-1M model. */
export function contextModeFromModel(model: string | undefined): '1m' | undefined {
  if (!model) return undefined
  if (/(-1m|\[1m\])/i.test(model)) return '1m'
  if (isDefault1MModel(model)) return '1m'
  return undefined
}

/** Models whose 1M context window is the DEFAULT, not an opt-in variant. */
function isDefault1MModel(model: string): boolean {
  // Opus 4.7 ships with 1M context by default. Older Opus/Sonnet/Haiku 4.x
  // still default to 200K and require an explicit `[1m]` / `-1m` opt-in.
  return /^claude-opus-4-7(\b|[^0-9])/i.test(model)
}
