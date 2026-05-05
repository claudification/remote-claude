import { useState } from 'react'
import { cn } from '@/lib/utils'
import { formatDuration } from './group-view-types'
import type { TaskNotification } from './grouping'

export function TaskNotificationLine({ notification: n, time }: { notification: TaskNotification; time: string }) {
  const [expanded, setExpanded] = useState(false)
  const statusColor =
    n.status === 'completed' ? 'bg-emerald-400' : n.status === 'killed' ? 'bg-amber-400' : 'bg-red-400'

  return (
    <div>
      <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
        <span className="text-[10px]">{time}</span>
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', statusColor)} />
        <span className="truncate flex-1">{n.summary}</span>
        {n.usage && (
          <span className="text-[9px] text-muted-foreground/60 shrink-0">
            {Math.round(n.usage.totalTokens / 1000)}K tok
            {' / '}
            {n.usage.toolUses} tools
            {' / '}
            {formatDuration(n.usage.durationMs)}
          </span>
        )}
        {n.result && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className={cn(
              'w-4 h-4 shrink-0 flex items-center justify-center rounded-full border text-[9px] font-bold transition-colors',
              expanded
                ? 'border-accent text-accent bg-accent/10'
                : 'border-muted-foreground/40 text-muted-foreground/60 hover:border-accent hover:text-accent',
            )}
            title="Show result"
          >
            i
          </button>
        )}
      </div>
      {expanded && n.result && (
        <pre className="text-[10px] font-mono text-foreground/70 mt-1 ml-6 pl-2 border-l border-muted-foreground/20 overflow-x-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
          {n.result}
        </pre>
      )}
    </div>
  )
}
