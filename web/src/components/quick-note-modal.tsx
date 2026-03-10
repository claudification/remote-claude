/**
 * Quick Note Modal - Ctrl+Shift+N shortcut
 * Appends a task item to CWD/NOTES.md
 */

import { FileText, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useFileEditor } from '@/hooks/use-file-editor'
import { useSessionsStore } from '@/hooks/use-sessions'
import { MarkdownInput } from './markdown-input'

export function QuickNoteModal() {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [flash, setFlash] = useState(false)

  const selectedSessionId = useSessionsStore(state => state.selectedSessionId)
  const sessions = useSessionsStore(state => state.sessions)
  const session = sessions.find(s => s.id === selectedSessionId)
  const isActive = session?.status === 'active' || session?.status === 'idle'

  const { appendQuickNote } = useFileEditor(selectedSessionId && isActive ? selectedSessionId : null)

  // Global keyboard shortcut
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.shiftKey && e.key === 'N') {
        e.preventDefault()
        if (selectedSessionId && isActive) {
          setOpen(true)
        }
      }
      if (e.key === 'Escape' && open) {
        setOpen(false)
        setText('')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, selectedSessionId, isActive])

  const handleSubmit = useCallback(async () => {
    if (!text.trim() || sending) return
    setSending(true)
    try {
      await appendQuickNote(text.trim())
      setText('')
      setOpen(false)
      setFlash(true)
      setTimeout(() => setFlash(false), 1000)
    } catch {
      // Error handled in hook
    } finally {
      setSending(false)
    }
  }, [text, sending, appendQuickNote])

  if (!open) {
    if (flash) {
      return (
        <div className="fixed bottom-4 right-4 z-[100] px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/50 text-emerald-400 text-xs font-mono animate-pulse">
          Note added to NOTES.md
        </div>
      )
    }
    return null
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg mx-4 bg-background border border-border shadow-2xl flex flex-col max-h-[50vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <FileText className="w-4 h-4 text-accent" />
          <span className="text-xs font-bold text-foreground">Quick Note</span>
          <span className="text-[10px] text-muted-foreground ml-1">NOTES.md</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-3 flex-1 min-h-0">
          <MarkdownInput
            value={text}
            onChange={setText}
            onSubmit={handleSubmit}
            disabled={sending}
            placeholder="Type a note (creates - [ ] item)... Shift+Enter for new line"
            autoFocus
          />
        </div>
        <div className="flex items-center justify-between px-3 py-2 border-t border-border shrink-0">
          <span className="text-[10px] text-muted-foreground">Enter to add, Shift+Enter for new line, Esc to close</span>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!text.trim() || sending}
            className="px-3 py-1 text-xs font-bold bg-accent/20 text-accent hover:bg-accent/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? '...' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}
