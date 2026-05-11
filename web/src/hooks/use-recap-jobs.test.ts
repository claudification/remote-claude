import type {
  RecapCompleteMessage,
  RecapCreatedMessage,
  RecapErrorMessage,
  RecapMeta,
  RecapPeriodLabel,
  RecapProgressMessage,
  RecapSummary,
} from '@shared/protocol'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { _internal, selectJobCount, selectVisibleJobs, useRecapJobsStore } from './use-recap-jobs'

function progress(overrides: Partial<RecapProgressMessage> = {}): RecapProgressMessage {
  return {
    type: 'recap_progress',
    recapId: 'recap_a',
    status: 'gathering',
    progress: 25,
    phase: 'gather/transcripts',
    ...overrides,
  }
}

function complete(overrides: Partial<RecapCompleteMessage> = {}): RecapCompleteMessage {
  const meta: RecapMeta = {
    recapId: 'recap_a',
    projectUri: 'claude://default/p',
    periodLabel: 'last_7' as RecapPeriodLabel,
    periodStart: 0,
    periodEnd: 1,
    timeZone: 'UTC',
    status: 'done',
    progress: 100,
    inputChars: 0,
    inputTokens: 0,
    outputTokens: 0,
    llmCostUsd: 0.04,
    title: 'Sample',
    subtitle: 'About things',
    model: 'anthropic/claude-haiku-4.5',
    createdAt: 0,
    completedAt: 1,
  }
  return {
    type: 'recap_complete',
    recapId: 'recap_a',
    title: 'Sample',
    markdown: '# x',
    meta,
    ...overrides,
  }
}

function created(recapId = 'recap_a'): RecapCreatedMessage & { projectUri?: string; periodLabel?: RecapPeriodLabel } {
  return { type: 'recap_created', recapId, cached: false, projectUri: 'claude://default/p', periodLabel: 'today' }
}

function failed(recapId = 'recap_a', err = 'OpenRouter 429'): RecapErrorMessage & { recapId?: string } {
  return { type: 'recap_error', error: err, recapId }
}

function summary(overrides: Partial<RecapSummary> = {}): RecapSummary {
  return {
    id: 'recap_b',
    projectUri: 'claude://default/p',
    periodLabel: 'today',
    periodStart: 0,
    periodEnd: 0,
    status: 'done',
    title: 'Old',
    subtitle: 'sub',
    createdAt: 0,
    completedAt: Date.now() - 1000,
    llmCostUsd: 0.01,
    progress: 100,
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  useRecapJobsStore.getState().reset()
})

afterEach(() => {
  useRecapJobsStore.getState().reset()
  vi.useRealTimers()
})

describe('useRecapJobsStore -- applyCreated', () => {
  test('inserts a queued job', () => {
    useRecapJobsStore.getState().applyCreated(created('recap_x'))
    const job = useRecapJobsStore.getState().jobs.recap_x
    expect(job).toBeDefined()
    expect(job.status).toBe('queued')
    expect(job.progress).toBe(0)
    expect(job.projectUri).toBe('claude://default/p')
  })

  test('does not overwrite an existing job', () => {
    useRecapJobsStore.getState().applyProgress(progress({ recapId: 'recap_x', status: 'rendering', progress: 80 }))
    useRecapJobsStore.getState().applyCreated(created('recap_x'))
    expect(useRecapJobsStore.getState().jobs.recap_x.status).toBe('rendering')
    expect(useRecapJobsStore.getState().jobs.recap_x.progress).toBe(80)
  })
})

describe('useRecapJobsStore -- applyProgress', () => {
  test('upserts and tracks status + progress + phase', () => {
    useRecapJobsStore.getState().applyProgress(progress())
    let job = useRecapJobsStore.getState().jobs.recap_a
    expect(job.status).toBe('gathering')
    expect(job.progress).toBe(25)
    expect(job.phase).toBe('gather/transcripts')
    useRecapJobsStore.getState().applyProgress(progress({ status: 'rendering', progress: 60, phase: 'render/llm' }))
    job = useRecapJobsStore.getState().jobs.recap_a
    expect(job.status).toBe('rendering')
    expect(job.progress).toBe(60)
    expect(job.phase).toBe('render/llm')
  })

  test('terminal status stamps finishedAtLocal', () => {
    useRecapJobsStore.getState().applyProgress(progress({ status: 'failed' }))
    const job = useRecapJobsStore.getState().jobs.recap_a
    expect(job.finishedAtLocal).toBeDefined()
  })
})

