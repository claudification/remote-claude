/**
 * TerminateConfirmDialog - Confirmation dialog before terminating a conversation.
 * Imperative API: call openTerminateConfirm(conversationId, sessionName) from anywhere.
 * Keyboard: Enter/Y = confirm, Escape/N = cancel.
 */

import { useEffect, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useKeyLayer } from '@/lib/key-layers'
import { haptic } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Kbd, KbdGroup } from './ui/kbd'

interface TerminateConfirmState {
  open: boolean
  conversationId: string | null
  sessionName: string | null
}

// Module-level imperative opener (same pattern as SpawnDialog)
let _open: ((conversationId: string, sessionName: string | null) => void) | null = null

export function openTerminateConfirm(conversationId: string, sessionName: string | null): void {
  _open?.(conversationId, sessionName)
}

export function TerminateConfirmDialog() {
  const [state, setState] = useState<TerminateConfirmState>({ open: false, conversationId: null, sessionName: null })
  const terminateConversation = useConversationsStore(s => s.terminateConversation)

  useEffect(() => {
    _open = (conversationId, sessionName) => {
      haptic('tap')
      setState({ open: true, conversationId, sessionName })
    }
    return () => {
      _open = null
    }
  }, [])

  function confirm() {
    if (state.conversationId) terminateConversation(state.conversationId)
    haptic('error')
    setState({ open: false, conversationId: null, sessionName: null })
  }

  function cancel() {
    haptic('tap')
    setState({ open: false, conversationId: null, sessionName: null })
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
