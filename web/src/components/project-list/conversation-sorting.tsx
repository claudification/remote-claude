import { useDroppable } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { ProjectOrderGroup, Session } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'

// ─── Sortable wrapper ──────────────────────────────────────────────

export function SortableNode({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={cn(isDragging && 'z-10 relative')}
    >
      {children}
    </div>
  )
}

export function NewGroupDropTarget() {
  const { isOver, setNodeRef } = useDroppable({ id: '__new_group__' })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'border-2 border-dashed rounded py-2 px-3 text-center text-[11px] font-mono transition-colors',
        isOver ? 'border-accent text-accent bg-accent/10' : 'border-border/50 text-muted-foreground/50',
      )}
    >
      + new group
    </div>
  )
}

// ─── Group node (collapsible folder) ───────────────────────────────

export function GroupNode({
  group,
  sessionsByCwd,
  collapsed,
  onToggle,
  onRename,
}: {
  group: ProjectOrderGroup
  sessionsByCwd: Map<string, Session[]>
  collapsed: boolean
  onToggle: () => void
  onRename: (newName: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus()
  }, [editing])

  // Live-session count only rendered when collapsed -- skip the filter otherwise.
  const childCount = collapsed
    ? group.children.filter(c => {
        if (c.type === 'project') {
          return sessionsByCwd.has(c.id)
        }
        return true
      }).length
    : 0

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        className="text-[10px] font-bold uppercase tracking-wider px-1 py-1 mb-1 flex items-center gap-1.5 cursor-pointer select-none text-primary/60"
        onClick={() => {
          haptic('tick')
          onToggle()
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            haptic('tick')
            onToggle()
          }
        }}
      >
        <span>{collapsed ? '\u25B8' : '\u25BE'}</span>
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            defaultValue={group.name}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            className="bg-transparent border-b border-primary text-primary text-[10px] font-bold uppercase outline-none flex-1"
            onBlur={e => {
              const v = e.currentTarget.value.trim()
              if (v && v !== group.name) onRename(v)
              setEditing(false)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const v = e.currentTarget.value.trim()
                if (v && v !== group.name) onRename(v)
                setEditing(false)
              }
              if (e.key === 'Escape') setEditing(false)
            }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span
            role="textbox"
            tabIndex={0}
            onDoubleClick={e => {
              e.stopPropagation()
              setEditing(true)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.stopPropagation()
                setEditing(true)
              }
            }}
          >
            {group.name}
          </span>
        )}
        {collapsed && <span className="text-muted-foreground/40 font-normal normal-case">({childCount})</span>}
        <span className="flex-1 h-px bg-border/50" />
      </div>
    </div>
  )
}
