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
import {
  bracketMatching,
  defaultHighlightStyle,
  HighlightStyle,
  type LanguageSupport,
  syntaxHighlighting,
} from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { tags } from '@lezer/highlight'

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
      syntaxHighlighting(tokyoNightHighlight),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      updateListener,
      EditorView.lineWrapping,
    ],
  })

  const view = new EditorView({ state, parent })

  // Debug: verify highlight spans appear after parse
  requestAnimationFrame(() => {
    const spans = parent.querySelectorAll('.cm-line span[class]')
    const styleEls = document.querySelectorAll('style')
    console.log(
      `[cm] file=${filePath} lang=${(lang as any)?.language?.name ?? '?'} spans=${spans.length} styles=${styleEls.length} content=${initialContent.length}b`,
    )
    if (spans.length === 0 && initialContent.length > 0) {
      console.warn('[cm] No highlighted spans found! Syntax highlighting may be broken.')
    }
  })

  return view
}
