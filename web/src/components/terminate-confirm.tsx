/**
 * TerminateConfirmDialog - Confirmation dialog before terminating a session.
 * Imperative API: call openTerminateConfirm(sessionId, sessionName) from anywhere.
 * Keyboard: Enter/Y = confirm, Escape/N = cancel.
 */

import { useEffect, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-sessions'
import { useKeyLayer } from '@/lib/key-layers'
import { haptic } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Kbd, KbdGroup } from './ui/kbd'

interface TerminateConfirmState {
  open: boolean
  sessionId: string | null
  sessionName: string | null
}

// Module-level imperative opener (same pattern as SpawnDialog)
let _open: ((sessionId: string, sessionName: string | null) => void) | null = null

export function openTerminateConfirm(sessionId: string, sessionName: string | null): void {
  _open?.(sessionId, sessionName)
}

export function TerminateConfirmDialog() {
  const [state, setState] = useState<TerminateConfirmState>({ open: false, sessionId: null, sessionName: null })
  const terminateSession = useConversationsStore(s => s.terminateSession)

  useEffect(() => {
    _open = (sessionId, sessionName) => {
      haptic('tap')
      setState({ open: true, sessionId, sessionName })
    }
    return () => {
      _open = null
    }
  }, [])

  function confirm() {
    if (state.sessionId) terminateSession(state.sessionId)
    haptic('error')
    setState({ open: false, sessionId: null, sessionName: null })
  }

  function cancel() {
    haptic('tap')
    setState({ open: false, sessionId: null, sessionName: null })
  }

  useKeyLayer(
    {
      Enter: confirm,
      y: confirm,
      n: cancel,
    },
    { id: 'terminate-confirm', enabled: state.open },
  )

  return (
    <Dialog open={state.open} onOpenChange={open => !open && cancel()}>
      <DialogContent className="font-mono max-w-sm p-0 overflow-hidden">
        <DialogTitle className="sr-only">Terminate session</DialogTitle>

        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <span className="text-destructive font-bold text-sm">TERMINATE</span>
          <span className="text-muted-foreground text-xs">session</span>
        </div>

        {/* Session name */}
        <div className="px-4 py-3 text-sm">
          <div className="text-foreground truncate">
            {state.sessionName ? (
              <>
                <span className="text-muted-foreground">session </span>
                <span className="text-yellow-400 font-bold">{state.sessionName}</span>
                <span className="text-muted-foreground"> will be terminated.</span>
              </>
            ) : (
              <span className="text-muted-foreground">This session will be terminated.</span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground/60 mt-1">Any running process will be killed.</div>
        </div>

        {/* Actions */}
        <div className="px-4 pb-4 flex items-center gap-3">
          <button
            type="button"
            onClick={confirm}
            className="flex-1 py-1.5 text-xs font-bold bg-destructive/20 border border-destructive/40 text-destructive hover:bg-destructive/30 transition-colors flex items-center justify-center gap-2"
          >
            Terminate
            <KbdGroup>
              <Kbd>Y</Kbd>
            </KbdGroup>
          </button>
          <button
            type="button"
            onClick={cancel}
            className="flex-1 py-1.5 text-xs text-muted-foreground border border-border hover:bg-muted/50 transition-colors flex items-center justify-center gap-2"
          >
            Cancel
            <KbdGroup>
              <Kbd>N</Kbd>
            </KbdGroup>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
