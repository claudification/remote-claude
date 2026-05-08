/**
 * CM6 extension factories shared between the file editor and the project
 * board's task-body markdown editor. Lazy-loaded by each consumer so the
 * language packs and themes only ship when someone actually opens an editor.
 *
 * The InputEditor has its own extensions in
 * `input-editor/backends/codemirror/extensions.ts` because its theming and
 * keymap differ (compact, submit-on-Enter, autocomplete).
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { bracketMatching, HighlightStyle, type LanguageSupport, syntaxTree } from '@codemirror/language'
import { type Extension, RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { highlightTree, tags } from '@lezer/highlight'

// ---------------------------------------------------------------------------
// Tokyo Night highlight (full set)
// ---------------------------------------------------------------------------

const tokyoNightHighlight = HighlightStyle.define([
  { tag: tags.heading1, color: 'var(--primary)', fontWeight: 'bold', fontSize: '1.3em' },
  { tag: tags.heading2, color: 'var(--primary)', fontWeight: 'bold', fontSize: '1.2em' },
  { tag: tags.heading3, color: 'var(--primary)', fontWeight: 'bold', fontSize: '1.1em' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: 'var(--primary)', fontWeight: 'bold' },
  { tag: tags.strong, color: 'var(--foreground)', fontWeight: 'bold' },
  { tag: tags.emphasis, color: 'var(--foreground)', fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--comment)' },
  { tag: tags.link, color: 'var(--success)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--success)' },
  { tag: tags.monospace, color: 'var(--info)' },
  { tag: tags.processingInstruction, color: 'var(--comment)' },
  { tag: tags.quote, color: 'var(--event-conversation)' },
  { tag: tags.list, color: 'var(--accent)' },
  { tag: tags.string, color: 'var(--event-conversation)' },
  { tag: tags.labelName, color: 'var(--event-prompt)' },
  { tag: tags.content, color: 'var(--foreground)' },
  { tag: tags.comment, color: 'var(--comment)', fontStyle: 'italic' },
  { tag: tags.escape, color: 'var(--event-prompt)' },
  { tag: tags.character, color: 'var(--event-prompt)' },
  { tag: tags.keyword, color: 'var(--event-prompt)' },
  { tag: tags.operator, color: 'var(--info)' },
  { tag: tags.number, color: 'var(--warning)' },
  { tag: tags.function(tags.variableName), color: 'var(--primary)' },
  { tag: tags.variableName, color: 'var(--foreground)' },
  { tag: tags.typeName, color: 'var(--info)' },
  { tag: tags.propertyName, color: 'var(--success)' },
  { tag: tags.contentSeparator, color: 'var(--comment)' },
])

/**
 * Direct highlight plugin -- paints Tokyo Night decorations via highlightTree().
 * Bypasses CM6's syntaxHighlighting facet, which had stale-style bugs in our
 * original integration.
 */
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
// Themes
// ---------------------------------------------------------------------------

const fileEditorTheme = EditorView.theme(
  {
    '&': {
      fontSize: '13px',
      fontFamily: '"Geist Mono", "JetBrains Mono", monospace',
      height: '100%',
      backgroundColor: 'var(--surface-inset)',
    },
    '.cm-content': { padding: '8px 0', caretColor: 'var(--primary)', color: 'var(--foreground)' },
    '.cm-cursor': { borderLeftColor: 'var(--primary)' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--comment)',
      borderRight: '1px solid color-mix(in oklch, var(--primary) 10%, transparent)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'color-mix(in oklch, var(--primary) 5%, transparent)',
      color: 'var(--muted-foreground)',
    },
    '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--primary) 5%, transparent)' },
    '.cm-selectionBackground': {
      backgroundColor: 'color-mix(in oklch, var(--primary) 20%, transparent) !important',
    },
    '&.cm-focused .cm-selectionBackground': {
      backgroundColor: 'color-mix(in oklch, var(--primary) 30%, transparent) !important',
    },
    '.cm-scroller': { overflow: 'auto' },
  },
  { dark: true },
)

const markdownEditorTheme = EditorView.theme(
  {
    '&': {
      fontSize: '13px',
      fontFamily: '"Geist Mono", "JetBrains Mono", monospace',
      backgroundColor: 'transparent',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-content': { padding: '0', caretColor: 'var(--primary)', color: 'var(--foreground)', minHeight: '200px' },
    '.cm-cursor': { borderLeftColor: 'var(--primary)' },
    '.cm-selectionBackground': {
      backgroundColor: 'color-mix(in oklch, var(--primary) 20%, transparent) !important',
    },
    '&.cm-focused .cm-selectionBackground': {
      backgroundColor: 'color-mix(in oklch, var(--primary) 30%, transparent) !important',
    },
    '.cm-scroller': { overflow: 'visible', lineHeight: '1.625' },
  },
  { dark: true },
)

// ---------------------------------------------------------------------------
// Language resolution
// ---------------------------------------------------------------------------

function langFromPath(filePath: string | undefined): LanguageSupport | Extension {
  if (!filePath) return markdown()
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  switch (ext) {
    case 'ts':
    case 'tsx':
      return javascript({ typescript: true, jsx: ext === 'tsx' })
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript()
    case 'jsx':
      return javascript({ jsx: true })
    case 'json':
    case 'jsonl':
      return json()
    case 'css':
      return css()
    case 'html':
    case 'htm':
    case 'svg':
      return html()
    case 'py':
      return python()
    default:
      return markdown()
  }
}

// ---------------------------------------------------------------------------
// Public: extension array factories (use with <CodeMirror extensions={...} />)
// ---------------------------------------------------------------------------

/** Extensions for the full file editor: line numbers, active-line, language-aware. */
export function buildFileEditorExtensions(filePath?: string): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    bracketMatching(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    langFromPath(filePath),
    fileEditorTheme,
    makeDirectHighlightPlugin(),
    // biome-ignore lint/style/noNonNullAssertion: module is always defined after HighlightStyle.define
    EditorView.styleModule.of(tokyoNightHighlight.module!),
    EditorView.lineWrapping,
  ]
}

/** Extensions for the markdown-only task-body editor: no gutters, auto-height. */
export function buildMarkdownBodyExtensions(): Extension[] {
  return [
    drawSelection(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown(),
    markdownEditorTheme,
    makeDirectHighlightPlugin(),
    // biome-ignore lint/style/noNonNullAssertion: module is always defined after HighlightStyle.define
    EditorView.styleModule.of(tokyoNightHighlight.module!),
    EditorView.lineWrapping,
  ]
}
