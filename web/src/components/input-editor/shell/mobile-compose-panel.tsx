/**
 * Full-viewport compose panel for mobile. Used by the CodeMirror backend
 * when the user focuses the editor on a mobile-sized viewport.
 *
 * Renders to a portal so it escapes any overflow:hidden / transform parents
 * and z-stacks above page chrome.
 *
 * Sizing follows the visualViewport so it sits above the on-screen keyboard
 * without being occluded by it (--vv-offset is set by useScrollLock).
 *
 * The panel itself doesn't own the editor -- the parent backend renders the
 * editor as children. That way the CM EditorView never unmounts when the
 * user toggles between inline and expanded, preserving cursor + selection.
 */

import { Send, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { haptic } from '@/lib/utils'

interface MobileComposePanelProps {
  visibleHeight: number | null
  children: ReactNode
  onClose: () => void
  onSubmit: () => void
  /** Disable the send button (e.g. while sending). */
  sendDisabled?: boolean
}

export function MobileComposePanel({
  visibleHeight,
  children,
  onClose,
  onSubmit,
  sendDisabled,
}: MobileComposePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const height = visibleHeight ? `${visibleHeight}px` : '100dvh'
  const top = visibleHeight ? 'var(--vv-offset, 0px)' : '0px'

  // Escape -> close
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  function handleSubmit() {
    haptic('tap')
    onSubmit()
    onClose()
  }

  return createPortal(
    <div
      ref={panelRef}
      data-mobile-compose-panel
      className="fixed inset-0 z-[999] flex flex-col bg-background"
      style={{ touchAction: 'manipulation', height, top }}
    >
      {/* Header: Done button collapses */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 shrink-0">
        <button
          type="button"
          onClick={() => {
            haptic('tap')
            onClose()
          }}
          className="flex items-center gap-1 text-xs font-mono text-muted-foreground hover:text-foreground p-1 -ml-1"
        >
          <X className="w-4 h-4" />
          Done
        </button>
        <button
          type="button"
          disabled={sendDisabled}
          onClick={handleSubmit}
          className="flex items-center gap-1.5 text-xs font-mono px-3 py-1.5 bg-accent text-accent-foreground rounded-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Send className="w-3.5 h-3.5" />
          Send
        </button>
      </div>
      {/* Editor area: caller renders the editor here */}
      <div className="flex-1 min-h-0 overflow-hidden p-3">{children}</div>
    </div>,
    document.body,
  )
}
