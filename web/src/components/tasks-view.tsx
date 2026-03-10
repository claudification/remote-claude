import { useEffect, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import type { ArchivedTaskGroup, TaskInfo } from '@/lib/types'
import { cn } from '@/lib/utils'

interface TasksViewProps {
  sessionId: string
  pendingCount: number
}

const statusColors: Record<string, string> = {
  pending: 'text-amber-400',
  in_progress: 'text-active',
  completed: 'text-emerald-400',
  deleted: 'text-muted-foreground line-through',
}

const statusLabels: Record<string, string> = {
  pending: 'PENDING',
  in_progress: 'IN PROGRESS',
  completed: 'DONE',
  deleted: 'DELETED',
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return formatTime(ts)
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${formatTime(ts)}`
}

function TaskRow({ task, onToggleDesc, expanded }: { task: TaskInfo; onToggleDesc: () => void; expanded: boolean }) {
  return (
    <div className="px-3 py-2 border-b border-border/50 hover:bg-muted/20 transition-colors">
      <div className="flex items-start gap-2">
        <span className="text-[10px] font-mono text-muted-foreground shrink-0">#{task.id}</span>
        <span className={cn('text-[10px] font-mono shrink-0', statusColors[task.status])}>
          {statusLabels[task.status] || task.status}
        </span>
        <span className="text-xs text-foreground flex-1 min-w-0">{task.subject}</span>
      </div>
      {task.description && task.description !== task.subject && (
        <div className="mt-1 ml-6 text-[11px] text-muted-foreground leading-tight">
          {expanded || task.description.length <= 200 ? task.description : `${task.description.slice(0, 200)}...`}
          {task.description.length > 200 && (
            <button type="button" onClick={onToggleDesc} className="ml-1 text-accent hover:text-accent/80 font-mono">
              {expanded ? '[less]' : '[more]'}
            </button>
          )}
        </div>
      )}
      {task.blockedBy && task.blockedBy.length > 0 && (
        <div className="mt-1 ml-6 text-[10px] text-red-400/70 font-mono">
          blocked by: {task.blockedBy.map(id => `#${id}`).join(', ')}
        </div>
      )}
      {task.blocks && task.blocks.length > 0 && (
        <div className="mt-1 ml-6 text-[10px] text-amber-400/70 font-mono">
          blocks: {task.blocks.map(id => `#${id}`).join(', ')}
        </div>
      )}
      {task.owner && <div className="mt-1 ml-6 text-[10px] text-muted-foreground font-mono">owner: {task.owner}</div>}
    </div>
  )
}

