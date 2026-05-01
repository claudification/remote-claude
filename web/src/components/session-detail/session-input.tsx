import { ChevronDown, ChevronUp } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { DialogModal } from '@/components/dialog'
import { InputEditor } from '@/components/input-editor'
import { sendInput, useConversationsStore } from '@/hooks/use-sessions'
import { focusInputEditor } from '@/lib/focus-input'
import { canTerminal } from '@/lib/types'
import { cn, haptic, isMobileViewport } from '@/lib/utils'

// ---------------------------------------------------------------------------
// ScrollToBottomButton
// ---------------------------------------------------------------------------

export function ScrollToBottomButton({
  onClick,
  direction = 'down',
}: {
  onClick: () => void
  direction?: 'down' | 'up'
}) {
  const Icon = direction === 'up' ? ChevronUp : ChevronDown
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-22 right-3 z-50 w-8 h-8 flex items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/80 transition-colors cursor-pointer"
      title={direction === 'up' ? 'Scroll to top' : 'Scroll to bottom'}
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}

// ---------------------------------------------------------------------------
// InputBar
// ---------------------------------------------------------------------------

// Isolated input bar - typing here does NOT rerender transcript/events
export const InputBar = memo(function InputBar({ sessionId }: { sessionId: string }) {
  const [inputValue, setLocalInput] = useState(() => useConversationsStore.getState().inputDrafts[sessionId] ?? '')
  const [isSending, setIsSending] = useState(false)
  const [showAttention, setShowAttention] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef(inputValue)
  const sessionRef = useRef(sessionId)

  // Track pendingAttention with 15s delay before showing (PTY only - headless uses PermissionBanners)
  const pendingAttention = useConversationsStore(s => s.sessionsById[sessionId]?.pendingAttention)
  const sessionHasTerminal = useConversationsStore(s => {
    const sess = s.sessionsById[sessionId]
    return sess ? canTerminal(sess) : false
  })
  useEffect(() => {
    if (!pendingAttention) {
      setShowAttention(false)
      return
    }
    // Show after 15s delay (permission/elicitation/ask might resolve quickly)
    const elapsed = Date.now() - pendingAttention.timestamp
    const remaining = Math.max(0, 15_000 - elapsed)
    const timer = setTimeout(() => setShowAttention(true), remaining)
    return () => clearTimeout(timer)
  }, [pendingAttention])

  function setInputValue(text: string) {
    setLocalInput(text)
    inputRef.current = text
  }

  // Session switch: save old draft, restore new, focus input (desktop only)
  useEffect(() => {
    if (sessionRef.current !== sessionId) {
      useConversationsStore.getState().setInputDraft(sessionRef.current, inputRef.current)
      const restored = useConversationsStore.getState().inputDrafts[sessionId] ?? ''
      setLocalInput(restored)
      inputRef.current = restored
      sessionRef.current = sessionId
      if (!isMobileViewport()) {
        requestAnimationFrame(() => containerRef.current && focusInputEditor(containerRef.current))
      }
    }
  }, [sessionId])

  // Save draft on unmount
  useEffect(() => {
    return () => {
      useConversationsStore.getState().setInputDraft(sessionRef.current, inputRef.current)
    }
  }, [])

  async function handleSend() {
    if (!inputValue.trim() || isSending) return
    const text = inputValue
    // Dashboard-only commands (not sent to CC)
    const trimmed = text.trim().toLowerCase()
    if (trimmed === '/settings' || trimmed === '/config') {
      haptic('tap')
      setInputValue('')
      window.dispatchEvent(new Event('open-settings'))
      return
    }
    haptic('tap')
    // Clear optimistically -- restore on failure
    setInputValue('')
    useConversationsStore.getState().setInputDraft(sessionId, '')
    setIsSending(true)
    const success = sendInput(sessionId, text)
    setIsSending(false)
    if (!success) {
      haptic('error')
      console.error('[input] sendInput failed for session', sessionId)
      // Restore on failure
      setInputValue(text)
      useConversationsStore.getState().setInputDraft(sessionId, text)
    } else {
      // Defensive re-clear (optimistic transcript entry now handled inside sendInput)
      setInputValue('')
      useConversationsStore.getState().setInputDraft(sessionId, '')
    }
    if (!isMobileViewport()) {
      requestAnimationFrame(() => containerRef.current && focusInputEditor(containerRef.current))
    }
  }

  return (
    <div
      ref={containerRef}
      className={cn('shrink-0 p-3 border-t bg-background z-10 transition-colors duration-200', 'border-border')}
    >
      {showAttention && pendingAttention && sessionHasTerminal && (
        <div
          role="button"
          tabIndex={0}
          className="mb-2 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded font-mono text-xs text-amber-400 flex items-center gap-2 animate-pulse cursor-pointer hover:bg-amber-500/20 transition-colors"
          onClick={() => {
            haptic('tap')
            const store = useConversationsStore.getState()
            if (store.selectedSessionId) store.openTab(store.selectedSessionId, 'tty')
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              haptic('tap')
              const store = useConversationsStore.getState()
              if (store.selectedSessionId) store.openTab(store.selectedSessionId, 'tty')
            }
          }}
        >
          <span className="text-amber-500 font-bold shrink-0">!</span>
          <span className="flex-1">
            {pendingAttention.type === 'permission' && (
              <>
                TTY needs permission for <span className="text-amber-200">{pendingAttention.toolName || 'tool'}</span>
                {pendingAttention.filePath && (
                  <>
                    {' '}
                    on <span className="text-amber-200">{pendingAttention.filePath.split('/').pop()}</span>
                  </>
                )}
              </>
            )}
            {pendingAttention.type === 'elicitation' && (
              <>
                TTY is asking a question
                {pendingAttention.question && (
                  <>
                    : <span className="text-amber-200">{pendingAttention.question.slice(0, 60)}</span>
                  </>
                )}
              </>
            )}
            {pendingAttention.type === 'ask' && <>TTY is waiting for your answer</>}
          </span>
          <span className="text-amber-500/60 shrink-0 text-[10px]">open terminal</span>
        </div>
      )}
      <div className="flex gap-2 items-stretch">
        <InputEditor
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSend}
          disabled={isSending}
          placeholder={isMobileViewport() ? 'Message...' : 'Enter to send, Shift+Enter for new line'}
          className="flex-1"
          autoFocus
          enableAutocomplete
          enableEffortKeywords
        />
        <button
          type="button"
          onClick={() => {
            if (inputValue.trim() && !isSending) {
              handleSend()
            } else {
              // No input - focus the editor instead (useful on mobile to avoid Siri zone)
              if (containerRef.current) focusInputEditor(containerRef.current)
            }
          }}
          disabled={isSending}
          className={cn(
            'shrink-0 px-4 py-2 text-xs font-bold font-mono border rounded transition-colors',
            inputValue.trim() && !isSending
              ? 'bg-accent text-accent-foreground border-accent hover:bg-accent/80'
              : 'bg-muted text-muted-foreground border-border cursor-not-allowed',
          )}
        >
          {isSending ? '...' : 'SEND'}
        </button>
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// DialogOverlay
// ---------------------------------------------------------------------------

const EMPTY_EXPLORER = undefined

export function DialogOverlay({ sessionId }: { sessionId: string }) {
  const pending = useConversationsStore(s => s.pendingDialogs[sessionId] || EMPTY_EXPLORER)
  const submitDialog = useConversationsStore(s => s.submitDialog)
  const dismissDialog = useConversationsStore(s => s.dismissDialog)
  const keepaliveDialog = useConversationsStore(s => s.keepaliveDialog)

  if (!pending) return null

  return (
    <DialogModal
      layout={pending.layout}
      onSubmit={result => submitDialog(sessionId, pending.dialogId, result)}
      onCancel={() => dismissDialog(sessionId, pending.dialogId)}
      onKeepalive={() => keepaliveDialog(sessionId, pending.dialogId)}
    />
  )
}
