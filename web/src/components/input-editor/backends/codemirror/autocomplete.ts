/**
 * CM6 autocomplete for slash commands and @ mentions.
 *
 * Triggers:
 *   - `/` at start of doc OR after whitespace -> builtin commands + CC's slashCommands
 *   - `@` at start of doc OR after whitespace -> skills + agents
 *
 * Source data is read live from the sessions store at completion time, so the
 * extension doesn't need rebuilding when sessionInfo changes.
 *
 * Phase 2b scope: name-only completion. Sub-command argument completers
 * (e.g. /workon <task>, /model <variant>) stay legacy-only for now.
 */

import {
  acceptCompletion,
  autocompletion,
  type CompletionContext,
  type CompletionResult,
  completionStatus,
} from '@codemirror/autocomplete'
import { type Extension, Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { useSessionsStore } from '@/hooks/use-sessions'
import { BUILTIN_COMMAND_NAMES, BUILTIN_SCORE_BOOST, fuzzyScore } from '../../autocomplete-shared'

interface SourceInfo {
  slashCommands: string[]
  skills: string[]
  agents: string[]
}

const EMPTY_INFO: SourceInfo = { slashCommands: [], skills: [], agents: [] }

function readSourceInfo(): SourceInfo {
  const state = useSessionsStore.getState()
  const sid = state.selectedSessionId
  return (sid ? state.sessionInfo[sid] : null) ?? EMPTY_INFO
}

function isInsideCodeFence(text: string): boolean {
  if ((text.match(/`/g) || []).length % 2 !== 0) return true
  if (text.includes('```') && (text.match(/```/g) || []).length % 2 !== 0) return true
  return false
}

function buildCompletions(trigger: '/' | '@', query: string, atDocStart: boolean, info: SourceInfo) {
  const scored: Array<{ label: string; detail?: string; score: number }> = []

  function add(name: string, detail: string | undefined, boost = 1) {
    const s = fuzzyScore(query, name) * boost
    if (s > 0) scored.push({ label: name, detail, score: s })
  }

  if (trigger === '/') {
    // Builtins only suggested at start of input (parity with legacy).
    // Boosted so they rank above CC's slashCommands at otherwise-equal scores.
    if (atDocStart) {
      for (const name of BUILTIN_COMMAND_NAMES) add(name, 'builtin', BUILTIN_SCORE_BOOST)
    }
    for (const name of info.slashCommands) {
      if (BUILTIN_COMMAND_NAMES.includes(name as (typeof BUILTIN_COMMAND_NAMES)[number])) continue
      add(name, undefined)
    }
  } else {
    for (const name of info.skills) add(name, 'skill')
    for (const name of info.agents) add(name, 'agent')
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 12).map(x => ({ label: x.label, detail: x.detail }))
}

function completionSource(context: CompletionContext): CompletionResult | null {
  const pos = context.pos
  const doc = context.state.doc
  const text = doc.toString()

  // Scan backwards from cursor to find a word starting with / or @
  let start = pos - 1
  while (start >= 0 && /[a-zA-Z0-9_:-]/.test(text[start])) start--
  if (start < 0) return null

  const ch = text[start]
  if (ch !== '/' && ch !== '@') return null

  // Trigger char must be at start of doc or preceded by whitespace
  if (start > 0 && !/[\s\n]/.test(text[start - 1])) return null

  // Skip if inside code fence (preserves intent when typing markdown code)
  if (isInsideCodeFence(text.slice(0, start))) return null

  const query = text.slice(start + 1, pos)
  if (query.includes(' ') || query.includes('\n')) return null

  // Don't pop up unless explicitly triggered or actively typing identifier chars
  if (!context.explicit && query.length === 0 && pos !== start + 1) return null

  const trigger = ch as '/' | '@'
  const atDocStart = start === 0
  const info = readSourceInfo()
  const options = buildCompletions(trigger, query, atDocStart, info)

  if (options.length === 0) return null

  return {
    from: start + 1, // replace just the query, leave the trigger char in place
    to: pos,
    options,
    filter: false, // we already scored + sorted
  }
}

/**
 * Explicit Tab -> acceptCompletion at high precedence. The autocompletion
 * extension's defaultKeymap already binds Tab, but our extensions array
 * also includes @codemirror/commands' defaultKeymap which binds Tab to
 * indentMore. Pinning our binding above both guarantees Tab accepts when
 * the popup is showing, and falls through (false) otherwise so indent
 * still works in code-fenced contexts.
 */
const tabAcceptKeymap = Prec.highest(
  keymap.of([
    {
      key: 'Tab',
      run: view => {
        if (completionStatus(view.state) === 'active') return acceptCompletion(view)
        return false
      },
    },
  ]),
)

export function autocompleteExtension(): Extension {
  return [
    tabAcceptKeymap,
    autocompletion({
      override: [completionSource],
      activateOnTyping: true,
      closeOnBlur: true,
      icons: false,
      defaultKeymap: true, // arrows + enter + tab to accept (we re-pin Tab above for safety)
    }),
  ]
}
