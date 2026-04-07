/**
 * Task Board - Kanban-style view for structured task notes
 * Three columns: Open | In Progress | Done
 */

import { ArrowLeft, ArrowRight, MoreHorizontal, Trash2 } from 'lucide-react'
import { memo, useCallback, useState } from 'react'
import { type TaskNoteMeta, type TaskStatus, useTaskNotes } from '@/hooks/use-task-notes'
import { cn, haptic } from '@/lib/utils'
import { MarkdownInput } from './markdown-input'

const COLUMNS: { status: TaskStatus; label: string; color: string }[] = [
  { status: 'open', label: 'Open', color: 'text-[#7aa2f7]' },
  { status: 'in-progress', label: 'In Progress', color: 'text-[#e0af68]' },
  { status: 'done', label: 'Done', color: 'text-[#9ece6a]' },
]

const NEXT_STATUS: Record<string, TaskStatus> = {
  open: 'in-progress',
  'in-progress': 'done',
}
const PREV_STATUS: Record<string, TaskStatus> = {
  'in-progress': 'open',
  done: 'in-progress',
}

const PRIORITY_COLORS: Record<string, string> = {
  high: 'bg-red-500/20 text-red-400 border-red-500/30',
  medium: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  low: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
}

function TaskCard({
  note,
  onMove,
  onDelete,
}: {
  note: TaskNoteMeta
  onMove: (slug: string, from: TaskStatus, to: TaskStatus) => void
  onDelete: (slug: string, status: TaskStatus) => void
}) {
  const [showActions, setShowActions] = useState(false)
  const canMoveRight = note.status in NEXT_STATUS
  const canMoveLeft = note.status in PREV_STATUS

  return (
    <div className="group px-3 py-2 bg-[#1a1b26] border border-[#33467c]/30 hover:border-[#33467c]/60 transition-colors">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-mono text-foreground truncate">{note.title}</div>
          {note.bodyPreview && (
            <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">{note.bodyPreview}</div>
          )}
          <div className="flex items-center gap-1 mt-1 flex-wrap">
            {note.priority && (
              <span className={cn('text-[9px] px-1 py-0.5 border font-mono', PRIORITY_COLORS[note.priority])}>
                {note.priority}
              </span>
            )}
            {note.tags.map(tag => (
              <span key={tag} className="text-[9px] px-1 py-0.5 bg-[#33467c]/20 text-[#565f89] font-mono">
                {tag}
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 p-0.5 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
          onClick={() => {
            haptic('tap')
            setShowActions(!showActions)
          }}
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>

      {showActions && (
        <div className="flex items-center gap-1 mt-2 pt-2 border-t border-[#33467c]/20">
          {canMoveLeft && (
            <button
              type="button"
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors font-mono"
              onClick={() => {
                haptic('tap')
                onMove(note.slug, note.status, PREV_STATUS[note.status])
                setShowActions(false)
              }}
            >
              <ArrowLeft className="w-3 h-3" /> Back
            </button>
          )}
          {canMoveRight && (
            <button
              type="button"
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors font-mono"
              onClick={() => {
                haptic('tap')
                onMove(note.slug, note.status, NEXT_STATUS[note.status])
                setShowActions(false)
              }}
            >
              Next <ArrowRight className="w-3 h-3" />
            </button>
          )}
          <button
            type="button"
            className="ml-auto flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] text-red-400/60 hover:text-red-400 transition-colors font-mono"
            onClick={() => {
              haptic('error')
              onDelete(note.slug, note.status)
              setShowActions(false)
            }}
          >
            <Trash2 className="w-3 h-3" /> Delete
          </button>
        </div>
      )}
    </div>
  )
}

function InlineAdd({ onAdd }: { onAdd: (text: string) => void }) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')

  if (!adding) {
    return (
      <button
        type="button"
        className="w-full px-3 py-1.5 text-[10px] text-muted-foreground/40 hover:text-muted-foreground hover:bg-[#1a1b26]/50 transition-colors font-mono text-left"
        onClick={() => {
          haptic('tap')
          setAdding(true)
        }}
      >
        + Add task...
      </button>
    )
  }

  return (
    <div className="px-2 py-1.5 border-t border-[#33467c]/20">
      <MarkdownInput
        value={text}
        onChange={setText}
        onSubmit={() => {
          if (text.trim()) {
            haptic('success')
            onAdd(text.trim())
            setText('')
            setAdding(false)
          }
        }}
        placeholder="Task description..."
        autoFocus
        inline
      />
      <div className="flex items-center gap-2 mt-1">
        <button
          type="button"
          className="text-[10px] text-accent font-mono hover:text-accent/80"
          onClick={() => {
            if (text.trim()) {
              haptic('success')
              onAdd(text.trim())
              setText('')
              setAdding(false)
            }
          }}
        >
          Add
        </button>
        <button
          type="button"
          className="text-[10px] text-muted-foreground font-mono hover:text-foreground"
          onClick={() => {
            setAdding(false)
            setText('')
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export const TaskBoard = memo(function TaskBoard({ sessionId }: { sessionId: string }) {
  const { notes, loading, refresh, createNote, moveNote, deleteNote } = useTaskNotes(sessionId)

  const handleCreate = useCallback(
    async (text: string) => {
      // First line is title, rest is body
      const lines = text.split('\n')
      const title = lines[0]
      const body = lines.length > 1 ? lines.slice(1).join('\n').trim() : text
      await createNote({ title, body })
    },
    [createNote],
  )

  const handleMove = useCallback(
    async (slug: string, from: TaskStatus, to: TaskStatus) => {
      await moveNote(slug, from, to)
    },
    [moveNote],
  )

  const handleDelete = useCallback(
    async (slug: string, status: TaskStatus) => {
      await deleteNote(slug, status)
    },
    [deleteNote],
  )

  if (loading && notes.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground/40 text-xs font-mono">Loading...</div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-bold text-foreground font-mono">Task Notes</span>
        <button
          type="button"
          className="text-[10px] text-muted-foreground hover:text-foreground font-mono"
          onClick={() => refresh()}
        >
          Refresh
        </button>
      </div>

      {/* Kanban columns */}
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="flex gap-0 min-h-full">
          {COLUMNS.map(col => {
            const colNotes = notes.filter(n => n.status === col.status)
            return (
              <div key={col.status} className="flex-1 min-w-0 flex flex-col border-r border-border last:border-r-0">
                {/* Column header */}
                <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2 shrink-0">
                  <span className={cn('text-[11px] font-bold font-mono uppercase tracking-wider', col.color)}>
                    {col.label}
                  </span>
                  <span className="text-[10px] text-muted-foreground/40 font-mono">{colNotes.length}</span>
                </div>

                {/* Cards */}
                <div className="flex-1 overflow-y-auto space-y-0">
                  {colNotes.map(note => (
                    <TaskCard key={note.slug} note={note} onMove={handleMove} onDelete={handleDelete} />
                  ))}

                  {col.status === 'open' && <InlineAdd onAdd={handleCreate} />}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
})
