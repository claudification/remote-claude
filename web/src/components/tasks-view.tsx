import { useEffect, useState } from 'react'
import type { TaskInfo } from '@/lib/types'
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

export function TasksView({ sessionId, pendingCount }: TasksViewProps) {
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedDescs, setExpandedDescs] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false

    async function fetchTasks() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/sessions/${sessionId}/tasks`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (!cancelled) setTasks(data)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to fetch tasks')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchTasks()
    // Poll every 5s for updates
    const interval = setInterval(fetchTasks, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [sessionId])

  if (loading && tasks.length === 0) {
    return <div className="text-xs text-muted-foreground p-4">Loading tasks...</div>
  }

  if (error) {
    return <div className="text-xs text-red-400 p-4">Error: {error}</div>
  }

  if (tasks.length === 0) {
    return <div className="text-xs text-muted-foreground p-4">No tasks tracked for this session.</div>
  }

  // Group by status
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
      </div>

      {groups.map(group => (
        <div key={group.label} className="mb-2">
          <div className="px-3 py-1.5 text-[10px] text-muted-foreground uppercase tracking-wider font-bold bg-muted/20">
            {group.label} ({group.tasks.length})
          </div>
          {group.tasks.map(task => (
            <div key={task.id} className="px-3 py-2 border-b border-border/50 hover:bg-muted/20 transition-colors">
              <div className="flex items-start gap-2">
                <span className="text-[10px] font-mono text-muted-foreground shrink-0">#{task.id}</span>
                <span className={cn('text-[10px] font-mono shrink-0', statusColors[task.status])}>
                  {statusLabels[task.status] || task.status}
                </span>
                <span className="text-xs text-foreground flex-1 min-w-0">{task.subject}</span>
              </div>
              {task.description && task.description !== task.subject && (
                <div className="mt-1 ml-6 text-[11px] text-muted-foreground leading-tight">
                  {expandedDescs.has(task.id) || task.description.length <= 200
                    ? task.description
                    : `${task.description.slice(0, 200)}...`}
                  {task.description.length > 200 && (
                    <button
                      type="button"
                      onClick={() => toggleDesc(task.id)}
                      className="ml-1 text-accent hover:text-accent/80 font-mono"
                    >
                      {expandedDescs.has(task.id) ? '[less]' : '[more]'}
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
              {task.owner && (
                <div className="mt-1 ml-6 text-[10px] text-muted-foreground font-mono">owner: {task.owner}</div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
