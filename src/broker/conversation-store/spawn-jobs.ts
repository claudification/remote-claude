import type { ServerWebSocket } from 'bun'
import type { ConnectionId, ConversationId, JobId } from '../../shared/identity'
import { extractProjectLabel } from '../../shared/project-uri'
import type { ConversationSummary } from '../../shared/protocol'

interface LaunchJobEvent {
  type: string
  step?: string
  status?: string
  detail?: string | null
  t: number
}

interface LaunchJob {
  jobId: JobId
  connectionId: ConnectionId
  subscribers: Set<ServerWebSocket<unknown>>
  createdAt: number
  events: LaunchJobEvent[]
  completed: boolean
  failed: boolean
  error: string | null
  conversationId: ConversationId | null
  config: Record<string, unknown> | null
  endedAt: number | null
}

export interface SpawnJobDiagnostics {
  jobId: JobId
  connectionId: ConnectionId
  conversationId: ConversationId | null
  completed: boolean
  failed: boolean
  error: string | null
  createdAt: number
  endedAt: number | null
  elapsedMs: number
  config: Record<string, unknown> | null
  events: LaunchJobEvent[]
}

const JOB_EXPIRY_MS = 5 * 60 * 1000

export interface SpawnJobRegistry {
  createJob: (jobId: JobId, connectionId: ConnectionId) => void
  recordJobConfig: (jobId: JobId, config: Record<string, unknown>) => void
  subscribeJob: (jobId: JobId, ws: ServerWebSocket<unknown>) => boolean
  unsubscribeJob: (jobId: JobId, ws: ServerWebSocket<unknown>) => void
  forwardJobEvent: (jobId: JobId, msg: Record<string, unknown>) => void
  completeJob: (connectionId: ConnectionId, conversationId: ConversationId) => void
  failJob: (jobId: JobId, error: string) => void
  getJobByConversation: (connectionId: ConnectionId) => JobId | undefined
  getJobDiagnostics: (jobId: JobId) => SpawnJobDiagnostics | null
  cleanupJobSubscriber: (ws: ServerWebSocket<unknown>) => void
}

export interface RendezvousInfo {
  callerConversationId: string
  action: string
}

export interface PendingRestartInfo {
  callerConversationId: string
  targetConversationId: string
  project: string
  isSelfRestart: boolean
}

export interface RendezvousRegistry {
  addRendezvous: (
    connectionId: ConnectionId,
    callerConversationId: ConversationId,
    project: string,
    action: 'spawn' | 'revive' | 'restart',
  ) => Promise<ConversationSummary>
  resolveRendezvous: (
    connectionId: ConnectionId,
    conversationId: ConversationId,
    toConversationSummary: (id: ConversationId) => ConversationSummary | undefined,
  ) => boolean
  getRendezvousInfo: (connectionId: ConnectionId) => RendezvousInfo | undefined
  addPendingRestart: (connectionId: ConnectionId, info: PendingRestartInfo) => void
  consumePendingRestart: (connectionId: ConnectionId) => PendingRestartInfo | undefined
}

export function createSpawnJobRegistry(): SpawnJobRegistry {
  const launchJobs = new Map<string, LaunchJob>()
  const conversationToJob = new Map<string, string>()

  // Periodic cleanup
  setInterval(() => {
    const now = Date.now()
    for (const [jobId, job] of launchJobs) {
      if (now - job.createdAt > JOB_EXPIRY_MS) {
        launchJobs.delete(jobId)
        if (job.connectionId) conversationToJob.delete(job.connectionId)
      }
    }
  }, 60_000)

  function forwardJobEvent(jobId: string, msg: Record<string, unknown>): void {
    const job = launchJobs.get(jobId)
    if (!job) return
    const t = typeof msg.t === 'number' ? msg.t : Date.now()
    job.events.push({
      type: String(msg.type ?? 'unknown'),
      step: typeof msg.step === 'string' ? msg.step : undefined,
      status: typeof msg.status === 'string' ? msg.status : undefined,
      detail: typeof msg.detail === 'string' ? msg.detail : msg.detail === null ? null : undefined,
      t,
    })
    const payload = JSON.stringify(msg)
    for (const ws of job.subscribers) {
      try {
        ws.send(payload)
      } catch {}
    }
  }

  return {
    createJob(jobId, connectionId) {
      const existing = launchJobs.get(jobId)
      if (existing) {
        existing.connectionId = connectionId
      } else {
        launchJobs.set(jobId, {
          jobId,
          connectionId,
          subscribers: new Set(),
          createdAt: Date.now(),
          events: [],
          completed: false,
          failed: false,
          error: null,
          conversationId: null,
          config: null,
          endedAt: null,
        })
      }
      conversationToJob.set(connectionId, jobId)
    },

    recordJobConfig(jobId, config) {
      const job = launchJobs.get(jobId)
      if (job) job.config = config
    },

    subscribeJob(jobId, ws) {
      const job = launchJobs.get(jobId)
      if (!job) {
        launchJobs.set(jobId, {
          jobId,
          connectionId: '',
          subscribers: new Set([ws]),
          createdAt: Date.now(),
          events: [],
          completed: false,
          failed: false,
          error: null,
          conversationId: null,
          config: null,
          endedAt: null,
        })
        return true
      }
      job.subscribers.add(ws)
      return true
    },

    unsubscribeJob(jobId, ws) {
      const job = launchJobs.get(jobId)
      if (job) job.subscribers.delete(ws)
    },

    forwardJobEvent,

    completeJob(connectionId, conversationId) {
      const jobId = conversationToJob.get(connectionId)
      if (!jobId) return
      const job = launchJobs.get(jobId)
      if (!job) return
      job.completed = true
      job.conversationId = conversationId
      job.endedAt = Date.now()
      forwardJobEvent(jobId, { type: 'job_complete', jobId, conversationId, connectionId })
      setTimeout(() => {
        launchJobs.delete(jobId)
        conversationToJob.delete(connectionId)
      }, 30_000)
    },

    failJob(jobId, error) {
      const job = launchJobs.get(jobId)
      if (job) {
        job.failed = true
        job.error = error
        job.endedAt = Date.now()
      }
      forwardJobEvent(jobId, { type: 'job_failed', jobId, error })
      if (job) {
        setTimeout(() => {
          launchJobs.delete(jobId)
          if (job.connectionId) conversationToJob.delete(job.connectionId)
        }, 30_000)
      }
    },

    getJobByConversation(connectionId) {
      return conversationToJob.get(connectionId)
    },

    getJobDiagnostics(jobId) {
      const job = launchJobs.get(jobId)
      if (!job) return null
      const now = Date.now()
      return {
        jobId: job.jobId,
        connectionId: job.connectionId,
        conversationId: job.conversationId,
        completed: job.completed,
        failed: job.failed,
        error: job.error,
        createdAt: job.createdAt,
        endedAt: job.endedAt,
        elapsedMs: (job.endedAt ?? now) - job.createdAt,
        config: job.config,
        events: job.events,
      }
    },

    cleanupJobSubscriber(ws) {
      for (const job of launchJobs.values()) {
        job.subscribers.delete(ws)
      }
    },
  }
}

