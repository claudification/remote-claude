/**
 * TerminateConfirmDialog - Confirmation dialog before terminating a conversation.
 * Imperative API: call openTerminateConfirm(conversationId, conversationName) from anywhere.
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
  conversationName: string | null
}

// Module-level imperative opener (same pattern as SpawnDialog)
let _open: ((conversationId: string, conversationName: string | null) => void) | null = null

export function openTerminateConfirm(conversationId: string, conversationName: string | null): void {
  _open?.(conversationId, conversationName)
}

export function TerminateConfirmDialog() {
  const [state, setState] = useState<TerminateConfirmState>({
    open: false,
    conversationId: null,
    conversationName: null,
  })
  const terminateConversation = useConversationsStore(s => s.terminateConversation)

  useEffect(() => {
    _open = (conversationId, conversationName) => {
      haptic('tap')
      setState({ open: true, conversationId, conversationName })
    }
    return () => {
      _open = null
    }
  }, [])

  function confirm() {
    if (state.conversationId) terminateConversation(state.conversationId, 'dashboard-terminate-dialog')
    haptic('error')
    setState({ open: false, conversationId: null, conversationName: null })
  }

  function cancel() {
    haptic('tap')
    setState({ open: false, conversationId: null, conversationName: null })
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
        <DialogTitle className="sr-only">Terminate conversation</DialogTitle>

        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <span className="text-destructive font-bold text-sm">TERMINATE</span>
          <span className="text-muted-foreground text-xs">conversation</span>
        </div>

        {/* Conversation name */}
        <div className="px-4 py-3 text-sm">
          <div className="text-foreground truncate">
            {state.conversationName ? (
              <>
                <span className="text-muted-foreground">conversation </span>
                <span className="text-yellow-400 font-bold">{state.conversationName}</span>
                <span className="text-muted-foreground"> will be terminated.</span>
              </>
            ) : (
              <span className="text-muted-foreground">This conversation will be terminated.</span>
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
