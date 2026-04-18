/**
 * <CodeMirrorBackend> -- CM6 implementation of the InputEditor backend.
 *
 * Lazy-loads the CM factory so the legacy users pay no bundle cost.
 *
 * Behaviors:
 *  - Markdown syntax highlight (Tokyo Night)
 *  - Enter to submit, Shift+Enter for newline
 *  - Auto-grow up to maxHeight, then internal scroll
 *  - Paste image -> upload via uploadFileWithPlaceholder
 *  - Drop file -> upload via uploadFileWithPlaceholder
 *  - Effort keyword highlight (ultrathink)
 *  - Disabled (read-only)
 *  - autoFocus on mount
 *  - Controlled value (re-syncs if external value diverges from doc)
 *
 * Mobile font-size: 15px. iOS does NOT auto-zoom on contentEditable, so
 * we're not bound by the 16px floor that affects the legacy textarea.
 */

import { useEffect, useRef, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { isMobileViewport } from '@/lib/utils'
import type { InputEditorProps } from '../../types'
import type { InputEditorController } from './create'

// Lazy load -- shared with file-editor.tsx
let factoryPromise: Promise<typeof import('./create')> | null = null
function loadFactory() {
  if (!factoryPromise) factoryPromise = import('./create')
  return factoryPromise
}

export function CodeMirrorBackend(props: InputEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<InputEditorController | null>(null)
  const [dragOver, setDragOver] = useState(false)

  // Latest-callback refs so the CM instance can call into fresh handlers
  // without rebuilding on every render.
  const onChangeRef = useRef(props.onChange)
  const onSubmitRef = useRef(props.onSubmit)
  onChangeRef.current = props.onChange
  onSubmitRef.current = props.onSubmit

  const sessionId = useSessionsStore(s => s.selectedSessionId)
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  // Mount/unmount the CM editor exactly once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional one-shot mount
  useEffect(() => {
    if (!containerRef.current) return
    let destroyed = false
    let cleanupPaste: (() => void) | undefined

    loadFactory().then(({ createInputEditor }) => {
      if (destroyed || !containerRef.current) return
      const controller = createInputEditor(containerRef.current, {
        initialValue: props.value,
        onChange: v => onChangeRef.current(v),
        onSubmit: () => onSubmitRef.current(),
        placeholder: props.placeholder,
        disabled: props.disabled,
        fontSize: isMobileViewport() ? 15 : 14,
        enableEffortKeywords: props.enableEffortKeywords,
        enableAutocomplete: props.enableAutocomplete,
      })
      controllerRef.current = controller

      // Lazy import paste-drop helpers (same chunk as factory)
      import('./paste-drop').then(({ attachPasteUpload }) => {
        if (destroyed) return
        cleanupPaste = attachPasteUpload(controller.view, () => sessionIdRef.current)
      })

      if (props.autoFocus) controller.focus()
    })

    return () => {
      destroyed = true
      cleanupPaste?.()
      controllerRef.current?.destroy()
      controllerRef.current = null
    }
  }, [])

  // Sync external value -> CM doc (controlled component contract)
  useEffect(() => {
    controllerRef.current?.setValue(props.value)
  }, [props.value])

  // Sync disabled state
  useEffect(() => {
    controllerRef.current?.setDisabled(!!props.disabled)
  }, [props.disabled])

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (!files?.length) return
    const view = controllerRef.current?.view
    if (!view) return
    import('./paste-drop').then(({ uploadDroppedFile }) => {
      for (const file of files) uploadDroppedFile(view, file, sessionIdRef.current)
    })
  }

  return (
    <div
      className={`relative w-full ${props.className ?? ''}`}
      onDragOver={e => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div ref={containerRef} className="w-full" />
      {dragOver && (
        <div className="absolute inset-0 border-2 border-dashed border-accent/60 bg-accent/5 pointer-events-none flex items-center justify-center">
          <span className="text-xs font-mono text-accent/80">Drop file here</span>
        </div>
      )}
    </div>
  )
}
