/**
 * Paste/drop file upload helpers for the CodeMirror backend.
 *
 * Wires native browser events (paste, drop) on the CM contentDOM to
 * uploadFileWithPlaceholder, dispatching CM transactions to insert the
 * placeholder and later replace it with the final URL.
 */

import type { EditorView } from '@codemirror/view'
import { uploadFileWithPlaceholder } from '@/lib/upload'

function uploadFileIntoView(view: EditorView, file: File, sessionId?: string) {
  uploadFileWithPlaceholder(
    file,
    placeholder => {
      const head = view.state.selection.main.head
      view.dispatch({ changes: { from: head, insert: placeholder } })
    },
    (search, replacement) => {
      const content = view.state.doc.toString()
      const idx = content.indexOf(search)
      if (idx >= 0) {
        view.dispatch({ changes: { from: idx, to: idx + search.length, insert: replacement } })
      }
    },
    sessionId,
  )
}

/** Intercept paste of clipboard images, upload them. Returns the cleanup function. */
export function attachPasteUpload(view: EditorView, getSessionId: () => string | null): () => void {
  function handler(e: ClipboardEvent) {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) uploadFileIntoView(view, file, getSessionId() ?? undefined)
        return
      }
    }
  }
  view.contentDOM.addEventListener('paste', handler)
  return () => view.contentDOM.removeEventListener('paste', handler)
}

/** Upload a dropped file (called from React onDrop handler). */
export function uploadDroppedFile(view: EditorView, file: File, sessionId: string | null) {
  uploadFileIntoView(view, file, sessionId ?? undefined)
}
