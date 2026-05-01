/**
 * CM6 autocomplete for slash commands, @ mentions, and : session refs.
 *
 * Triggers:
 *   - `/` at start of doc OR after whitespace -> builtin commands + CC's slashCommands
 *   - `@` at start of doc OR after whitespace -> skills + agents
 *   - `:` at start of doc OR after whitespace -> session slugs (live sessions)
 *
 * Source data is read live from the sessions store at completion time, so the
 * extension doesn't need rebuilding when sessionInfo changes.
 *
 * Also handles `/model <variant>` argument completion via a shared helper.
 * Other sub-command arg completers (e.g. /workon <task>) stay legacy-only
 * for now — they require React-scoped context (project tasks, selected
 * session) and side-effecting onSelect callbacks.
 *
 * Colon trigger rules (parity with `text: prose` natural usage):
 *   - `:` + slug-chars -> popup active, narrows as you type
 *   - `: ` (space after) -> dismisses, natural "foo: bar" prose works
 *   - `::` (double colon) -> dismisses, "::" would never be a session ref
 *   - Accepting a session replaces the whole `:query` with just the slug
 *     (e.g. typing `:arr<Tab>` yields `arr`, not `:arr`).
 */

import {
  acceptCompletion,
  autocompletion,
  type CompletionContext,
  type CompletionResult,
  completionStatus,
  startCompletion,
} from '@codemirror/autocomplete'
import { type Extension, Prec } from '@codemirror/state'
import { type EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { useConversationsStore } from '@/hooks/use-sessions'
import { projectPath } from '@/lib/types'
import { lastPathSegments, projectDisplayName, sessionAddressableSlug } from '@/lib/utils'
import { BUILTIN_COMMAND_NAMES, BUILTIN_SCORE_BOOST, fuzzyScore } from '../../autocomplete-shared'
import { getSubCommand, type SubCommandContext, type SubCommandDef } from '../../sub-commands'
import { composingField } from './composition'

interface SourceInfo {
  slashCommands: string[]
  skills: string[]
  agents: string[]
}

const EMPTY_INFO: SourceInfo = { slashCommands: [], skills: [], agents: [] }

function readSourceInfo(): SourceInfo {
  const state = useConversationsStore.getState()
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

/**
 * Sub-command argument completion: `/cmd <args>` at start of doc.
 *
 * Drives off the shared SUB_COMMANDS registry (input-editor/sub-commands.ts)
 * so the CM backend stays in sync with MarkdownInput's behavior:
 *   - `/model`   : completer + enterBehavior 'select-or-submit' (exact match
 *                  suppresses the popup so Enter submits verbatim)
 *   - `/workon`  : completer + onSelect (sends prompt + clears input) +
 *                  enterBehavior 'select' (Enter ALWAYS picks, never falls
 *                  through to a raw submit)
 *
 * `getCtx` reads React state (project tasks, selectedSessionId) lazily at
 * completion time so the extension closure stays stable across renders.
 */
function subCommandArgCompletion(
  text: string,
  docLength: number,
  getCtx: () => SubCommandContext,
): CompletionResult | null {
  const m = text.match(/^\/(\S+)(\s+)/)
  if (!m) return null
  const cmd = getSubCommand(m[1])
  if (!cmd?.completer) return null
  const prefixLen = m[0].length
  const rest = text.slice(prefixLen)
  if (rest.includes('\n')) return null

  const query = rest.trim()
  const ctx = getCtx()
  const items = cmd.completer(query, ctx)
  if (items.length === 0) return null

  // 'select-or-submit': hide popup on exact match so Enter submits `/cmd <id>` verbatim.
  // 'select' (and default): always show popup -- Enter picks the highlighted option.
  if (cmd.enterBehavior === 'select-or-submit' && items.some(o => o.value.toLowerCase() === query.toLowerCase())) {
    return null
  }

  return {
    from: prefixLen,
    to: docLength,
    options: items.map(item => ({
      label: item.label || item.value,
      detail: cmd.name,
      // Custom apply: route through cmd.onSelect when defined (e.g. /workon
      // sends the prompt + clears input). Otherwise replace the arg region
      // with the picked value, matching legacy MarkdownInput semantics.
      apply: (view: EditorView, _completion, from: number, to: number) => {
        applySubCommandSelection(view, cmd, item.value, getCtx, prefixLen, from, to)
      },
    })),
    filter: false,
  }
}

function applySubCommandSelection(
  view: EditorView,
  cmd: SubCommandDef,
  value: string,
  getCtx: () => SubCommandContext,
  prefixLen: number,
  from: number,
  to: number,
) {
  if (cmd.onSelect) {
    const replacement = cmd.onSelect(value, getCtx())
    if (replacement == null) return // side-effect handled it -- leave doc alone
    // Replace the WHOLE doc when onSelect returns a replacement so behaviors
    // like /workon's "" (clear input) actually clear instead of just clearing
    // the arg region.
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: replacement } })
    return
  }
  // Default: replace the arg region with the picked value (preserve `/cmd `).
  void prefixLen
  view.dispatch({ changes: { from, to, insert: value } })
}

