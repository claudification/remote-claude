/**
 * CodeMirror 6 setup - lazy loaded by file-editor.tsx
 * Keeps the heavy deps out of the main bundle until needed
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { bracketMatching, HighlightStyle, type LanguageSupport, syntaxTree } from '@codemirror/language'
import { EditorState, type Extension, RangeSetBuilder } from '@codemirror/state'
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

// Tokyo Night colors
const tokyoNightHighlight = HighlightStyle.define([
  { tag: tags.heading1, color: '#7aa2f7', fontWeight: 'bold', fontSize: '1.3em' },
  { tag: tags.heading2, color: '#7aa2f7', fontWeight: 'bold', fontSize: '1.2em' },
  { tag: tags.heading3, color: '#7aa2f7', fontWeight: 'bold', fontSize: '1.1em' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: '#7aa2f7', fontWeight: 'bold' },
  { tag: tags.strong, color: '#c0caf5', fontWeight: 'bold' },
  { tag: tags.emphasis, color: '#c0caf5', fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: '#565f89' },
  { tag: tags.link, color: '#73daca', textDecoration: 'underline' },
  { tag: tags.url, color: '#73daca' },
  { tag: tags.monospace, color: '#89ddff' },
  { tag: tags.processingInstruction, color: '#565f89' },
  { tag: tags.quote, color: '#9ece6a' },
  { tag: tags.list, color: '#e0af68' },
  { tag: tags.string, color: '#9ece6a' },
  { tag: tags.labelName, color: '#bb9af7' },
  { tag: tags.content, color: '#a9b1d6' },
  { tag: tags.comment, color: '#565f89', fontStyle: 'italic' },
  { tag: tags.escape, color: '#bb9af7' },
  { tag: tags.character, color: '#bb9af7' },
  { tag: tags.keyword, color: '#bb9af7' },
  { tag: tags.operator, color: '#89ddff' },
  { tag: tags.number, color: '#ff9e64' },
  { tag: tags.function(tags.variableName), color: '#7aa2f7' },
  { tag: tags.variableName, color: '#c0caf5' },
  { tag: tags.typeName, color: '#2ac3de' },
  { tag: tags.propertyName, color: '#73daca' },
  { tag: tags.contentSeparator, color: '#565f89' },
])

// Editor theme (non-highlighting)
const editorTheme = EditorView.theme(
  {
    '&': {
      fontSize: '13px',
      fontFamily: '"Geist Mono", "JetBrains Mono", monospace',
      height: '100%',
      backgroundColor: '#1a1b26',
    },
    '.cm-content': {
      padding: '8px 0',
      caretColor: '#7aa2f7',
      color: '#a9b1d6',
    },
    '.cm-cursor': {
      borderLeftColor: '#7aa2f7',
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: '#3b4261',
      borderRight: '1px solid rgba(122, 162, 247, 0.1)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(122, 162, 247, 0.05)',
      color: '#737aa2',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(122, 162, 247, 0.05)',
    },
    '.cm-selectionBackground': {
      backgroundColor: 'rgba(122, 162, 247, 0.2) !important',
    },
    '&.cm-focused .cm-selectionBackground': {
      backgroundColor: 'rgba(122, 162, 247, 0.3) !important',
    },
    '.cm-scroller': {
      overflow: 'auto',
    },
  },
  { dark: true },
)

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
    case 'md':
    case 'mdx':
    case 'markdown':
      return markdown()
    default:
      return markdown()
  }
}

export function createEditorView(
  parent: HTMLElement,
  initialContent: string,
  onChange: (value: string) => void,
  filePath?: string,
): EditorView {
  const updateListener = EditorView.updateListener.of(update => {
    if (update.docChanged) {
      onChange(update.state.doc.toString())
    }
  })

  const lang = langFromPath(filePath)

  // Direct highlight plugin - bypasses CM6's broken syntaxHighlighting facet pipeline
  // Uses the same highlightTree() that our diagnostics confirmed produces 101+ matches
  const markCache: Record<string, Decoration> = Object.create(null)
  const directHighlightPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = this.build(view)
      }
      build(view: EditorView) {
        const builder = new RangeSetBuilder<Decoration>()
        const tree = syntaxTree(view.state)
        for (const { from, to } of view.visibleRanges) {
          highlightTree(
            tree,
            tokyoNightHighlight,
            (hFrom, hTo, cls) => {
              if (!markCache[cls]) markCache[cls] = Decoration.mark({ class: cls })
              const mark = markCache[cls]
              builder.add(hFrom, hTo, mark)
            },
            from,
            to,
          )
        }
        return builder.finish()
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
          this.decorations = this.build(update.view)
        }
      }
    },
    { decorations: v => v.decorations },
  )

  const state = EditorState.create({
    doc: initialContent,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      bracketMatching(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      lang,
      editorTheme,
      directHighlightPlugin,
      // Mount the HighlightStyle's CSS (syntaxHighlighting() normally does this)
      // biome-ignore lint/style/noNonNullAssertion: module is always defined after HighlightStyle.define
      EditorView.styleModule.of(tokyoNightHighlight.module!),
      updateListener,
      EditorView.lineWrapping,
    ],
  })

  const view = new EditorView({ state, parent })

  // Verify highlighting after initial render
  requestAnimationFrame(() => {
    const spans = parent.querySelectorAll('.cm-line span')
    console.log(`[cm] ${filePath}: ${spans.length} highlighted spans`)
  })

  return view
}
