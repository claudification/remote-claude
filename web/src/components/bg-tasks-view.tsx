import { useEffect, useState } from 'react'
import { getBgTaskOutput, onBgTaskOutput, useConversationsStore } from '@/hooks/use-sessions'
import type { BgTaskSummary } from '@/lib/types'
import { cn, formatAge } from '@/lib/utils'
import { AnsiText } from './transcript/shared'

function StatusBadge({ status }: { status: BgTaskSummary['status'] }) {
  return (
    <span
      className={cn(
        'px-1.5 py-0.5 text-[10px] uppercase font-bold',
        status === 'running' && 'bg-emerald-400/20 text-emerald-400 border border-emerald-400/50',
        status === 'completed' && 'bg-muted text-muted-foreground border border-border',
        status === 'killed' && 'bg-red-400/20 text-red-400 border border-red-400/50',
      )}
    >
      {status}
    </span>
  )
}

function BgTaskOutputView({ taskId }: { taskId: string }) {
  const [output, setOutput] = useState(() => getBgTaskOutput(taskId))

  useEffect(() => {
    // Subscribe to output updates for this task
    return onBgTaskOutput(updatedTaskId => {
      if (updatedTaskId === taskId) {
        setOutput(getBgTaskOutput(taskId))
      }
    })
  }, [taskId])

  if (!output) return null

  return (
    <pre className="text-[10px] bg-black/30 p-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono mt-1.5 border-l-2 border-emerald-400/30">
      <AnsiText text={output} />
    </pre>
  )
}

const EMPTY_BG_TASKS: BgTaskSummary[] = []

export function BgTasksView({ sessionId }: { sessionId: string }) {
  const bgTasks = useConversationsStore(state => state.sessionsById[sessionId]?.bgTasks || EMPTY_BG_TASKS)

  if (bgTasks.length === 0) {
    return <div className="text-muted-foreground text-center py-10 text-xs">No background tasks</div>
  }

  const running = bgTasks.filter(t => t.status === 'running')
  const completed = bgTasks.filter(t => t.status === 'completed')
  const killed = bgTasks.filter(t => t.status === 'killed')

  function renderTask(task: BgTaskSummary) {
    return (
      <div key={task.taskId} className="border border-border p-3 space-y-1.5">
        <div className="flex items-center gap-2">
          <StatusBadge status={task.status} />
          <span className="text-[10px] text-muted-foreground font-mono">{task.taskId}</span>
          <span className="text-[10px] text-muted-foreground ml-auto">{formatAge(task.startedAt)}</span>
        </div>
        {task.description && <div className="text-xs text-foreground">{task.description}</div>}
        <div className="text-[11px] text-muted-foreground font-mono truncate">$ {task.command}</div>
        <BgTaskOutputView taskId={task.taskId} />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-3 sm:p-4 space-y-4">
      {/* Summary */}
      <div className="flex gap-3 text-xs">
        {running.length > 0 && <span className="text-emerald-400 font-bold">{running.length} running</span>}
        {completed.length > 0 && <span className="text-muted-foreground">{completed.length} completed</span>}
        {killed.length > 0 && <span className="text-red-400">{killed.length} killed</span>}
      </div>

      {/* Running */}
      {running.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] text-emerald-400 uppercase font-bold tracking-wider">Running</div>
          {running.map(renderTask)}
        </div>
      )}

      {/* Completed */}
      {completed.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Completed</div>
          {completed.map(renderTask)}
        </div>
      )}

      {/* Killed */}
      {killed.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] text-red-400 uppercase font-bold tracking-wider">Killed</div>
          {killed.map(renderTask)}
        </div>
      )}
    </div>
  )
}
