/**
 * Project Board - Kanban-style view for project tasks
 * Three columns: Open | In Progress | Done, plus collapsible Archive
 */

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Eye,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import type { ProjectTask } from '@/hooks/use-project'
import { type ProjectTaskMeta, type TaskStatus, useProject } from '@/hooks/use-project'
import { sendInput } from '@/hooks/use-sessions'
import { useKeyLayer } from '@/lib/key-layers'
import { cn, haptic } from '@/lib/utils'
import { Markdown } from './markdown'
import { MarkdownInput } from './markdown-input'

function taskAge(created: string): string {
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

function fuzzyScore(query: string, task: ProjectTaskMeta): number {
  if (!query) return 1
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return 1
  const title = task.title.toLowerCase()
  const body = (task.bodyPreview || '').toLowerCase()
  const tagStr = task.tags.join(' ').toLowerCase()
  let score = 0
  for (const term of terms) {
    const inTitle = title.includes(term)
    const inBody = body.includes(term)
    const inTags = tagStr.includes(term)
    if (!inTitle && !inBody && !inTags) return 0
    if (inTitle) score += 2
    if (inBody) score += 1
    if (inTags) score += 1
  }
  return score
}

export function TaskEditor({
  task,
  sessionId,
  onSave,
  onClose,
}: {
  task: ProjectTask
  sessionId: string
  onSave: (
    slug: string,
    status: TaskStatus,
    patch: { title?: string; body?: string; priority?: string; tags?: string[] },
  ) => Promise<unknown>
  onClose: () => void
}) {
  const [title, setTitle] = useState(task.title)
  const [body, setBody] = useState(task.body)
  const [status, setStatus] = useState<TaskStatus>(task.status)
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>(task.priority || 'medium')
  const [tags, setTags] = useState<string[]>(task.tags || [])
  const [tagInput, setTagInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(!body.trim())
  useKeyLayer({ Escape: () => onClose() }, { id: 'task-editor' })

  function addTag() {
    const t = tagInput.trim().toLowerCase()
    if (t && !tags.includes(t)) {
      setTags([...tags, t])
    }
    setTagInput('')
  }

  async function handleSave() {
    setSaving(true)
    await onSave(task.slug, status, { title, body, priority, tags })
    setSaving(false)
    haptic('success')
    onClose()
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop
    <div role="presentation" className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        className="relative w-full max-w-2xl bg-[#1a1b26] border border-[#33467c] shadow-2xl flex flex-col max-h-[80vh]"
        onClick={e => e.stopPropagation()}
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
            value={status}
            onChange={e => setStatus(e.target.value as TaskStatus)}
            className={cn(
              'text-[10px] font-mono bg-transparent border px-1 py-0.5 outline-none',
              status === 'open' && 'border-amber-500/50 text-amber-400',
              status === 'in-progress' && 'border-blue-500/50 text-blue-400',
              status === 'done' && 'border-emerald-500/50 text-emerald-400',
              status === 'archived' && 'border-[#33467c]/50 text-muted-foreground',
            )}
          >
            <option value="open">open</option>
            <option value="in-progress">in-progress</option>
            <option value="done">done</option>
            <option value="archived">archived</option>
          </select>
          <select
            value={priority}
            onChange={e => setPriority(e.target.value as 'low' | 'medium' | 'high')}
            className="text-[10px] font-mono bg-transparent border border-[#33467c]/50 text-muted-foreground px-1 py-0.5 outline-none"
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
          <span className="text-[9px] text-muted-foreground/40 font-mono">{taskAge(task.created)}</span>
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

        {/* Body - toggle between markdown view and edit */}
        <div className="flex items-center justify-between px-4 py-1 border-b border-[#33467c]/20 shrink-0">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono transition-colors',
                !editing ? 'text-accent' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Eye className="w-3 h-3" /> View
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono transition-colors',
                editing ? 'text-accent' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Pencil className="w-3 h-3" /> Edit
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {editing ? (
            <textarea
              value={body}
              onChange={e => setBody(e.target.value)}
              className="w-full h-full min-h-[200px] bg-transparent text-sm font-mono text-foreground outline-none resize-none placeholder:text-muted-foreground/30 leading-relaxed"
              placeholder="Task body (markdown)..."
            />
          ) : body.trim() ? (
            // biome-ignore lint/a11y/noStaticElementInteractions: click to edit
            <div
              className="text-sm text-foreground prose prose-invert prose-sm max-w-none cursor-text"
              onClick={() => setEditing(true)}
            >
              <Markdown>{body}</Markdown>
            </div>
          ) : (
            // biome-ignore lint/a11y/noStaticElementInteractions: click to edit
            <div
              className="text-sm text-muted-foreground/30 font-mono cursor-text min-h-[200px]"
              onClick={() => setEditing(true)}
            >
              Click to add content...
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-[#33467c]/50 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground/40 font-mono">{task.slug}.md</span>
            <button
              type="button"
              onClick={() => {
                const taskPath = `.rclaude/project/${status}/${task.slug}.md`
                const prompt = `Work on this task: ${taskPath}`
                sendInput(sessionId, prompt)
                haptic('success')
                onClose()
              }}
              className="px-2 py-0.5 text-[10px] font-bold font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
            >
              Work on this
            </button>
          </div>
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

function ProjectCard({
  task,
  onMove,
  onDelete,
  onArchive,
  onEdit,
}: {
  task: ProjectTaskMeta
  onMove: (slug: string, from: TaskStatus, to: TaskStatus) => void
  onDelete: (slug: string, status: TaskStatus) => void
  onArchive: (slug: string, from: TaskStatus) => void
  onEdit: (task: ProjectTaskMeta) => void
}) {
  const [showActions, setShowActions] = useState(false)
  const canMoveRight = task.status in NEXT_STATUS
  const canMoveLeft = task.status in PREV_STATUS

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `${task.status}/${task.slug}`,
    data: { slug: task.slug, status: task.status },
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
      onClick={() => !isDragging && onEdit(task)}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-mono text-foreground truncate flex items-center gap-1.5">
            <span className="truncate">{task.title}</span>
            {task.created && (
              <span className="text-[9px] text-muted-foreground/40 shrink-0">{taskAge(task.created)}</span>
            )}
          </div>
          {task.bodyPreview && (
            <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">{task.bodyPreview}</div>
          )}
          <div className="flex items-center gap-1 mt-1 flex-wrap">
            {task.priority && (
              <span className={cn('text-[9px] px-1 py-0.5 border font-mono', PRIORITY_COLORS[task.priority])}>
                {task.priority}
              </span>
            )}
            {task.tags.map(tag => (
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
                onMove(task.slug, task.status, PREV_STATUS[task.status])
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
                onMove(task.slug, task.status, NEXT_STATUS[task.status])
                setShowActions(false)
              }}
            >
              Next <ArrowRight className="w-3 h-3" />
            </button>
          )}
          {task.status !== 'archived' && (
            <button
              type="button"
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors font-mono"
              onClick={() => {
                haptic('tap')
                onArchive(task.slug, task.status)
                setShowActions(false)
              }}
            >
              <Archive className="w-3 h-3" /> Archive
            </button>
          )}
          <button
            type="button"
            className="ml-auto flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] text-red-400/60 hover:text-red-400 transition-colors font-mono"
            onClick={() => {
              haptic('error')
              onDelete(task.slug, task.status)
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
        + Add...
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
        placeholder="Description..."
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

export const ProjectBoard = memo(function ProjectBoard({ sessionId }: { sessionId: string }) {
  const { tasks, loading, refresh, createTask, moveTask, deleteTask, readTask, updateTask } = useProject(sessionId)
  const [editingTask, setEditingTask] = useState<ProjectTask | null>(null)
  const [activeDragTask, setActiveDragTask] = useState<ProjectTaskMeta | null>(null)
  const [archiveExpanded, setArchiveExpanded] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const filteredTasks = useMemo(() => {
    if (!searchQuery.trim()) return tasks
    return tasks.filter(n => fuzzyScore(searchQuery, n) > 0)
  }, [tasks, searchQuery])

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 5 } }),
  )

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as { slug: string; status: TaskStatus } | undefined
    if (!data) return
    const task = tasks.find(n => n.slug === data.slug && n.status === data.status)
    if (task) setActiveDragTask(task)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragTask(null)
    const { active, over } = event
    if (!over) return
    const targetStatus = over.id as TaskStatus
    const sourceData = active.data.current as { slug: string; status: TaskStatus } | undefined
    if (!sourceData || sourceData.status === targetStatus) return
    haptic('tap')
    moveTask(sourceData.slug, sourceData.status, targetStatus)
  }

  const handleCreate = useCallback(
    async (text: string) => {
      const lines = text.split('\n')
      const title = lines[0]
      const body = lines.length > 1 ? lines.slice(1).join('\n').trim() : text
      await createTask({ title, body })
    },
    [createTask],
  )

  const handleMove = useCallback(
    async (slug: string, from: TaskStatus, to: TaskStatus) => {
      await moveTask(slug, from, to)
    },
    [moveTask],
  )

  const handleDelete = useCallback(
    async (slug: string, status: TaskStatus) => {
      await deleteTask(slug, status)
    },
    [deleteTask],
  )

  const handleArchive = useCallback(
    async (slug: string, from: TaskStatus) => {
      await moveTask(slug, from, 'archived')
    },
    [moveTask],
  )

  const archivedTasks = filteredTasks.filter(n => n.status === 'archived')
  const activeTasks = filteredTasks.filter(n => n.status !== 'archived')

  if (loading && tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground/40 text-xs font-mono">Loading...</div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex flex-col border-b border-border shrink-0">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-bold text-foreground font-mono">Project</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={cn(
                'p-0.5 transition-colors',
                searchOpen ? 'text-accent' : 'text-muted-foreground/40 hover:text-muted-foreground',
              )}
              onClick={() => {
                haptic('tap')
                setSearchOpen(prev => {
                  if (!prev) {
                    requestAnimationFrame(() => searchRef.current?.focus())
                  } else {
                    setSearchQuery('')
                  }
                  return !prev
                })
              }}
            >
              <Search className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              className="text-[10px] text-muted-foreground hover:text-foreground font-mono"
              onClick={() => refresh()}
            >
              Refresh
            </button>
          </div>
        </div>
        {searchOpen && (
          <div className="flex items-center gap-2 px-3 pb-2">
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onFocus={() => haptic('tap')}
              placeholder="Filter..."
              className="flex-1 bg-[#1a1b26] border border-[#33467c]/40 px-2 py-1 text-xs font-mono text-foreground outline-none placeholder:text-muted-foreground/30 focus:border-accent/50"
            />
            {searchQuery && (
              <button
                type="button"
                className="text-muted-foreground/40 hover:text-muted-foreground"
                onClick={() => {
                  haptic('tap')
                  setSearchQuery('')
                  searchRef.current?.focus()
                }}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Kanban columns */}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex-1 min-h-0 overflow-hidden">
          <div className="flex gap-0 h-full">
            {COLUMNS.map(col => {
              const colTasks = activeTasks.filter(n => n.status === col.status)
              return (
                <DroppableColumn key={col.status} status={col.status}>
                  {/* Column header */}
                  <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2 shrink-0">
                    <span className={cn('text-[11px] font-bold font-mono uppercase tracking-wider', col.color)}>
                      {col.label}
                    </span>
                    <span className="text-[10px] text-muted-foreground/40 font-mono">{colTasks.length}</span>
                  </div>

                  {/* Cards */}
                  <div className="flex-1 overflow-y-auto space-y-0 pb-4">
                    {colTasks.map(task => (
                      <ProjectCard
                        key={task.slug}
                        task={task}
                        onMove={handleMove}
                        onDelete={handleDelete}
                        onArchive={handleArchive}
                        onEdit={async meta => {
                          const full = await readTask(meta.slug, meta.status)
                          if (full) setEditingTask(full)
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
        <DragOverlay dropAnimation={null}>
          {activeDragTask && (
            <div className="px-3 py-2 bg-[#1a1b26] border border-[#33467c]/60 shadow-xl opacity-90 max-w-[250px]">
              <div className="text-xs font-mono text-foreground truncate">{activeDragTask.title}</div>
              {activeDragTask.bodyPreview && (
                <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
                  {activeDragTask.bodyPreview}
                </div>
              )}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* Archived section - collapsible */}
      {archivedTasks.length > 0 && (
        <div className="border-t border-border shrink-0">
          <button
            type="button"
            className="w-full flex items-center gap-2 px-3 py-2 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            onClick={() => {
              haptic('tap')
              setArchiveExpanded(!archiveExpanded)
            }}
          >
            {archiveExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <Archive className="w-3 h-3" />
            <span className="text-[11px] font-mono uppercase tracking-wider">Archived</span>
            <span className="text-[10px] font-mono">{archivedTasks.length}</span>
          </button>
          {archiveExpanded && (
            <div className="max-h-[200px] overflow-y-auto border-t border-border/30">
              {archivedTasks.map(task => (
                <ProjectCard
                  key={task.slug}
                  task={task}
                  onMove={handleMove}
                  onDelete={handleDelete}
                  onArchive={handleArchive}
                  onEdit={async meta => {
                    const full = await readTask(meta.slug, meta.status)
                    if (full) setEditingTask(full)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Full-screen editor modal */}
      {editingTask && (
        <TaskEditor
          task={editingTask}
          sessionId={sessionId}
          onSave={async (slug, status, patch) => {
            await updateTask(slug, status, patch)
          }}
          onClose={() => setEditingTask(null)}
        />
      )}
    </div>
  )
})
