/**
 * Composable CM6 extensions for the InputEditor.
 *
 * Returned as a flat Extension[] so they can be passed straight to
 * @uiw/react-codemirror's `extensions` prop. The React component handles
 * mount/unmount, value sync, focus, and StrictMode.
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { bracketMatching, HighlightStyle, syntaxTree } from '@codemirror/language'
import { type Extension, RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { highlightTree, tags } from '@lezer/highlight'
import { autocompleteExtension } from './autocomplete'

// ---------------------------------------------------------------------------
// Tokyo Night highlight (markdown subset)
// ---------------------------------------------------------------------------

const tokyoNightHighlight = HighlightStyle.define([
  { tag: tags.heading1, color: '#7aa2f7', fontWeight: 'bold' },
  { tag: tags.heading2, color: '#7aa2f7', fontWeight: 'bold' },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: '#7aa2f7', fontWeight: 'bold' },
  { tag: tags.strong, color: '#c0caf5', fontWeight: 'bold' },
  { tag: tags.emphasis, color: '#c0caf5', fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: '#565f89' },
  { tag: tags.link, color: '#73daca', textDecoration: 'underline' },
  { tag: tags.url, color: '#73daca' },
  { tag: tags.monospace, color: '#89ddff' },
  { tag: tags.processingInstruction, color: '#565f89' },
  { tag: tags.quote, color: '#9ece6a' },
  { tag: tags.list, color: '#e0af68' },
  { tag: tags.contentSeparator, color: '#565f89' },
])

// ---------------------------------------------------------------------------
// Direct highlight plugin (bypasses CM6's syntaxHighlighting facet quirks)
// ---------------------------------------------------------------------------

function makeDirectHighlightPlugin() {
  const markCache: Record<string, Decoration> = Object.create(null)
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = this.build(view)
      }
      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>()
        const tree = syntaxTree(view.state)
        for (const { from, to } of view.visibleRanges) {
          highlightTree(
            tree,
            tokyoNightHighlight,
            (hFrom, hTo, cls) => {
              if (!markCache[cls]) markCache[cls] = Decoration.mark({ class: cls })
              builder.add(hFrom, hTo, markCache[cls])
            },
            from,
            to,
          )
        }
        return builder.finish()
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) {
          this.decorations = this.build(u.view)
        }
      }
    },
    { decorations: v => v.decorations },
  )
}

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
// Theme (Tokyo Night, no border, transparent bg)
// ---------------------------------------------------------------------------

function inputTheme(fontSize: number, minHeight: string, maxHeight: string): Extension {
  return EditorView.theme(
    {
      '&': {
        fontSize: `${fontSize}px`,
        fontFamily: '"Geist Mono", "JetBrains Mono", monospace',
        backgroundColor: 'transparent',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-content': {
        padding: '8px 12px',
        caretColor: '#7aa2f7',
        color: '#a9b1d6',
        minHeight,
      },
      '.cm-cursor': { borderLeftColor: '#7aa2f7' },
      '.cm-selectionBackground': { backgroundColor: 'rgba(122, 162, 247, 0.2) !important' },
      '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(122, 162, 247, 0.3) !important' },
      '.cm-scroller': { overflow: 'auto', maxHeight, lineHeight: '1.5' },
      '.cm-placeholder': { color: 'rgba(169, 177, 214, 0.35)' },
      '.cm-effort-keyword': {
        color: '#ff9e64',
        textDecoration: 'underline',
        textDecorationColor: 'rgba(255, 158, 100, 0.4)',
        textUnderlineOffset: '2px',
      },
      '.cm-tooltip.cm-tooltip-autocomplete': {
        backgroundColor: '#1a1b26',
        border: '1px solid #33467c',
        borderRadius: '0',
        fontFamily: '"Geist Mono", "JetBrains Mono", monospace',
        fontSize: '12px',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': { maxHeight: '14em', fontFamily: 'inherit' },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px', color: '#a9b1d6' },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: 'rgba(122, 162, 247, 0.2)',
        color: '#c0caf5',
      },
      '.cm-completionLabel': { color: 'inherit' },
      '.cm-completionDetail': {
        marginLeft: '8px',
        color: '#565f89',
        fontStyle: 'normal',
        fontSize: '11px',
      },
      '.cm-completionMatchedText': { color: '#7aa2f7', textDecoration: 'none', fontWeight: 'bold' },
    },
    { dark: true },
  )
}

// ---------------------------------------------------------------------------
// Public composer
// ---------------------------------------------------------------------------

export interface InputExtensionOptions {
  onSubmit: () => void
  fontSize?: number
  minHeight?: string
  maxHeight?: string
  enableEffortKeywords?: boolean
  enableAutocomplete?: boolean
}

export function buildInputExtensions(opts: InputExtensionOptions): Extension[] {
  const fontSize = opts.fontSize ?? 14
  const minHeight = opts.minHeight ?? '1.5em'
  const maxHeight = opts.maxHeight ?? '12em'

  // Submit on Enter, newline on Shift-Enter (default Enter behavior).
  const submitKeymap = keymap.of([
    {
      key: 'Enter',
      run: () => {
        opts.onSubmit()
        return true
      },
      shift: () => false,
    },
  ])

  const extensions: Extension[] = [
    drawSelection(),
    bracketMatching(),
    history(),
    submitKeymap, // before defaultKeymap so our Enter wins (autocomplete still wins over us when popup is open)
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown(),
    inputTheme(fontSize, minHeight, maxHeight),
    makeDirectHighlightPlugin(),
    // biome-ignore lint/style/noNonNullAssertion: HighlightStyle.module is always defined after define()
    EditorView.styleModule.of(tokyoNightHighlight.module!),
    EditorView.lineWrapping,
  ]

  if (opts.enableEffortKeywords) extensions.push(effortKeywordPlugin)
  if (opts.enableAutocomplete) extensions.push(autocompleteExtension())

  return extensions
}
