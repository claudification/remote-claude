import type { PeriodRecapStore, RecapLogLevel, RecapStatus } from './store'

export interface ProgressBroadcaster {
  broadcast(msg: ProgressMessage): void
}

export interface ProgressMessage {
  type: 'recap_progress'
  recapId: string
  status: RecapStatus
  progress: number
  phase: string
  log?: { level: RecapLogLevel; message: string; ts: number; data?: unknown }
}

export interface ProgressEmitter {
  emit(level: RecapLogLevel, phase: string, message: string, data?: unknown): void
  setProgress(progress: number, phase: string): void
  setStatus(status: RecapStatus): void
}

export interface ProgressEmitterOptions {
  recapId: string
  store: PeriodRecapStore
  broadcaster: ProgressBroadcaster
}

export function createProgressEmitter(opts: ProgressEmitterOptions): ProgressEmitter {
  let lastStatus: RecapStatus = 'queued'
  let lastProgress = 0
  let lastPhase = ''

  function persist(patch: { status?: RecapStatus; progress?: number; phase?: string }) {
    opts.store.update(opts.recapId, patch)
  }

  function broadcast(log?: ProgressMessage['log']) {
    opts.broadcaster.broadcast({
      type: 'recap_progress',
      recapId: opts.recapId,
      status: lastStatus,
      progress: lastProgress,
      phase: lastPhase,
      ...(log ? { log } : {}),
    })
  }

  return {
    emit(level, phase, message, data) {
      const ts = Date.now()
      opts.store.appendLog({ recapId: opts.recapId, timestamp: ts, level, phase, message, data })
      lastPhase = phase
      broadcast({ level, message, ts, data })
    },
    setProgress(progress, phase) {
      lastProgress = clampProgress(progress)
      lastPhase = phase
      persist({ progress: lastProgress, phase: lastPhase })
      broadcast()
    },
    setStatus(status) {
      lastStatus = status
      persist({ status })
      broadcast()
    },
  }
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}
