/**
 * Task Board - Kanban-style view for structured task notes
 * Three columns: Open | In Progress | Done
 */

import {
  DndContext,
  type DragEndEvent,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { ArrowLeft, ArrowRight, MoreHorizontal, Trash2, X } from 'lucide-react'
import { memo, useCallback, useState } from 'react'
import type { TaskNote } from '@/hooks/use-task-notes'
import { type TaskNoteMeta, type TaskStatus, useTaskNotes } from '@/hooks/use-task-notes'
import { cn, haptic } from '@/lib/utils'
import { MarkdownInput } from './markdown-input'

function noteAge(created: string): string {
  if (!created) return ''
  const ms = Date.now() - new Date(created).getTime()
  if (ms < 0) return ''
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d`
  return `${Math.floor(days / 30)}mo`
}

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

// Rotating tag pill colors
const TAG_COLORS = [
  'bg-[#7aa2f7]/20 text-[#7aa2f7] border-[#7aa2f7]/30',
  'bg-[#bb9af7]/20 text-[#bb9af7] border-[#bb9af7]/30',
  'bg-[#2ac3de]/20 text-[#2ac3de] border-[#2ac3de]/30',
  'bg-[#9ece6a]/20 text-[#9ece6a] border-[#9ece6a]/30',
  'bg-[#e0af68]/20 text-[#e0af68] border-[#e0af68]/30',
  'bg-[#f7768e]/20 text-[#f7768e] border-[#f7768e]/30',
]

function tagColor(tag: string): string {
  let hash = 0
  for (const ch of tag) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length]
}

const PRIORITY_COLORS: Record<string, string> = {
  high: 'bg-red-500/20 text-red-400 border-red-500/30',
  medium: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  low: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
}

function NoteEditor({
  note,
  onSave,
  onClose,
}: {
  note: TaskNote
  onSave: (
    slug: string,
    status: TaskStatus,
    patch: { title?: string; body?: string; priority?: string; tags?: string[] },
  ) => Promise<unknown>
  onClose: () => void
}) {
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>(note.priority || 'medium')
  const [tags, setTags] = useState<string[]>(note.tags || [])
  const [tagInput, setTagInput] = useState('')
  const [saving, setSaving] = useState(false)

  function addTag() {
    const t = tagInput.trim().toLowerCase()
    if (t && !tags.includes(t)) {
      setTags([...tags, t])
    }
    setTagInput('')
  }

  async function handleSave() {
    setSaving(true)
    await onSave(note.slug, note.status, { title, body, priority, tags })
    setSaving(false)
    haptic('success')
    onClose()
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop
    <div
      role="presentation"
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      onClick={onClose}
      onKeyDown={e => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        className="relative w-full max-w-2xl bg-[#1a1b26] border border-[#33467c] shadow-2xl flex flex-col max-h-[80vh]"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.key === 'Escape') onClose()
          else e.stopPropagation()
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#33467c]/50 shrink-0">
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="flex-1 bg-transparent text-sm font-mono text-foreground outline-none placeholder:text-muted-foreground/30"
            placeholder="Title..."
          />
          <select
            value={priority}
            onChange={e => setPriority(e.target.value as 'low' | 'medium' | 'high')}
            className="text-[10px] font-mono bg-transparent border border-[#33467c]/50 text-muted-foreground px-1 py-0.5 outline-none"
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
          <span className="text-[9px] text-muted-foreground/40 font-mono">{noteAge(note.created)}</span>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground ml-1">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tags */}
        <div className="flex items-center gap-1 px-4 py-1.5 border-b border-[#33467c]/30 flex-wrap shrink-0">
          {tags.map(tag => (
            <span
              key={tag}
              className={cn('text-[9px] px-1.5 py-0.5 border font-mono flex items-center gap-1', tagColor(tag))}
            >
              {tag}
              <button type="button" className="hover:opacity-60" onClick={() => setTags(tags.filter(t => t !== tag))}>
                x
              </button>
            </span>
          ))}
          <input
            type="text"
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTag()
              }
              if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
                setTags(tags.slice(0, -1))
              }
            }}
            placeholder="add tag..."
            className="text-[10px] bg-transparent text-muted-foreground outline-none w-16 font-mono placeholder:text-muted-foreground/20"
          />
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            className="w-full h-full min-h-[200px] bg-transparent text-sm font-mono text-foreground outline-none resize-none placeholder:text-muted-foreground/30 leading-relaxed"
            placeholder="Note body (markdown)..."
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-[#33467c]/50 shrink-0">
          <span className="text-[10px] text-muted-foreground/40 font-mono">{note.slug}.md</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1 text-xs font-mono text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1 text-xs font-bold font-mono bg-accent/20 text-accent hover:bg-accent/30 transition-colors disabled:opacity-50"
            >
              {saving ? '...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function TaskCard({
  note,
  onMove,
  onDelete,
  onEdit,
}: {
  note: TaskNoteMeta
  onMove: (slug: string, from: TaskStatus, to: TaskStatus) => void
  onDelete: (slug: string, status: TaskStatus) => void
  onEdit: (note: TaskNoteMeta) => void
}) {
  const [showActions, setShowActions] = useState(false)
  const canMoveRight = note.status in NEXT_STATUS
  const canMoveLeft = note.status in PREV_STATUS

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `${note.status}/${note.slug}`,
    data: { slug: note.slug, status: note.status },
  })

  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group px-3 py-2 bg-[#1a1b26] border border-[#33467c]/30 hover:border-[#33467c]/60 transition-colors cursor-pointer',
        isDragging && 'opacity-50 z-50',
      )}
      onClick={() => !isDragging && onEdit(note)}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-mono text-foreground truncate flex items-center gap-1.5">
            <span className="truncate">{note.title}</span>
            {note.created && (
              <span className="text-[9px] text-muted-foreground/40 shrink-0">{noteAge(note.created)}</span>
            )}
          </div>
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
              <span key={tag} className={cn('text-[9px] px-1 py-0.5 border font-mono', tagColor(tag))}>
                {tag}
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 p-0.5 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
          onClick={e => {
            e.stopPropagation()
            haptic('tap')
            setShowActions(!showActions)
          }}
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>

      {showActions && (
        <div
          role="toolbar"
          className="flex items-center gap-1 mt-2 pt-2 border-t border-[#33467c]/20"
          onClick={e => e.stopPropagation()}
        >
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

function DroppableColumn({ status, children }: { status: TaskStatus; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex-1 min-w-0 flex flex-col border-r border-border last:border-r-0 transition-colors',
        isOver && 'bg-accent/5',
      )}
    >
      {children}
    </div>
  )
}

export const TaskBoard = memo(function TaskBoard({ sessionId }: { sessionId: string }) {
  const { notes, loading, refresh, createNote, moveNote, deleteNote, readNote, updateNote } = useTaskNotes(sessionId)
  const [editingNote, setEditingNote] = useState<TaskNote | null>(null)

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 5 } }),
  )

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const targetStatus = over.id as TaskStatus
    const sourceData = active.data.current as { slug: string; status: TaskStatus } | undefined
    if (!sourceData || sourceData.status === targetStatus) return
    haptic('tap')
    moveNote(sourceData.slug, sourceData.status, targetStatus)
  }

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
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="flex gap-0 min-h-full">
            {COLUMNS.map(col => {
              const colNotes = notes.filter(n => n.status === col.status)
              return (
                <DroppableColumn key={col.status} status={col.status}>
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
                      <TaskCard
                        key={note.slug}
                        note={note}
                        onMove={handleMove}
                        onDelete={handleDelete}
                        onEdit={async meta => {
                          const full = await readNote(meta.slug, meta.status)
                          if (full) setEditingNote(full)
                        }}
                      />
                    ))}

                    {col.status === 'open' && <InlineAdd onAdd={handleCreate} />}
                  </div>
                </DroppableColumn>
              )
            })}
          </div>
        </div>
      </DndContext>

      {/* Full-screen editor modal */}
      {editingNote && (
        <NoteEditor
          note={editingNote}
          onSave={async (slug, status, patch) => {
            await updateNote(slug, status, patch)
          }}
          onClose={() => setEditingNote(null)}
        />
      )}
    </div>
  )
})