/**
 * Scan backwards for a `:` session trigger. Uses a stricter char class than
 * the /-and-@ scanner (no `:`, no `.`) so that `::` and `foo:bar` don't
 * accidentally activate the session popup — only `:slug` does.
 *
 * First char after `:` must be alphanumeric — blocks emoticons like `:-)`,
 * `:_)`, and other punctuation-led prose from triggering the popup.
 */
function scanColonTrigger(text: string, pos: number): { start: number; query: string } | null {
  let start = pos - 1
  while (start >= 0 && /[a-zA-Z0-9_-]/.test(text[start])) start--
  if (start < 0) return null
  if (text[start] !== ':') return null
  // Must be at doc start or preceded by whitespace (prose like "note: foo" stays inert).
  if (start > 0 && !/\s/.test(text[start - 1])) return null
  const query = text.slice(start + 1, pos)
  if (query.includes(' ') || query.includes('\n')) return null
  // Block non-alphanumeric first char (emoticons, punctuation): `:-)`, `:_x`, etc.
  if (query.length > 0 && !/^[a-zA-Z0-9]/.test(query)) return null
  return { start, query }
}

/**
 * Bare `:` debounce. When the user just typed `:` and nothing follows, hold
 * off showing the popup for a short window so emoticons like `:-)` don't
 * flash the session list between keystrokes. If no follow-up char arrives
 * within the window, a view plugin re-triggers completion so the popup
 * still appears for a genuine bare-colon mention.
 */
const COLON_DELAY_MS = 100
let lastColonInsertAt = 0

const colonDelayTracker = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | null = null
    update(u: ViewUpdate) {
      if (!u.docChanged) return
      let hasColon = false
      u.changes.iterChanges((_fA, _tA, _fB, _tB, inserted) => {
        if (inserted.toString().includes(':')) hasColon = true
      })
      if (!hasColon) return
      lastColonInsertAt = Date.now()
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.timer = null
        startCompletion(u.view)
      }, COLON_DELAY_MS)
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer)
    }
  },
)

interface SessionCompletion {
  label: string // what gets inserted (the session id)
  displayLabel: string // what the user sees (project label or id)
  detail: string // right-aligned: session name + status
  info: string // hover tooltip: filesystem path
}

