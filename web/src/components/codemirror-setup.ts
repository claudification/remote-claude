/**
 * CodeMirror 6 setup - lazy loaded by file-editor.tsx
 * Keeps the heavy deps out of the main bundle until needed
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { bracketMatching } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'

// Tokyo Night-inspired overrides on top of oneDark
const tokyoNightOverrides = EditorView.theme(
  {
    '&': {
      fontSize: '13px',
      fontFamily: '"Geist Mono", "JetBrains Mono", monospace',
      height: '100%',
    },
    '.cm-content': {
      padding: '8px 0',
      caretColor: '#7aa2f7',
    },
    '.cm-cursor': {
      borderLeftColor: '#7aa2f7',
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      borderRight: '1px solid rgba(122, 162, 247, 0.1)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(122, 162, 247, 0.05)',
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

export function createEditorView(
  parent: HTMLElement,
  initialContent: string,
  onChange: (value: string) => void,
): EditorView {
  const updateListener = EditorView.updateListener.of(update => {
    if (update.docChanged) {
      onChange(update.state.doc.toString())
    }
  })

  const state = EditorState.create({
    doc: initialContent,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      bracketMatching(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      oneDark,
      tokyoNightOverrides,
      updateListener,
      EditorView.lineWrapping,
    ],
  })

  return new EditorView({ state, parent })
}
