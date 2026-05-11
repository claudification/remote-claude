/**
 * Recap jobs store -- floating widget at bottom of sidebar.
 *
 * Tracks active period-recap jobs (queued/gathering/rendering), recently
 * completed ones (3s flash), and failed ones (visible for 1h unless
 * dismissed). The broker is the source of truth -- this store mirrors
 * recap_progress / recap_complete / recap_created / recap_error broadcasts
 * plus the initial recap_list_result hydration on mount.
 */

import type {
  RecapCompleteMessage,
  RecapCreatedMessage,
  RecapErrorMessage,
  RecapPeriodLabel,
  RecapProgressMessage,
  RecapStatus,
  RecapSummary,
} from '@shared/protocol'
import { create } from 'zustand'

const FLASH_MS = 3000
const FAILED_VISIBLE_MS = 60 * 60 * 1000

const ACTIVE_STATUSES: RecapStatus[] = ['queued', 'gathering', 'rendering']

export interface RecapJob {
  recapId: string
  projectUri?: string
  periodLabel?: RecapPeriodLabel
  status: RecapStatus
  progress: number
  phase: string
  title?: string
  subtitle?: string
  model?: string
  error?: string
  llmCostUsd?: number
  startedAt?: number
  completedAt?: number
  /** Local: when the job entered terminal state. Used for the 3s success flash
   *  and for cleaning up failed cards after FAILED_VISIBLE_MS. */
  finishedAtLocal?: number
  /** Local: ts when user clicked dismiss on a failed card. */
  dismissedAtLocal?: number
}

interface RecapJobsState {
  jobs: Record<string, RecapJob>
  applyProgress(msg: RecapProgressMessage): void
  applyComplete(msg: RecapCompleteMessage): void
  applyCreated(msg: RecapCreatedMessage & { projectUri?: string; periodLabel?: RecapPeriodLabel }): void
  applyError(msg: RecapErrorMessage & { recapId?: string }): void
  syncFromList(recaps: RecapSummary[]): void
  dismissFailed(recapId: string): void
  removeJob(recapId: string): void
  reset(): void
}

function isActive(status: RecapStatus): boolean {
  return ACTIVE_STATUSES.includes(status)
}

function summaryToJob(s: RecapSummary): RecapJob {
  return {
    recapId: s.id,
    projectUri: s.projectUri,
    periodLabel: s.periodLabel,
    status: s.status,
    progress: s.progress ?? 0,
    phase: s.phase ?? '',
    title: s.title,
    subtitle: s.subtitle,
    model: s.model,
    error: s.error,
    llmCostUsd: s.llmCostUsd,
    completedAt: s.completedAt,
    finishedAtLocal: s.status === 'done' || s.status === 'failed' ? s.completedAt : undefined,
  }
}

export const useRecapJobsStore = create<RecapJobsState>((set, get) => ({
  jobs: {},

  applyProgress(msg) {
    const existing = get().jobs[msg.recapId]
    const merged: RecapJob = {
      ...(existing ?? { recapId: msg.recapId, progress: 0, phase: '', status: 'queued' }),
      status: msg.status,
      progress: msg.progress,
      phase: msg.phase,
    }
    if (msg.status === 'done' || msg.status === 'failed' || msg.status === 'cancelled') {
      merged.finishedAtLocal = Date.now()
    }
    set({ jobs: { ...get().jobs, [msg.recapId]: merged } })
  },

  applyComplete(msg) {
    const existing = get().jobs[msg.recapId] ?? {
      recapId: msg.recapId,
      progress: 100,
      phase: 'done',
      status: 'done' as RecapStatus,
    }
    const merged: RecapJob = {
      ...existing,
      status: 'done',
      progress: 100,
      phase: 'done',
      title: msg.title,
      subtitle: msg.meta.subtitle,
      model: msg.meta.model,
      llmCostUsd: msg.meta.llmCostUsd,
      completedAt: msg.meta.completedAt,
      finishedAtLocal: Date.now(),
    }
    set({ jobs: { ...get().jobs, [msg.recapId]: merged } })
    // Auto-clear after the flash window so the widget collapses.
    setTimeout(() => {
      const cur = get().jobs[msg.recapId]
      if (cur && cur.status === 'done') get().removeJob(msg.recapId)
    }, FLASH_MS)
  },

  applyCreated(msg) {
    if (get().jobs[msg.recapId]) return
    const job: RecapJob = {
      recapId: msg.recapId,
      projectUri: msg.projectUri,
      periodLabel: msg.periodLabel,
      status: 'queued',
      progress: 0,
      phase: 'queued',
    }
    set({ jobs: { ...get().jobs, [msg.recapId]: job } })
  },

  applyError(msg) {
    const id = msg.recapId
    if (!id) return
    const existing = get().jobs[id] ?? { recapId: id, progress: 0, phase: 'failed', status: 'failed' as RecapStatus }
    const merged: RecapJob = {
      ...existing,
      status: 'failed',
      error: msg.error,
      finishedAtLocal: Date.now(),
    }
    set({ jobs: { ...get().jobs, [id]: merged } })
  },

  syncFromList(recaps) {
    const next: Record<string, RecapJob> = { ...get().jobs }
    for (const r of recaps) {
      // Only hydrate active or recently terminal jobs into the widget; older
      // completed ones live in the history modal, not the widget.
      const recent = r.completedAt && Date.now() - r.completedAt < FAILED_VISIBLE_MS
      if (isActive(r.status) || (r.status === 'failed' && recent) || (r.status === 'done' && recent)) {
        next[r.id] = { ...summaryToJob(r), ...(next[r.id] ?? {}) }
      }
    }
    set({ jobs: next })
  },

  dismissFailed(recapId) {
    const cur = get().jobs[recapId]
    if (!cur) return
    set({
      jobs: { ...get().jobs, [recapId]: { ...cur, dismissedAtLocal: Date.now() } },
    })
  },

  removeJob(recapId) {
    const next = { ...get().jobs }
    delete next[recapId]
    set({ jobs: next })
  },

  reset() {
    set({ jobs: {} })
  },
}))

// ─── Selectors (functions, not hooks -- callers pass into useStore) ────────

export function selectVisibleJobs(state: RecapJobsState): RecapJob[] {
  const now = Date.now()
  const all = Object.values(state.jobs)
  const visible = all.filter(j => {
    if (isActive(j.status)) return true
    if (j.status === 'done') {
      // Surface for the flash window after broker confirmed done.
      return j.finishedAtLocal != null && now - j.finishedAtLocal < FLASH_MS
    }
    if (j.status === 'failed') {
      if (j.dismissedAtLocal) return false
      return j.finishedAtLocal != null && now - j.finishedAtLocal < FAILED_VISIBLE_MS
    }
    return false
  })
  // Newest first so the bottom-anchored widget grows upward in chronological order.
  return visible.sort((a, b) => (b.finishedAtLocal ?? Number.POSITIVE_INFINITY) - (a.finishedAtLocal ?? Number.POSITIVE_INFINITY))
}

export function selectJobCount(state: RecapJobsState): number {
  return selectVisibleJobs(state).length
}

// Internal exports for tests.
export const _internal = { FLASH_MS, FAILED_VISIBLE_MS }
