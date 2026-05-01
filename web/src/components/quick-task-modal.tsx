/**
 * Quick Task Modal - Ctrl+Shift+N shortcut
 * Creates a project task in .rclaude/project/inbox/
 */

import { AlertTriangle, FileText } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useProject } from '@/hooks/use-project'
import { useConversationsStore } from '@/hooks/use-sessions'
import { useChordCommand, useCommand } from '@/lib/commands'
import { haptic } from '@/lib/utils'
import { InputEditor } from './input-editor'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Kbd, KbdGroup } from './ui/kbd'

export function QuickTaskModal() {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [flash, setFlash] = useState(false)

  const selectedSessionId = useConversationsStore(state => state.selectedSessionId)
  const session = useConversationsStore(state =>
    state.selectedSessionId ? state.sessionsById[state.selectedSessionId] : undefined,
  )
  const isActive = session != null && session.status !== 'ended'
  const hasWrapper = (session?.conversationIds?.length ?? 0) > 0

  const { createTask } = useProject(selectedSessionId && isActive ? selectedSessionId : null)

  // Open via command (registered here so it has access to selectedSessionId/isActive)
  useChordCommand(
    'quick-task',
    () => {
      if (selectedSessionId && isActive) {
        haptic('tap')
        setOpen(true)
      }
    },
    { label: 'Quick task', key: 'n', group: 'Navigation' },
  )

  // Also register direct Ctrl+Shift+N shortcut
  useCommand(
    'quick-task-direct',
    () => {
      if (selectedSessionId && isActive) {
        haptic('tap')
        setOpen(true)
      }
    },
    { label: 'Quick task', shortcut: 'ctrl+shift+n', group: 'Navigation' },
  )

  // Also listen for window event (from action FAB + command palette)
  useEffect(() => {
    function handleOpen() {
      if (selectedSessionId && isActive) {
        haptic('tap')
        setOpen(true)
      }
    }
    window.addEventListener('open-quick-task', handleOpen)
    return () => window.removeEventListener('open-quick-task', handleOpen)
  }, [selectedSessionId, isActive])

  // Radix Dialog handles Escape natively; clear text on close via onOpenChange.
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next)
    if (!next) setText('')
  }, [])

  const handleSubmit = useCallback(() => {
    if (!text.trim() || !hasWrapper) return
    haptic('tap')
    const lines = text.trim().split('\n')
    const title = lines[0]
    const body = lines.length > 1 ? lines.slice(1).join('\n').trim() : text.trim()

    // Log to console for recovery in case the WS relay fails
    console.log('[quick-task] Creating task:', JSON.stringify({ title, body, sessionId: selectedSessionId }))

    createTask({ title, body }).catch(err => {
      console.error('[quick-task] Failed to create task:', err, { title, body })
    })
    haptic('success')
    setText('')
    setOpen(false)
    setFlash(true)
    setTimeout(() => setFlash(false), 1000)
  }, [text, createTask, hasWrapper, selectedSessionId])

  return (
    <>
      {flash && !open && (
        <div className="fixed bottom-4 right-4 z-[100] px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/50 text-emerald-400 text-xs font-mono animate-pulse">
          Task created
        </div>
      )}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-lg max-h-[50vh] flex flex-col p-0 top-[15vh] translate-y-0">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
            <FileText className="w-4 h-4 text-accent" />
            <DialogTitle className="text-xs">Quick Task</DialogTitle>
            <span className="text-[10px] text-muted-foreground ml-1">project task</span>
          </div>
          {!hasWrapper && (
            <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span className="text-[10px] font-mono">No wrapper connected -- task cannot be delivered</span>
            </div>
          )}
          <div className="p-3 flex-1 min-h-0">
            <InputEditor
              value={text}
              onChange={setText}
              onSubmit={handleSubmit}
              placeholder="First line = title, rest = body... Shift+Enter for new line"
              autoFocus
              inline
            />
          </div>
          <div className="flex items-center justify-between px-3 py-2 border-t border-border shrink-0">
            <span className="text-[10px] text-muted-foreground flex items-center gap-1.5">
              <Kbd>↵</Kbd> add
              <span className="text-muted-foreground/40">·</span>
              <KbdGroup>
                <Kbd>⇧</Kbd>
                <Kbd>↵</Kbd>
              </KbdGroup>{' '}
              newline
              <span className="text-muted-foreground/40">·</span>
              <Kbd>Esc</Kbd> close
            </span>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!text.trim() || !hasWrapper}
              className="flex items-center gap-1.5 px-3 py-1 text-xs font-bold bg-accent/20 text-accent hover:bg-accent/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add
              <Kbd className="bg-accent/20 text-accent/70">↵</Kbd>
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
