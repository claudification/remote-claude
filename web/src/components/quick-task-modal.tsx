/**
 * Quick Task Modal - Ctrl+Shift+N shortcut
 * Creates a project task in .rclaude/project/open/
 */

import { FileText, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useProject } from '@/hooks/use-project'
import { useSessionsStore } from '@/hooks/use-sessions'
import { useCommand } from '@/lib/commands'
import { useKeyLayer } from '@/lib/key-layers'
import { haptic } from '@/lib/utils'
import { MarkdownInput } from './markdown-input'

export function QuickTaskModal() {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [flash, setFlash] = useState(false)

  const selectedSessionId = useSessionsStore(state => state.selectedSessionId)
  const isActive = useSessionsStore(state => {
    const s = state.sessions.find(s => s.id === state.selectedSessionId)
    return s != null && s.status !== 'ended'
  })

  const { createTask } = useProject(selectedSessionId && isActive ? selectedSessionId : null)

  // Open via command (registered here so it has access to selectedSessionId/isActive)
  useCommand(
    'quick-task',
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

  // ESC closes when open
  useKeyLayer(
    {
      Escape: () => {
        setOpen(false)
        setText('')
      },
    },
    { id: 'quick-task', enabled: open },
  )

  const handleSubmit = useCallback(() => {
    if (!text.trim()) return
    haptic('tap')
    const lines = text.trim().split('\n')
    const title = lines[0]
    const body = lines.length > 1 ? lines.slice(1).join('\n').trim() : text.trim()
    createTask({ title, body }).catch(() => {})
    haptic('success')
    setText('')
    setOpen(false)
    setFlash(true)
    setTimeout(() => setFlash(false), 1000)
  }, [text, createTask])

  if (!open) {
    if (flash) {
      return (
        <div className="fixed bottom-4 right-4 z-[100] px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/50 text-emerald-400 text-xs font-mono animate-pulse">
          Task created
        </div>
      )
    }
    return null
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop overlay closes on click
    <div
      role="presentation"
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
      onKeyDown={e => {
        if (e.key === 'Escape') setOpen(false)
      }}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        role="dialog"
        className="relative w-full max-w-lg mx-4 bg-background border border-border shadow-2xl flex flex-col max-h-[50vh]"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            setOpen(false)
            setText('')
          } else {
            e.stopPropagation()
          }
        }}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <FileText className="w-4 h-4 text-accent" />
          <span className="text-xs font-bold text-foreground">Quick Task</span>
          <span className="text-[10px] text-muted-foreground ml-1">project task</span>
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
            placeholder="First line = title, rest = body... Shift+Enter for new line"
            autoFocus
            inline
          />
        </div>
        <div className="flex items-center justify-between px-3 py-2 border-t border-border shrink-0">
          <span className="text-[10px] text-muted-foreground">
            Enter to add, Shift+Enter for new line, Esc to close
          </span>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!text.trim()}
            className="px-3 py-1 text-xs font-bold bg-accent/20 text-accent hover:bg-accent/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  )
}
