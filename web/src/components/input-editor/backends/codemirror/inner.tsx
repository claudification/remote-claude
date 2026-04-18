/**
 * The actual CM rendering surface. Imports CodeMirror + extensions eagerly;
 * loaded lazily from index.tsx so the chunk only ships when used.
 *
 * Mobile compose: when the editor is focused on a mobile viewport (and the
 * caller hasn't set `inline`), the editor moves into a full-viewport portal
 * panel so the user gets a real composing surface above the keyboard.
 */

import type { EditorView } from '@codemirror/view'
import CodeMirror from '@uiw/react-codemirror'
import { useMemo, useRef, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { cn } from '@/lib/utils'
import { MobileComposePanel } from '../../shell/mobile-compose-panel'
import { useIsMobile } from '../../shell/use-is-mobile'
import { useScrollLock } from '../../shell/use-scroll-lock'
import type { InputEditorProps } from '../../types'
import { buildInputExtensions } from './extensions'
import { attachPasteUpload, uploadDroppedFile } from './paste-drop'

export default function CodeMirrorBackendInner(props: InputEditorProps) {
  const [dragOver, setDragOver] = useState(false)
  const [focused, setFocused] = useState(false)
  const isMobile = useIsMobile()
  const expanded = isMobile && focused && !props.inline

  const sessionId = useSessionsStore(s => s.selectedSessionId)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const viewRef = useRef<EditorView | null>(null)

  const onSubmitRef = useRef(props.onSubmit)
  onSubmitRef.current = props.onSubmit

  const { visibleHeight } = useScrollLock(expanded)

  // Build extensions ONCE. Boolean toggles captured at mount time.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-shot
  const extensions = useMemo(
    () =>
      buildInputExtensions({
        onSubmit: () => onSubmitRef.current(),
        // Bigger font on mobile for thumb typing; CM contentEditable bypasses iOS auto-zoom.
        fontSize: isMobile ? 15 : 14,
        // Generous max in expanded mode; capped tight when inline.
        maxHeight: '12em',
        enableEffortKeywords: props.enableEffortKeywords,
        enableAutocomplete: props.enableAutocomplete,
      }),
    [],
  )

  function onCreateEditor(view: EditorView) {
    viewRef.current = view
    attachPasteUpload(view, () => sessionIdRef.current)
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (!files?.length) return
    const view = viewRef.current
    if (!view) return
    for (const file of files) uploadDroppedFile(view, file, sessionIdRef.current)
  }

  // Blur is async on iOS -- defer collapse so a tap on Send/Done in the panel
  // (which steals focus from the editor) doesn't trip a premature close.
  // The buttons explicitly call closePanel() after their action.
  function onBlur() {
    setTimeout(() => {
      const active = document.activeElement
      if (active?.closest('[data-mobile-compose-panel]')) return
      setFocused(false)
    }, 50)
  }

  function closePanel() {
    setFocused(false)
    viewRef.current?.contentDOM.blur()
  }

  function handleSubmit() {
    props.onSubmit()
  }

  const editor = (
    <CodeMirror
      value={props.value}
      onChange={props.onChange}
      extensions={extensions}
      placeholder={props.placeholder}
      editable={!props.disabled}
      readOnly={props.disabled}
      autoFocus={props.autoFocus}
      basicSetup={false}
      theme="dark"
      onCreateEditor={onCreateEditor}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
    />
  )

  return (
    <>
      {/* Inline placeholder/wrapper -- always rendered to preserve layout */}
      <div
        className={cn('relative w-full', expanded && 'opacity-0 pointer-events-none', props.className)}
        onDragOver={e => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {!expanded && editor}
        {!expanded && dragOver && (
          <div className="absolute inset-0 border-2 border-dashed border-accent/60 bg-accent/5 pointer-events-none flex items-center justify-center">
            <span className="text-xs font-mono text-accent/80">Drop file here</span>
          </div>
        )}
        {/* Ghost when expanded: keep parent layout from collapsing */}
        {expanded && <div className="min-h-[1.5em]" />}
      </div>

      {/* Expanded portal panel */}
      {expanded && (
        <MobileComposePanel
          visibleHeight={visibleHeight}
          onClose={closePanel}
          onSubmit={handleSubmit}
          sendDisabled={props.disabled}
        >
          {editor}
        </MobileComposePanel>
      )}
    </>
  )
}
