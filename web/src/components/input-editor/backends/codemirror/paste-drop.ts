/**
 * Paste/drop file upload helpers for the CodeMirror backend.
 *
 * Wires native browser events (paste, drop) on the CM contentDOM to
 * uploadFileWithPlaceholder, dispatching CM transactions to insert the
 * placeholder and later replace it with the final URL.
 */

import type { EditorView } from '@codemirror/view'
import { uploadFileWithPlaceholder } from '@/lib/upload'

function uploadFileIntoView(view: EditorView, file: File, conversationId?: string) {
  uploadFileWithPlaceholder(
    file,
    placeholder => {
      // Insert placeholder at cursor and move the cursor to its end so the
      // user can keep typing without re-positioning. Also focus the editor
      // in case the upload was triggered while focus was elsewhere (drag/drop).
      const head = view.state.selection.main.head
      view.dispatch({
        changes: { from: head, insert: placeholder },
        selection: { anchor: head + placeholder.length },
      })
      view.focus()
    },
    (search, replacement) => {
      // Replace placeholder with final markdown. Move cursor to the end of
      // the replacement -- the user's cursor was likely sitting at the end
      // of the placeholder, but the placeholder length differs from the
      // final URL so it would otherwise drift backward into the text.
      const content = view.state.doc.toString()
      const idx = content.indexOf(search)
      if (idx >= 0) {
        view.dispatch({
          changes: { from: idx, to: idx + search.length, insert: replacement },
          selection: { anchor: idx + replacement.length },
        })
      }
    },
    conversationId,
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
export function uploadDroppedFile(view: EditorView, file: File, conversationId: string | null) {
  uploadFileIntoView(view, file, conversationId ?? undefined)
}