describe('useRecapJobsStore -- applyComplete', () => {
  test('marks done with metadata and queues auto-clear', () => {
    useRecapJobsStore.getState().applyProgress(progress())
    useRecapJobsStore.getState().applyComplete(complete())
    const job = useRecapJobsStore.getState().jobs.recap_a
    expect(job.status).toBe('done')
    expect(job.progress).toBe(100)
    expect(job.title).toBe('Sample')
    expect(job.model).toBe('anthropic/claude-haiku-4.5')
    expect(job.llmCostUsd).toBe(0.04)
    expect(job.subtitle).toBe('About things')

    // Flash window: still visible during the 3s flash
    vi.advanceTimersByTime(_internal.FLASH_MS - 50)
    expect(useRecapJobsStore.getState().jobs.recap_a).toBeDefined()
    // After the flash window the job is auto-removed
    vi.advanceTimersByTime(100)
    expect(useRecapJobsStore.getState().jobs.recap_a).toBeUndefined()
  })

  test('still works when no prior progress was seen', () => {
    useRecapJobsStore.getState().applyComplete(complete({ recapId: 'recap_z' }))
    const job = useRecapJobsStore.getState().jobs.recap_z
    expect(job.status).toBe('done')
  })
})

describe('useRecapJobsStore -- applyError', () => {
  test('sets failed status + error message', () => {
    useRecapJobsStore.getState().applyProgress(progress({ status: 'rendering', progress: 70 }))
    useRecapJobsStore.getState().applyError(failed('recap_a', 'OpenRouter 429'))
    const job = useRecapJobsStore.getState().jobs.recap_a
    expect(job.status).toBe('failed')
    expect(job.error).toBe('OpenRouter 429')
    expect(job.finishedAtLocal).toBeDefined()
  })

  test('ignores error message without recapId', () => {
    const before = Object.keys(useRecapJobsStore.getState().jobs).length
    useRecapJobsStore.getState().applyError({ type: 'recap_error', error: 'x' })
    expect(Object.keys(useRecapJobsStore.getState().jobs).length).toBe(before)
  })
})

describe('useRecapJobsStore -- syncFromList', () => {
  test('hydrates active + recent jobs only', () => {
    const recaps: RecapSummary[] = [
      summary({ id: 'r_active', status: 'gathering', progress: 30 }),
      summary({ id: 'r_recent_done', status: 'done', completedAt: Date.now() - 1000 }),
      summary({ id: 'r_old_done', status: 'done', completedAt: Date.now() - 2 * _internal.FAILED_VISIBLE_MS }),
      summary({ id: 'r_recent_fail', status: 'failed', completedAt: Date.now() - 1000, error: 'x' }),
      summary({ id: 'r_old_fail', status: 'failed', completedAt: Date.now() - 2 * _internal.FAILED_VISIBLE_MS }),
    ]
    useRecapJobsStore.getState().syncFromList(recaps)
    const ids = Object.keys(useRecapJobsStore.getState().jobs).sort()
    expect(ids).toEqual(['r_active', 'r_recent_done', 'r_recent_fail'])
  })
})

describe('useRecapJobsStore -- dismissFailed + removeJob', () => {
  test('dismissFailed flips dismissedAtLocal so the card hides', () => {
    useRecapJobsStore.getState().applyError(failed('recap_a'))
    useRecapJobsStore.getState().dismissFailed('recap_a')
    expect(useRecapJobsStore.getState().jobs.recap_a.dismissedAtLocal).toBeDefined()
  })

  test('removeJob deletes the entry', () => {
    useRecapJobsStore.getState().applyCreated(created('recap_a'))
    useRecapJobsStore.getState().removeJob('recap_a')
    expect(useRecapJobsStore.getState().jobs.recap_a).toBeUndefined()
  })
})

describe('selectVisibleJobs', () => {
  test('shows active jobs always', () => {
    useRecapJobsStore.getState().applyProgress(progress({ recapId: 'r_a', status: 'gathering', progress: 10 }))
    useRecapJobsStore.getState().applyProgress(progress({ recapId: 'r_b', status: 'rendering', progress: 70 }))
    expect(selectVisibleJobs(useRecapJobsStore.getState()).map(j => j.recapId).sort()).toEqual(['r_a', 'r_b'])
  })

  test('hides done jobs after the flash window', () => {
    useRecapJobsStore.getState().applyComplete(complete({ recapId: 'r_done' }))
    expect(selectJobCount(useRecapJobsStore.getState())).toBe(1)
    vi.advanceTimersByTime(_internal.FLASH_MS + 100)
    // The auto-clear timer also runs and removes from store, so even though
    // the selector would hide it, the entry is gone.
    expect(selectJobCount(useRecapJobsStore.getState())).toBe(0)
  })

  test('hides failed jobs once dismissed', () => {
    useRecapJobsStore.getState().applyError(failed('r_fail'))
    expect(selectJobCount(useRecapJobsStore.getState())).toBe(1)
    useRecapJobsStore.getState().dismissFailed('r_fail')
    expect(selectJobCount(useRecapJobsStore.getState())).toBe(0)
  })

  test('hides failed jobs once they exit the visible window', () => {
    useRecapJobsStore.getState().applyError(failed('r_fail'))
    expect(selectJobCount(useRecapJobsStore.getState())).toBe(1)
    vi.advanceTimersByTime(_internal.FAILED_VISIBLE_MS + 1000)
    expect(selectJobCount(useRecapJobsStore.getState())).toBe(0)
  })
})