export function createRendezvousRegistry(): RendezvousRegistry {
  const RENDEZVOUS_TIMEOUT_MS = 120_000

  interface ConversationRendezvous {
    callerConversationId: string
    conversationId: string
    project: string
    action: 'spawn' | 'revive' | 'restart'
    resolve: (session: ConversationSummary) => void
    reject: (error: string) => void
    timer: ReturnType<typeof setTimeout>
    registeredAt: number
  }

  const conversationRendezvous = new Map<string, ConversationRendezvous>()
  const pendingRestarts = new Map<string, PendingRestartInfo>()

  return {
    addRendezvous(conversationId, callerConversationId, project, action) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          conversationRendezvous.delete(conversationId)
          reject(`Session did not connect within ${RENDEZVOUS_TIMEOUT_MS / 1000}s`)
          console.log(
            `[rendezvous] TIMEOUT: ${action} conversationId=${conversationId.slice(0, 8)} project=${extractProjectLabel(project)} caller=${callerConversationId.slice(0, 8)}`,
          )
        }, RENDEZVOUS_TIMEOUT_MS)

        conversationRendezvous.set(conversationId, {
          callerConversationId,
          conversationId,
          project,
          action,
          resolve,
          reject,
          timer,
          registeredAt: Date.now(),
        })
        console.log(
          `[rendezvous] REGISTERED: ${action} conversationId=${conversationId.slice(0, 8)} project=${extractProjectLabel(project)} caller=${callerConversationId.slice(0, 8)}`,
        )
      })
    },

    resolveRendezvous(connectionId, conversationId, toConversationSummary) {
      const rv = conversationRendezvous.get(connectionId)
      if (!rv) return false
      conversationRendezvous.delete(connectionId)
      clearTimeout(rv.timer)
      const summary = toConversationSummary(conversationId)
      if (!summary) {
        rv.reject('Conversation created but not found in store')
        return false
      }
      rv.resolve(summary)
      const elapsed = Date.now() - rv.registeredAt
      console.log(
        `[rendezvous] RESOLVED: ${rv.action} conversation=${conversationId.slice(0, 8)} connection=${connectionId.slice(0, 8)} elapsed=${elapsed}ms caller=${rv.callerConversationId.slice(0, 8)}`,
      )
      return true
    },

    getRendezvousInfo(conversationId) {
      const rv = conversationRendezvous.get(conversationId)
      if (!rv) return undefined
      return { callerConversationId: rv.callerConversationId, action: rv.action }
    },

    addPendingRestart(conversationId, info) {
      pendingRestarts.set(conversationId, info)
      console.log(
        `[restart] PENDING: target=${conversationId.slice(0, 8)} project=${extractProjectLabel(info.project)} self=${info.isSelfRestart}`,
      )
    },

    consumePendingRestart(conversationId) {
      const info = pendingRestarts.get(conversationId)
      if (info) {
        pendingRestarts.delete(conversationId)
        console.log(
          `[restart] CONSUMED: target=${conversationId.slice(0, 8)} project=${extractProjectLabel(info.project)}`,
        )
      }
      return info
    },
  }
}
