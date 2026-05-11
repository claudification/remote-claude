/**
 * Floating recap-jobs widget. Anchored to the bottom of the sidebar; grows
 * upward as jobs accumulate. Shows active jobs, recently completed (3s flash),
 * and failed jobs (visible 1h or until dismissed).
 *
 * Cards are clickable -- they open the recap viewer modal (Phase 10) by
 * dispatching a `rclaude-recap-open` CustomEvent. The widget itself is purely
 * presentational; all state lives in useRecapJobsStore.
 */

import { useEffect, useState } from 'react'
import { wsSend } from '@/hooks/use-conversations'
import { type RecapJob, selectVisibleJobs, useRecapJobsStore } from '@/hooks/use-recap-jobs'
import { cn, haptic } from '@/lib/utils'

const TICK_MS = 1000

function formatPhase(phase: string | undefined): string {
  if (!phase) return ''
  return phase
    .replace(/^gather\//, 'Gather: ')
    .replace(/^render\//, 'Render: ')
    .replace('persist', 'Persist')
}

function jobLabel(job: RecapJob): string {
  if (job.title) return job.title
  if (job.projectUri && job.projectUri !== '*') {
    const tail = job.projectUri.split('/').filter(Boolean).pop() || 'recap'
    return `Recap: ${tail}${job.periodLabel ? ` (${job.periodLabel})` : ''}`
  }
  if (job.projectUri === '*') return `Recap: all projects${job.periodLabel ? ` (${job.periodLabel})` : ''}`
  return `Recap ${job.recapId.slice(0, 12)}`
}

function ProgressBar({ value, status }: { value: number; status: RecapJob['status'] }) {
  const pct = Math.max(0, Math.min(100, value))
  const color =
    status === 'failed'
      ? 'bg-red-500'
      : status === 'cancelled'
        ? 'bg-zinc-400'
        : status === 'done'
          ? 'bg-green-500'
          : 'bg-cyan-500'
  return (
    <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
      <div className={cn('h-full transition-all', color)} style={{ width: `${pct}%` }} />
    </div>
  )
}

function JobCard({ job, onOpen }: { job: RecapJob; onOpen: (id: string) => void }) {
  const isFailed = job.status === 'failed'
  const isDone = job.status === 'done'
  const isActive = !isFailed && !isDone && job.status !== 'cancelled'

  function dismissOrCancel(e: React.MouseEvent) {
    e.stopPropagation()
    haptic('tap')
    if (isActive) {
      wsSend('recap_cancel', { recapId: job.recapId })
    } else if (isFailed) {
      useRecapJobsStore.getState().dismissFailed(job.recapId)
      wsSend('recap_dismiss_failed', { recapId: job.recapId })
    } else {
      useRecapJobsStore.getState().removeJob(job.recapId)
    }
  }

  return (
    <button
      type="button"
      onClick={() => {
        haptic('tap')
        onOpen(job.recapId)
      }}
      className={cn(
        'w-full text-left rounded-md border px-2 py-1.5 text-xs transition-colors',
        isFailed && 'border-red-500/50 bg-red-500/5 hover:bg-red-500/10',
        isDone && 'border-green-500/50 bg-green-500/5',
        isActive && 'border-border bg-card hover:bg-muted/50',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{jobLabel(job)}</div>
          {isFailed ? (
            <div className="text-red-400 mt-0.5 truncate" title={job.error}>
              {job.error || 'failed'}
            </div>
          ) : (
            <div className="text-muted-foreground mt-0.5 truncate">
              {isActive ? formatPhase(job.phase) : isDone ? 'done' : job.status}
              {job.model ? ` - ${job.model.split('/').pop()}` : ''}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={dismissOrCancel}
          className="text-muted-foreground hover:text-foreground shrink-0 px-1"
          title={isActive ? 'Cancel' : isFailed ? 'Dismiss' : 'Hide'}
        >
          ✕
        </button>
      </div>
      {isActive && (
        <div className="mt-1.5">
          <ProgressBar value={job.progress} status={job.status} />
        </div>
      )}
    </button>
  )
}

export function RecapJobsWidget() {
  const jobs = useRecapJobsStore(selectVisibleJobs)
  // Force re-render on a tick so failed-job auto-hide and done-flash windows
  // close on time even without new WS events.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (jobs.length === 0) return
    const t = setInterval(() => setTick(n => n + 1), TICK_MS)
    return () => clearInterval(t)
  }, [jobs.length])

  if (jobs.length === 0) return null

  function openRecap(recapId: string) {
    window.dispatchEvent(new CustomEvent('rclaude-recap-open', { detail: { recapId } }))
  }

  return (
    <div className="border-t border-border px-2 py-2 space-y-1.5 shrink-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground px-1">Recap jobs ({jobs.length})</div>
      {/* Newest first -- the column reads naturally bottom-up because the
          sidebar is height-limited and the widget anchors to the bottom. */}
      {jobs.map(job => (
        <JobCard key={job.recapId} job={job} onOpen={openRecap} />
      ))}
    </div>
  )
}
