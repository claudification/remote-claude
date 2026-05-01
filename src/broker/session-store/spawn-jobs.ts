import type { ServerWebSocket } from 'bun'
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
  jobId: string
  conversationId: string
  subscribers: Set<ServerWebSocket<unknown>>
  createdAt: number
  events: LaunchJobEvent[]
  completed: boolean
  failed: boolean
  error: string | null
  sessionId: string | null
  config: Record<string, unknown> | null
  endedAt: number | null
}

export interface SpawnJobDiagnostics {
  jobId: string
  conversationId: string
  sessionId: string | null
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
  createJob: (jobId: string, conversationId: string) => void
  recordJobConfig: (jobId: string, config: Record<string, unknown>) => void
  subscribeJob: (jobId: string, ws: ServerWebSocket<unknown>) => boolean
  unsubscribeJob: (jobId: string, ws: ServerWebSocket<unknown>) => void
  forwardJobEvent: (jobId: string, msg: Record<string, unknown>) => void
  completeJob: (conversationId: string, sessionId: string) => void
  failJob: (jobId: string, error: string) => void
  getJobByConversation: (conversationId: string) => string | undefined
  getJobDiagnostics: (jobId: string) => SpawnJobDiagnostics | null
  cleanupJobSubscriber: (ws: ServerWebSocket<unknown>) => void
}

export interface RendezvousInfo {
  callerSessionId: string
  action: string
}

export interface PendingRestartInfo {
  callerSessionId: string
  targetSessionId: string
  project: string
  isSelfRestart: boolean
}

export interface RendezvousRegistry {
  addRendezvous: (
    conversationId: string,
    callerSessionId: string,
    project: string,
    action: 'spawn' | 'revive' | 'restart',
  ) => Promise<ConversationSummary>
  resolveRendezvous: (
    conversationId: string,
    sessionId: string,
    toSessionSummary: (id: string) => ConversationSummary | undefined,
  ) => boolean
  getRendezvousInfo: (conversationId: string) => RendezvousInfo | undefined
  addPendingRestart: (conversationId: string, info: PendingRestartInfo) => void
  consumePendingRestart: (conversationId: string) => PendingRestartInfo | undefined
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
        if (job.conversationId) conversationToJob.delete(job.conversationId)
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
    createJob(jobId, conversationId) {
      const existing = launchJobs.get(jobId)
      if (existing) {
        existing.conversationId = conversationId
      } else {
        launchJobs.set(jobId, {
          jobId,
          conversationId,
          subscribers: new Set(),
          createdAt: Date.now(),
          events: [],
          completed: false,
          failed: false,
          error: null,
          sessionId: null,
          config: null,
          endedAt: null,
        })
      }
      conversationToJob.set(conversationId, jobId)
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
          conversationId: '',
          subscribers: new Set([ws]),
          createdAt: Date.now(),
          events: [],
          completed: false,
          failed: false,
          error: null,
          sessionId: null,
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

    completeJob(conversationId, sessionId) {
      const jobId = conversationToJob.get(conversationId)
      if (!jobId) return
      const job = launchJobs.get(jobId)
      if (!job) return
      job.completed = true
      job.sessionId = sessionId
      job.endedAt = Date.now()
      forwardJobEvent(jobId, { type: 'job_complete', jobId, sessionId, conversationId })
      setTimeout(() => {
        launchJobs.delete(jobId)
        conversationToJob.delete(conversationId)
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
          if (job.conversationId) conversationToJob.delete(job.conversationId)
        }, 30_000)
      }
    },

    getJobByConversation(conversationId) {
      return conversationToJob.get(conversationId)
    },

    getJobDiagnostics(jobId) {
      const job = launchJobs.get(jobId)
      if (!job) return null
      const now = Date.now()
      return {
        jobId: job.jobId,
        conversationId: job.conversationId,
        sessionId: job.sessionId,
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

  interface SessionRendezvous {
    callerSessionId: string
    conversationId: string
    project: string
    action: 'spawn' | 'revive' | 'restart'
    resolve: (session: ConversationSummary) => void
    reject: (error: string) => void
    timer: ReturnType<typeof setTimeout>
    registeredAt: number
  }

  const sessionRendezvous = new Map<string, SessionRendezvous>()
  const pendingRestarts = new Map<string, PendingRestartInfo>()

  return {
    addRendezvous(conversationId, callerSessionId, project, action) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          sessionRendezvous.delete(conversationId)
          reject(`Session did not connect within ${RENDEZVOUS_TIMEOUT_MS / 1000}s`)
          console.log(
            `[rendezvous] TIMEOUT: ${action} conversationId=${conversationId.slice(0, 8)} project=${extractProjectLabel(project)} caller=${callerSessionId.slice(0, 8)}`,
          )
        }, RENDEZVOUS_TIMEOUT_MS)

        sessionRendezvous.set(conversationId, {
          callerSessionId,
          conversationId,
          project,
          action,
          resolve,
          reject,
          timer,
          registeredAt: Date.now(),
        })
        console.log(
          `[rendezvous] REGISTERED: ${action} conversationId=${conversationId.slice(0, 8)} project=${extractProjectLabel(project)} caller=${callerSessionId.slice(0, 8)}`,
        )
      })
    },

    resolveRendezvous(conversationId, sessionId, toSessionSummary) {
      const rv = sessionRendezvous.get(conversationId)
      if (!rv) return false
      sessionRendezvous.delete(conversationId)
      clearTimeout(rv.timer)
      const summary = toSessionSummary(sessionId)
      if (!summary) {
        rv.reject('Session created but not found in store')
        return false
      }
      rv.resolve(summary)
      const elapsed = Date.now() - rv.registeredAt
      console.log(
        `[rendezvous] RESOLVED: ${rv.action} session=${sessionId.slice(0, 8)} conversationId=${conversationId.slice(0, 8)} elapsed=${elapsed}ms caller=${rv.callerSessionId.slice(0, 8)}`,
      )
      return true
    },

    getRendezvousInfo(conversationId) {
      const rv = sessionRendezvous.get(conversationId)
      if (!rv) return undefined
      return { callerSessionId: rv.callerSessionId, action: rv.action }
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
