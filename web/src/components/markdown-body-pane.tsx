/**
 * Lazy-loaded CodeMirror markdown editor for task bodies.
 *
 * Used by project-board's TaskEditor. Exposes the EditorView via ref so the
 * parent can dispatch changes directly (e.g. paste-upload placeholder swap).
 */

import type { EditorView } from '@codemirror/view'
import { useState } from 'react'
import { SafeCodeMirror } from './codemirror/safe-codemirror'
import { buildMarkdownBodyExtensions } from './codemirror-setup'

// Hoisted out of render: buildMarkdownBodyExtensions() takes no args, so the
// array is identical across mounts. Inline-calling it made `extensions` a new
// reference per render -> CodeMirror reconfigure storm on every keystroke.
const MARKDOWN_BODY_EXTENSIONS = buildMarkdownBodyExtensions()

export default function MarkdownBodyPane({
  initialContent,
  onChange,
  onUpload,
  editorViewRef,
}: {
  initialContent: string
  onChange: (value: string) => void
  onUpload: (file: File) => void
  editorViewRef: React.RefObject<EditorView | null>
}) {
  const [dragOver, setDragOver] = useState(false)
  // NOTE: initialContent is intentionally read once -- the CM doc is the source
  // of truth from that point on. TaskEditor's external state syncs via onChange.
  const [initial] = useState(initialContent)

  function onCreateEditor(view: EditorView) {
    editorViewRef.current = view
    view.contentDOM.addEventListener('paste', (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const file = item.getAsFile()
          if (file) onUpload(file)
          return
        }
      }
    })
    view.focus()
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop-target container, CodeMirror inside handles focus
    <div
      className="relative w-full"
      onDragOver={e => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault()
        setDragOver(false)
        const files = e.dataTransfer?.files
        if (!files?.length) return
        for (const file of files) onUpload(file)
      }}
    >
      <SafeCodeMirror
        value={initial}
        onChange={onChange}
        extensions={MARKDOWN_BODY_EXTENSIONS}
        basicSetup={false}
        theme="dark"
        onCreateEditor={onCreateEditor}
      />
      {dragOver && (
        <div className="absolute inset-0 border-2 border-dashed border-accent/60 bg-accent/5 pointer-events-none flex items-center justify-center">
          <span className="text-xs font-mono text-accent/80">Drop file here</span>
        </div>
      )}
    </div>
  )
}
