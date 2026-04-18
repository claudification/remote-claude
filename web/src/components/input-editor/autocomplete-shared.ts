/**
 * Shared autocomplete primitives used by both backends.
 *
 * Keep this small and pure -- no React, no DOM, no CM imports. Anything
 * specific to a backend (popover positioning, key handling, replacement
 * dispatch) lives in that backend.
 */

/**
 * Subsequence-match scorer. Returns 0 if `candidate` doesn't contain all of
 * `query`'s chars in order, otherwise a positive score (higher = better match,
 * with bonus for matches at the start).
 */
export function fuzzyScore(query: string, candidate: string): number {
  if (!query) return 1
  const c = candidate.toLowerCase()
  let qi = 0
  let score = 0
  for (let ci = 0; ci < c.length && qi < query.length; ci++) {
    if (c[ci] === query[qi]) {
      score += ci === qi ? 3 : 1
      qi++
    }
  }
  return qi === query.length ? score : 0
}

/**
 * Names of builtin slash commands the wrapper handles itself
 * (independent of CC's reported slashCommands list).
 *
 * Source of truth lives in markdown-input.tsx's SUB_COMMANDS registry --
 * keep these in sync. Only the names are shared; the per-command logic
 * (completers, onSelect callbacks) stays in legacy until Phase 2c.
 */
export const BUILTIN_COMMAND_NAMES = ['model', 'workon', 'clear', 'exit', 'compact', 'settings', 'config'] as const