export function TasksView({ sessionId, pendingCount }: TasksViewProps) {
  const storeTasks = useSessionsStore(state => state.tasks[sessionId])
  const session = useSessionsStore(state => state.sessions.find(s => s.id === sessionId))
  const [initialTasks, setInitialTasks] = useState<TaskInfo[] | null>(null)
  const [expandedDescs, setExpandedDescs] = useState<Set<string>>(new Set())
  const [showArchived, setShowArchived] = useState(false)
  const [archivedGroups, setArchivedGroups] = useState<ArchivedTaskGroup[]>([])
  const [loadingArchived, setLoadingArchived] = useState(false)

  // Fetch initial tasks via HTTP
  useEffect(() => {
    let cancelled = false
    fetch(`/sessions/${sessionId}/tasks`)
      .then(res => (res.ok ? res.json() : { tasks: [] }))
      .then(data => {
        if (!cancelled) {
          // Handle both old format (array) and new format ({tasks, archivedTasks})
          setInitialTasks(Array.isArray(data) ? data : data.tasks || [])
        }
      })
      .catch(() => {
        if (!cancelled) setInitialTasks([])
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  // Fetch archived tasks on demand
  function fetchArchived() {
    if (loadingArchived) return
    setLoadingArchived(true)
    fetch(`/sessions/${sessionId}/tasks`)
      .then(res => (res.ok ? res.json() : { archivedTasks: [] }))
      .then(data => {
        setArchivedGroups(data.archivedTasks || [])
        setShowArchived(true)
      })
      .catch(() => setArchivedGroups([]))
      .finally(() => setLoadingArchived(false))
  }

  function toggleArchived() {
    if (showArchived) {
      setShowArchived(false)
    } else {
      fetchArchived()
    }
  }

  const tasks: TaskInfo[] = storeTasks || initialTasks || []
  const loading = !storeTasks && !initialTasks
  // Archived count from session summary (lightweight, pushed via WS)
  const totalArchived = session?.archivedTaskCount || 0

  if (loading) {
    return <div className="text-xs text-muted-foreground p-4">Loading tasks...</div>
  }

  if (tasks.length === 0 && totalArchived === 0) {
    return <div className="text-xs text-muted-foreground p-4">No tasks tracked for this session.</div>
  }

  const pending = tasks.filter(t => t.status === 'pending')
  const inProgress = tasks.filter(t => t.status === 'in_progress')
  const completed = tasks.filter(t => t.status === 'completed')
  const deleted = tasks.filter(t => t.status === 'deleted')

  const groups = [
    { label: 'In Progress', tasks: inProgress },
    { label: 'Pending', tasks: pending },
    { label: 'Completed', tasks: completed },
    { label: 'Deleted', tasks: deleted },
  ].filter(g => g.tasks.length > 0)

  function toggleDesc(taskId: string) {
    setExpandedDescs(prev => {
      const next = new Set(prev)
      next.has(taskId) ? next.delete(taskId) : next.add(taskId)
      return next
    })
  }

  return (
    <div className="overflow-y-auto h-full">
      {/* Summary bar */}
      <div className="sticky top-0 bg-background/95 backdrop-blur border-b border-border px-3 py-2 flex gap-4 text-[10px] font-mono">
        {pendingCount > 0 && <span className="text-amber-400">{pendingCount} pending</span>}
        {inProgress.length > 0 && <span className="text-active">{inProgress.length} active</span>}
        <span className="text-muted-foreground">{tasks.length} total</span>
        {totalArchived > 0 && (
          <button
            type="button"
            onClick={toggleArchived}
            className="text-muted-foreground/60 hover:text-muted-foreground transition-colors"
          >
            {loadingArchived ? '...' : `${totalArchived} archived`} {showArchived ? '\u25B4' : '\u25BE'}
          </button>
        )}
      </div>

      {/* Active tasks */}
      {groups.map(group => (
        <div key={group.label} className="mb-2">
          <div className="px-3 py-1.5 text-[10px] text-muted-foreground uppercase tracking-wider font-bold bg-muted/20">
            {group.label} ({group.tasks.length})
          </div>
          {group.tasks.map(task => (
            <TaskRow
              key={task.id}
              task={task}
              expanded={expandedDescs.has(task.id)}
              onToggleDesc={() => toggleDesc(task.id)}
            />
          ))}
        </div>
      ))}

      {/* Archived tasks - fetched on demand */}
      {showArchived && archivedGroups.length > 0 && (
        <div className="border-t border-border/50 mt-2">
          <div className="px-3 py-1.5 text-[10px] text-muted-foreground/60 uppercase tracking-wider font-bold bg-muted/10">
            Archived ({archivedGroups.reduce((s, g) => s + g.tasks.length, 0)})
          </div>
          {archivedGroups
            .slice()
            .sort((a, b) => b.archivedAt - a.archivedAt)
            .map((group, gi) => (
              <div key={group.archivedAt} className={cn(gi > 0 && 'border-t border-border/30')}>
                <div className="px-3 py-1 text-[9px] text-muted-foreground/40 font-mono">
                  archived {formatDate(group.archivedAt)}
                </div>
                {group.tasks.map(task => (
                  <TaskRow
                    key={`${group.archivedAt}-${task.id}`}
                    task={task}
                    expanded={expandedDescs.has(`a-${group.archivedAt}-${task.id}`)}
                    onToggleDesc={() => toggleDesc(`a-${group.archivedAt}-${task.id}`)}
                  />
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
