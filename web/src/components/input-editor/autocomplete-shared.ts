/**
 * Shared autocomplete primitives used by both backends.
 *
 * Keep this small and pure -- no React, no DOM, no CM imports. Anything
 * specific to a backend (popover positioning, key handling, replacement
 * dispatch) lives in that backend.
 */

import { COMPLETER_MODEL_IDS } from '@shared/models'

/** Substring-match completer for `/model <query>` — shared by both backends. */
export function completeModelArg(query: string): string[] {
  const q = query.toLowerCase()
  return COMPLETER_MODEL_IDS.filter(m => !q || m.toLowerCase().includes(q))
}

/**
 * fzf-inspired fuzzy scorer. Returns 0 if `candidate` doesn't contain
 * all of `query`'s chars in order; otherwise a positive score (higher =
 * better match) with bonuses for:
 *   - exact prefix match (whole query at start of candidate)
 *   - matches at word boundaries (start of word, after - or _)
 *   - consecutive matches (no gap between matched chars)
 *   - early matches (closer to start of candidate)
 *
 * No penalty for length -- we already cap results to the top N elsewhere,
 * so length-penalising would over-prefer short noisy matches.
 */
export function fuzzyScore(query: string, candidate: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const c = candidate.toLowerCase()

  // Cheap fast-paths
  if (c === q) return 1000
  if (c.startsWith(q)) return 500 + (candidate.length - q.length === 0 ? 0 : 100)

  let score = 0
  let qi = 0
  let lastMatch = -2 // -2 so the first matched char never registers as "consecutive"
  let inGap = false

  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] !== q[qi]) {
      inGap = true
      continue
    }
    let charScore = 1
    // Word-boundary bonus: start of string or preceded by separator
    if (ci === 0 || /[-_/\s.]/.test(c[ci - 1])) charScore += 8
    // Consecutive-match bonus: prior matched char was right next door
    if (ci === lastMatch + 1) charScore += 5
    // Early-match bonus (small): rewards left-anchored matches
    if (!inGap) charScore += 1
    score += charScore
    lastMatch = ci
    inGap = false
    qi++
  }
  return qi === q.length ? score : 0
}

/** Multiplicative boost applied to builtin commands so they sort above CC's slashCommands at parity. */
export const BUILTIN_SCORE_BOOST = 1.3

/**
 * Names of builtin slash commands the agent host handles itself
 * (independent of CC's reported slashCommands list).
 *
 * Source of truth lives in markdown-input.tsx's SUB_COMMANDS registry --
 * keep these in sync. Only the names are shared; the per-command logic
 * (completers, onSelect callbacks) stays in legacy until Phase 2c.
 */
export const BUILTIN_COMMAND_NAMES = [
  'model',
  'workon',
  'effort',
  'mode',
  'plan',
  'clear',
  'exit',
  'compact',
  'settings',
  'config',
  'project',
  'session',
  'rename',
] as const
