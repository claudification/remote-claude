import type {
  PeriodRecapDoc,
  RecapLogEntry,
  RecapPeriodLabel,
  RecapSearchHit,
  RecapStatus,
  RecapSummary,
} from '../shared/protocol'
import { startRecap, type StartArgs, type StartResult } from './recap/period/orchestrator'
import type { ProgressBroadcaster } from './recap/period/progress'
import { createPeriodRecapStore, type PeriodRecapStore, type RecapRow } from './recap/period/store'
import type { StoreDriver } from './store/types'

let singleton: RecapOrchestrator | null = null

export interface RecapOrchestrator {
  start(args: StartArgs): Promise<StartResult>
  cancel(recapId: string): void
  dismiss(recapId: string): void
  list(filter: { projectUri?: string; status?: RecapStatus[]; limit?: number }): RecapSummary[]
  get(recapId: string, includeLogs: boolean): { recap: PeriodRecapDoc; logs?: RecapLogEntry[] } | null
  search(query: string, opts: { projectFilter?: string; limit?: number }): RecapSearchHit[]
  getMarkdown(recapId: string): string | null
  store: PeriodRecapStore
}

export interface InitOptions {
  cacheDir: string
  brokerStore: StoreDriver
  broadcaster: ProgressBroadcaster
}

export function initRecapOrchestrator(opts: InitOptions): RecapOrchestrator {
  const store = createPeriodRecapStore(opts.cacheDir)
  singleton = {
    start: args => startRecap({ store, brokerStore: opts.brokerStore, broadcaster: opts.broadcaster }, args),
    cancel(recapId: string) {
      const row = store.get(recapId)
      if (!row || row.status === 'done' || row.status === 'failed') return
      store.update(recapId, { status: 'cancelled' })
      opts.broadcaster.broadcast({
        type: 'recap_progress',
        recapId,
        status: 'cancelled',
        progress: row.progress,
        phase: 'cancelled',
      })
    },
    dismiss(recapId: string) {
      store.update(recapId, { dismissedAt: Date.now() })
    },
    list(filter) {
      return store.list(filter).map(rowToSummary)
    },
    get(recapId, includeLogs) {
      const row = store.get(recapId)
      if (!row) return null
      const recap = rowToDoc(row)
      if (!includeLogs) return { recap }
      return { recap, logs: store.getLogs(recapId) as RecapLogEntry[] }
    },
    search(query, opts) {
      return store
        .searchFts(query, { projectUri: opts.projectFilter, limit: opts.limit })
        .map(hit => ({
          id: hit.recapId,
          projectUri: hit.projectUri,
          periodLabel: 'custom' as RecapPeriodLabel,
          periodStart: 0,
          periodEnd: 0,
          title: '',
          subtitle: '',
          snippet: hit.snippet,
          score: hit.rank,
          createdAt: 0,
        }))
    },
    getMarkdown(recapId) {
      return store.get(recapId)?.markdown ?? null
    },
    store,
  }
  return singleton
}

export function getRecapOrchestrator(): RecapOrchestrator | null {
  return singleton
}

function rowToSummary(row: RecapRow): RecapSummary {
  return {
    id: row.id,
    projectUri: row.projectUri,
    periodLabel: row.periodLabel as RecapPeriodLabel,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    title: row.title ?? undefined,
    subtitle: row.subtitle ?? undefined,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? undefined,
    llmCostUsd: row.llmCostUsd,
    model: row.model ?? undefined,
    progress: row.progress,
    phase: row.phase ?? undefined,
    error: row.error ?? undefined,
  }
}

function rowToDoc(row: RecapRow): PeriodRecapDoc {
  return {
    recapId: row.id,
    projectUri: row.projectUri,
    periodLabel: row.periodLabel as RecapPeriodLabel,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    timeZone: row.timeZone,
    status: row.status,
    progress: row.progress,
    phase: row.phase ?? undefined,
    model: row.model ?? undefined,
    inputChars: row.inputChars,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    llmCostUsd: row.llmCostUsd,
    title: row.title ?? undefined,
    subtitle: row.subtitle ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    markdown: row.markdown ?? undefined,
  }
}
