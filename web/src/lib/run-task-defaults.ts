/**
 * Persisted defaults for RunTaskDialog. Survives across dialog opens so the
 * user's last-used launch config is pre-populated next time.
 *
 * Stored in localStorage under `run-task-defaults`. Unknown keys are ignored
 * on load; missing keys fall back to hardcoded defaults below.
 */

type RunTaskDefaults = {
  model: string
  effort: string
  useWorktree: boolean
  autoCommit: boolean
  leaveRunning: boolean
  maxBudgetUsd: string
  timeout: string
}

const RUN_TASK_DEFAULTS: RunTaskDefaults = {
  model: '',
  effort: 'default',
  useWorktree: false,
  autoCommit: true,
  leaveRunning: true,
  maxBudgetUsd: '',
  timeout: '30',
}

const STORAGE_KEY = 'run-task-defaults'

export function loadRunTaskDefaults(): RunTaskDefaults {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...RUN_TASK_DEFAULTS, ...JSON.parse(raw) }
  } catch {}
  return RUN_TASK_DEFAULTS
}

export function saveRunTaskDefaults(defaults: RunTaskDefaults): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults))
  } catch {}
}
