import { ChevronDown, ChevronUp } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { DialogModal } from '@/components/dialog'
import { MarkdownInput } from '@/components/markdown-input'
import { sendInput, useSessionsStore } from '@/hooks/use-sessions'
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
      className="absolute bottom-22 right-3 z-50 w-8 h-8 flex items-center justify-center rounded-full bg-[#7aa2f7] text-[#1a1b26] shadow-lg shadow-[#7aa2f7]/20 hover:bg-[#89b4fa] transition-colors cursor-pointer"
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
  const [inputValue, setLocalInput] = useState(() => useSessionsStore.getState().inputDrafts[sessionId] ?? '')
  const [isSending, setIsSending] = useState(false)
  const [showAttention, setShowAttention] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef(inputValue)
  const sessionRef = useRef(sessionId)

  // Track pendingAttention with 15s delay before showing (PTY only - headless uses PermissionBanners)
  const pendingAttention = useSessionsStore(s => s.sessionsById[sessionId]?.pendingAttention)
  const sessionHasTerminal = useSessionsStore(s => {
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

  // Session switch: save old draft, restore new
  useEffect(() => {
    if (sessionRef.current !== sessionId) {
      useSessionsStore.getState().setInputDraft(sessionRef.current, inputRef.current)
      const restored = useSessionsStore.getState().inputDrafts[sessionId] ?? ''
      setLocalInput(restored)
      inputRef.current = restored
      sessionRef.current = sessionId
    }
  }, [sessionId])

  // Save draft on unmount
  useEffect(() => {
    return () => {
      useSessionsStore.getState().setInputDraft(sessionRef.current, inputRef.current)
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
    useSessionsStore.getState().setInputDraft(sessionId, '')
    setIsSending(true)
    const success = sendInput(sessionId, text)
    setIsSending(false)
    if (!success) {
      haptic('error')
      console.error('[input] sendInput failed for session', sessionId)
      // Restore on failure
      setInputValue(text)
      useSessionsStore.getState().setInputDraft(sessionId, text)
    } else {
      // Defensive re-clear (optimistic transcript entry now handled inside sendInput)
      setInputValue('')
      useSessionsStore.getState().setInputDraft(sessionId, '')
    }
    if (!isMobileViewport()) {
      requestAnimationFrame(() => containerRef.current?.querySelector('textarea')?.focus())
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
            const store = useSessionsStore.getState()
            if (store.selectedSessionId) store.openTab(store.selectedSessionId, 'tty')
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              haptic('tap')
              const store = useSessionsStore.getState()
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
        <MarkdownInput
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
              // No input - focus the textarea instead (useful on mobile to avoid Siri zone)
              containerRef.current?.querySelector('textarea')?.focus()
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
  const pending = useSessionsStore(s => s.pendingDialogs[sessionId] || EMPTY_EXPLORER)
  const submitDialog = useSessionsStore(s => s.submitDialog)
  const dismissDialog = useSessionsStore(s => s.dismissDialog)
  const keepaliveDialog = useSessionsStore(s => s.keepaliveDialog)

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
