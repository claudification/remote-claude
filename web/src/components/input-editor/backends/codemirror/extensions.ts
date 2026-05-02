/**
 * Composable CM6 extensions for the InputEditor.
 *
 * Returned as a flat Extension[] so they can be passed straight to
 * @uiw/react-codemirror's `extensions` prop. The React component handles
 * mount/unmount, value sync, focus, and StrictMode.
 */

import {
  defaultKeymap,
  deleteGroupBackward,
  deleteToLineStart,
  emacsStyleKeymap,
  history,
  historyKeymap,
} from '@codemirror/commands'
import { type Extension, RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  keymap,
  tooltips,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { record } from '@/lib/perf-metrics'
import type { SubCommandContext } from '../../sub-commands'
import { autocompleteExtension } from './autocomplete'
import { composingField, composingTracker } from './composition'

// ---------------------------------------------------------------------------
// Lightweight markdown decorator
// ---------------------------------------------------------------------------
// PERF NOTE (2026-04-19): the previous implementation pulled in @codemirror/lang-markdown
// + a tree-walking highlight plugin (`makeDirectHighlightPlugin`) that ran the full
// lezer markdown parser on every keystroke. That was the smoking gun for the
// "INSANE sluggishness" report -- React renders measured 1ms per commit, but typing
// felt awful because the parser + tree walk happened between dispatch and paint.
// The chat input doesn't need GFM-correct grammar; regex marks for the common
// inline syntax (`**bold**`, `*italic*`, `~~strike~~`, `code`, links, headings,
// blockquotes, lists) are visually identical for compose-time feedback and orders
// of magnitude cheaper.

const markdownClasses = {
  heading: 'cm-md-heading',
  strong: 'cm-md-strong',
  emphasis: 'cm-md-emphasis',
  strikethrough: 'cm-md-strikethrough',
  monospace: 'cm-md-monospace',
  link: 'cm-md-link',
  quote: 'cm-md-quote',
  list: 'cm-md-list',
} as const

const markCache: Record<string, Decoration> = Object.create(null)
function mark(cls: string): Decoration {
  if (!markCache[cls]) markCache[cls] = Decoration.mark({ class: cls })
  return markCache[cls]
}

interface MarkRule {
  re: RegExp
  cls: string
}

const markRules: MarkRule[] = [
  { re: /^(#{1,6})\s.+$/gm, cls: markdownClasses.heading },
  { re: /^>\s.+$/gm, cls: markdownClasses.quote },
  { re: /^[*\-+]\s.+$/gm, cls: markdownClasses.list },
  { re: /^\d+\.\s.+$/gm, cls: markdownClasses.list },
  { re: /\*\*[^*\n]+\*\*/g, cls: markdownClasses.strong },
  { re: /(?<!\*)\*[^*\n]+\*(?!\*)/g, cls: markdownClasses.emphasis },
  { re: /~~[^~\n]+~~/g, cls: markdownClasses.strikethrough },
  { re: /`[^`\n]+`/g, cls: markdownClasses.monospace },
  { re: /\[[^\]\n]+\]\([^)\n]+\)/g, cls: markdownClasses.link },
]

function buildMarkdownDecorations(view: EditorView): DecorationSet {
  // Collect all matches into one array, sort by [from, to], then add to builder
  // in order -- RangeSetBuilder requires monotonic from; collisions across rules
  // are fine (multiple decorations can stack at the same range, but the builder
  // needs them ordered).
  type Hit = { from: number; to: number; cls: string }
  const hits: Hit[] = []
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to)
    for (const rule of markRules) {
      rule.re.lastIndex = 0
      let m: RegExpExecArray | null
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
      while ((m = rule.re.exec(text))) {
        hits.push({ from: from + m.index, to: from + m.index + m[0].length, cls: rule.cls })
      }
    }
  }
  hits.sort((a, b) => a.from - b.from || a.to - b.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const h of hits) builder.add(h.from, h.to, mark(h.cls))
  return builder.finish()
}

const markdownDecoratorPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildMarkdownDecorations(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildMarkdownDecorations(u.view)
    }
  },
  { decorations: v => v.decorations },
)

// ---------------------------------------------------------------------------
// CM update timer -- records doc-change update -> next paint as 'cm.update'
// ---------------------------------------------------------------------------
// React's <Profiler> only times React commits. CM does its own work between
// our setLocalInput call and the next browser paint (transactions, decoration
// rebuild, layout for line wrapping, autocomplete source, etc). This plugin
// surfaces that hidden cost so the perf HUD can attribute slow keystrokes
// to CM internals vs React.

const cmUpdateTimer = EditorView.updateListener.of(u => {
  if (!u.docChanged) return
  const t0 = performance.now()
  requestAnimationFrame(() => {
    record('render', 'cm.update->paint', performance.now() - t0, `docLen=${u.state.doc.length}`)
  })
})

// ---------------------------------------------------------------------------
// Effort keyword highlighter (ultrathink)
// ---------------------------------------------------------------------------

const effortMark = Decoration.mark({ class: 'cm-effort-keyword' })

function buildEffortDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const re = /\bultrathink\b/gi
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to)
    re.lastIndex = 0
    let m: RegExpExecArray | null
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
    while ((m = re.exec(text))) {
      builder.add(from + m.index, from + m.index + m[0].length, effortMark)
    }
  }
  return builder.finish()
}

const effortKeywordPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildEffortDecorations(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = buildEffortDecorations(u.view)
    }
  },
  { decorations: v => v.decorations },
)

// ---------------------------------------------------------------------------
// Dark mode base -- replaces @uiw/react-codemirror's built-in "dark" theme
// which injects an opaque background on its wrapper div. This signals dark
// mode to CM6 without adding any visual styling of its own.
// ---------------------------------------------------------------------------

export const darkThemeBase = EditorView.theme({}, { dark: true })

// ---------------------------------------------------------------------------
// Theme -- uses the system's CSS custom properties from globals.css so the
// editor blends with the rest of the control panel.
// ---------------------------------------------------------------------------

function inputTheme(fontSize: number, minHeight: string, maxHeight: string): Extension {
  return EditorView.theme(
    {
      '&': {
        fontSize: `${fontSize}px`,
        fontFamily: 'var(--font-mono)',
        backgroundColor: 'transparent',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-content': {
        padding: '8px 12px',
        caretColor: 'var(--color-primary)',
        color: 'var(--color-foreground)',
        minHeight,
      },
      '.cm-cursor': { borderLeftColor: 'var(--color-primary)' },
      '.cm-selectionBackground': {
        backgroundColor: 'color-mix(in oklch, var(--color-primary) 20%, transparent) !important',
      },
      '&.cm-focused .cm-selectionBackground': {
        backgroundColor: 'color-mix(in oklch, var(--color-primary) 30%, transparent) !important',
      },
      '.cm-scroller': { overflow: 'auto', maxHeight, lineHeight: '1.5' },
      '.cm-placeholder': { color: 'color-mix(in oklch, var(--color-muted-foreground) 45%, transparent)' },
      '.cm-effort-keyword': {
        color: 'var(--color-accent)',
        textDecoration: 'underline',
        textDecorationColor: 'color-mix(in oklch, var(--color-accent) 40%, transparent)',
        textUnderlineOffset: '2px',
      },
      // Markdown decorator classes -- matches prose-hacker styling in globals.css
      '.cm-md-heading': { color: 'var(--color-primary)', fontWeight: 'bold' },
      '.cm-md-strong': { color: 'var(--color-accent)', fontWeight: 'bold' },
      '.cm-md-emphasis': { color: 'var(--color-primary)', fontStyle: 'italic' },
      '.cm-md-strikethrough': { textDecoration: 'line-through', color: 'var(--color-muted-foreground)' },
      '.cm-md-monospace': { color: 'var(--color-active)' },
      '.cm-md-link': { color: 'var(--color-primary)', textDecoration: 'underline' },
      '.cm-md-quote': { color: 'var(--color-muted-foreground)', fontStyle: 'italic' },
      '.cm-md-list': { color: 'var(--color-accent)' },
      '.cm-tooltip.cm-tooltip-autocomplete': {
        backgroundColor: 'var(--color-background)',
        border: '1px solid var(--color-border)',
        borderRadius: '0',
        fontFamily: 'var(--font-mono)',
        fontSize: '12px',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': { maxHeight: '14em', fontFamily: 'inherit' },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px', color: 'var(--color-foreground)' },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: 'color-mix(in oklch, var(--color-primary) 20%, transparent)',
        color: 'var(--color-foreground)',
      },
      '.cm-completionLabel': { color: 'inherit' },
      '.cm-completionDetail': {
        marginLeft: '8px',
        color: 'var(--color-muted-foreground)',
        fontStyle: 'normal',
        fontSize: '11px',
      },
      '.cm-completionMatchedText': { color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 'bold' },
    },
    { dark: true },
  )
}

// ---------------------------------------------------------------------------
// Public composer
// ---------------------------------------------------------------------------

interface InputExtensionOptions {
  onSubmit: () => void
  fontSize?: number
  minHeight?: string
  maxHeight?: string
  enableEffortKeywords?: boolean
  enableAutocomplete?: boolean
  /**
   * Return false to make Enter fall through (insert newline) instead of
   * submitting. Called at keypress time, so callers can back it with a ref
   * to toggle behavior without rebuilding extensions. Defaults to always
   * submit when omitted.
   */
  shouldEnterSubmit?: () => boolean
  /**
   * Sub-command context provider for `/workon`-style completers that need
   * access to React state (project tasks, selected session). Required when
   * enableAutocomplete is true.
   */
  getSubCommandContext?: () => SubCommandContext
}

/**
 * Submit entry point shared by every surface that can fire a submit:
 *   - the Enter keymap (desktop + inline)
 *   - the mobile compose panel's Send button
 *
 * Clears the doc *before* calling onSubmit so the editor empties
 * immediately. react-codemirror has a 200ms "typing latch" (see
 * node_modules/@uiw/react-codemirror/esm/useCodeMirror.js TYPING_TIMOUT)
 * that defers prop-driven `value=""` updates until typing settles -- if
 * we only relied on React state -> value prop, the clear would lag by up
 * to 200ms. Dispatching directly through CM sidesteps the latch; the
 * parent's onChange still syncs React state in the same call stack, and
 * the submit handler reads the (still-correct) pre-clear value from its
 * own React-state closure.
 */
export function submitFromEditor(view: EditorView, onSubmit: () => void) {
  const len = view.state.doc.length
  if (len > 0) {
    view.dispatch({ changes: { from: 0, to: len, insert: '' } })
  }
  onSubmit()
}

export function buildInputExtensions(opts: InputExtensionOptions): Extension[] {
  const fontSize = opts.fontSize ?? 14
  const minHeight = opts.minHeight ?? '1.5em'
  const maxHeight = opts.maxHeight ?? '12em'

  // Shift-Enter -> newline is handled by a capture-phase listener on
  // contentDOM (see inner.tsx onCreateEditor) to bypass CM6's composition
  // gate on iOS. The keymap below only handles unmodified Enter.

  // Submit on Enter (unmodified).
  const submitKeymap = keymap.of([
    {
      key: 'Enter',
      run: view => {
        if (view.composing) return false
        if (opts.shouldEnterSubmit && !opts.shouldEnterSubmit()) return false
        submitFromEditor(view, opts.onSubmit)
        return true
      },
    },
  ])

  // Escape: blur the editor and let the event propagate so any ancestor
  // (Radix Dialog, etc.) can handle it natively. Without this, contentEditable
  // sometimes swallows Escape silently in modal contexts.
  // The autocomplete extension's own Escape binding (only active when the
  // popup is showing) runs at higher precedence and gets first crack -- so
  // Escape still closes the popup before getting to us.
  const escapeBlurKeymap = keymap.of([
    {
      key: 'Escape',
      run: view => {
        view.contentDOM.blur()
        return false // don't claim handled -- let Dialog's keydown listener fire
      },
    },
  ])

  // Emacs / readline motions: Ctrl-A line start, Ctrl-E line end, Ctrl-K kill
  // to end, Ctrl-U kill to start, Ctrl-D forward delete, Ctrl-B/F char move,
  // Ctrl-P/N line move, Ctrl-H backspace, Ctrl-T transpose, Ctrl-V page down.
  // CM6 ships emacsStyleKeymap but defaultKeymap only enables it on macOS via
  // the `mac:` field. We register it cross-platform for parity with terminals
  // and shells. Ctrl-U is NOT in emacsStyleKeymap, so we add it manually.
  const emacsKeymap = keymap.of([
    ...emacsStyleKeymap,
    { key: 'Ctrl-u', run: deleteToLineStart, preventDefault: true },
    { key: 'Ctrl-w', run: deleteGroupBackward, preventDefault: true },
  ])

  const extensions: Extension[] = [
    composingField,
    composingTracker,
    drawSelection(),
    history(),
    submitKeymap, // before defaultKeymap so our Enter wins (autocomplete still wins over us when popup is open)
    escapeBlurKeymap,
    emacsKeymap, // before defaultKeymap so our Ctrl-* bindings take priority
    keymap.of([...defaultKeymap, ...historyKeymap]),
    // Portal tooltips (autocomplete popup, etc.) to <body> so the input
    // wrapper's overflow:hidden / rounded corners don't clip them.
    tooltips({ parent: document.body }),
    inputTheme(fontSize, minHeight, maxHeight),
    // Lightweight regex-based markdown decorator (replaces the heavy
    // lang-markdown + tree-walk highlight plugin -- see PERF NOTE above).
    markdownDecoratorPlugin,
    cmUpdateTimer,
    EditorView.lineWrapping,
  ]

  if (opts.enableEffortKeywords) extensions.push(effortKeywordPlugin)
  if (opts.enableAutocomplete) {
    const getCtx = opts.getSubCommandContext ?? (() => ({ tasks: [], conversationId: null }))
    extensions.push(autocompleteExtension({ getSubCommandContext: getCtx }))
  }

  return extensions
}