function sessionCompletions(query: string): SessionCompletion[] {
  const state = useConversationsStore.getState()
  const { sessions, projectSettings } = state
  const q = query.toLowerCase()
  const scored: Array<{ opt: SessionCompletion; score: number }> = []

  // Group sessions by project so the addressable-slug helper can disambiguate
  // siblings with identical title slugs.
  const projectGroups: Record<string, typeof sessions> = {}
  for (const s of sessions) {
    if (s.status === 'ended') continue
    if (!projectGroups[s.project]) projectGroups[s.project] = []
    projectGroups[s.project].push(s)
  }

  for (const session of sessions) {
    if (session.status === 'ended') continue
    // For un-labelled projects, fall back to the project label (same convention
    // the sidebar + command-palette session rows use). session.id is a UUID,
    // so never display it as a name.
    const displayLabel = projectDisplayName(session.project, projectSettings[session.project]?.label)
    const name = session.title || session.agentName || ''
    // The insertable slug -- always compound `project:session-slug` to mirror
    // list_sessions and stay stable across spawn/end churn at the project.
    const slug = sessionAddressableSlug(session, projectSettings, projectGroups[session.project] || [session])
    // Match against display name, the slug, and agent/title so "ola",
    // "OLA", "raccoon", and "arr:viral" all find the expected session.
    const haystack = `${displayLabel} ${slug} ${name}`
    const score = fuzzyScore(q, haystack)
    if (score <= 0) continue
    scored.push({
      opt: {
        label: slug,
        displayLabel,
        detail: name ? `${name} · ${session.status}` : session.status,
        info: lastPathSegments(projectPath(session.project), 3),
      },
      score,
    })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 12).map(s => s.opt)
}

function sessionArgCompletion(text: string, pos: number): CompletionResult | null {
  const hit = scanColonTrigger(text, pos)
  if (!hit) return null
  if (isInsideCodeFence(text.slice(0, hit.start))) return null
  // On a bare `:` we defer briefly so `:-)` and similar emoticons don't flash
  // the popup. Once a follow-up alphanumeric char arrives the query is no
  // longer empty and this gate is skipped; if nothing arrives, the view
  // plugin's timer re-triggers completion after the window.
  if (hit.query.length === 0 && Date.now() - lastColonInsertAt < COLON_DELAY_MS) return null
  const options = sessionCompletions(hit.query)
  if (options.length === 0) return null
  return {
    from: hit.start, // replace the leading `:` too — inserted text is the bare slug
    to: pos,
    options: options.map(o => ({
      ...o,
      apply: `\`${o.label}\``,
    })),
    filter: false,
  }
}

function makeCompletionSource(getCtx: () => SubCommandContext) {
  return function completionSource(context: CompletionContext): CompletionResult | null {
    if (context.state.field(composingField, false)) return null

    const pos = context.pos
    const doc = context.state.doc
    const text = doc.toString()

    // Sub-command arg completion takes precedence when the doc is `/cmd <args>`.
    const subResult = subCommandArgCompletion(text, doc.length, getCtx)
    if (subResult) return subResult

    // `:` session trigger — independent scan (different char class).
    const sessionResult = sessionArgCompletion(text, pos)
    if (sessionResult) return sessionResult

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

    // Exact-match short-circuit: if the query already is a full builtin command
    // name with NO args, suppressing the popup lets Enter fall through to our
    // submit keymap so `/exit`, `/clear`, etc. submit as typed. For commands
    // that take args (e.g. /model, /workon), the user transitions to the
    // sub-command completer above by typing a space.
    if (trigger === '/' && query.length > 0) {
      const q = query.toLowerCase()
      const builtinMatch = atDocStart && BUILTIN_COMMAND_NAMES.some(n => n === q)
      const ccMatch = info.slashCommands.some(n => n.toLowerCase() === q)
      if (builtinMatch || ccMatch) return null
    }

    const options = buildCompletions(trigger, query, atDocStart, info)

    if (options.length === 0) return null

    return {
      from: start + 1, // replace just the query, leave the trigger char in place
      to: pos,
      options,
      filter: false, // we already scored + sorted
    }
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

interface AutocompleteOptions {
  /**
   * Read sub-command context (project tasks, selectedSessionId) at completion
   * time. Called per completion request so callers can back this with a ref
   * and the extension closure stays stable across React renders.
   */
  getSubCommandContext: () => SubCommandContext
}

export function autocompleteExtension(opts: AutocompleteOptions): Extension {
  return [
    tabAcceptKeymap,
    colonDelayTracker,
    autocompletion({
      override: [makeCompletionSource(opts.getSubCommandContext)],
      activateOnTyping: true,
      closeOnBlur: true,
      icons: false,
      defaultKeymap: true, // arrows + enter + tab to accept (we re-pin Tab above for safety)
    }),
  ]
}
