/**
 * Host agent (sentinel) handlers: agent identification, spawn/revive results,
 * directory listing results, diagnostic entries.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

const agentIdentify: MessageHandler = (ctx, data) => {
  const agentMeta = {
    machineId: typeof data.machineId === 'string' ? data.machineId : undefined,
    hostname: typeof data.hostname === 'string' ? data.hostname : undefined,
  }
  const accepted = ctx.sessions.setAgent(ctx.ws, agentMeta)
  if (accepted) {
    ctx.ws.data.isAgent = true
    ctx.reply({ type: 'ack', eventId: 'agent' })
    const label = agentMeta.hostname ? ` (${agentMeta.hostname} / ${agentMeta.machineId})` : ''
    ctx.log.info(`Host agent connected${label}`)
  } else {
    ctx.reply({ type: 'agent_reject', reason: 'Another agent is already connected' })
    ctx.ws.close(4409, 'Agent already connected')
  }
}

const reviveResult: MessageHandler = (ctx, data) => {
  const ok = data.success ? 'OK' : 'FAIL'
  const sessionId = data.sessionId as string
  const wrapperId = data.wrapperId as string | undefined
  const jobId = data.jobId as string | undefined
  ctx.log.debug(`Revive ${sessionId?.slice(0, 8)}... ${ok}${data.error ? ` (${data.error})` : ''}`)

  // Forward to dashboard so the launch monitor can show step-by-step progress.
  // Resolve CWD from the session store for scoped broadcast.
  const session = sessionId ? ctx.sessions.getSession(sessionId) : null
  const cwd = session?.cwd || (data.cwd as string)
  if (cwd) {
    ctx.broadcastScoped(
      {
        type: 'revive_result',
        sessionId,
        wrapperId,
        jobId,
        success: data.success,
        error: data.error,
        continued: data.continued,
        tmuxSession: data.tmuxSession,
      },
      cwd,
    )
  }

  // Forward failure to job subscribers
  if (jobId && !data.success) {
    ctx.sessions.failJob(jobId, (data.error as string) || 'Revive failed')
  }
}

const spawnResult: MessageHandler = (ctx, data) => {
  const ok = data.success ? 'OK' : 'FAIL'
  ctx.log.debug(`Spawn ${ok}${data.error ? ` (${data.error})` : ''}`)
  ctx.sessions.resolveSpawn(data.requestId as string, data)
  const jobId = data.jobId as string | undefined
  if (jobId) {
    if (data.success) {
      // Agent confirmed the wrapper process has started (tmux session is up)
      ctx.sessions.forwardJobEvent(jobId, {
        type: 'launch_progress',
        jobId,
        step: 'wrapper_booted',
        status: 'done',
        t: Date.now(),
        detail: typeof data.tmuxSession === 'string' ? data.tmuxSession : undefined,
      })
    } else {
      // Forward failure to job subscribers so launch monitor can show the error
      ctx.sessions.failJob(jobId, (data.error as string) || 'Spawn failed')
    }
  }
}

const listDirsResult: MessageHandler = (ctx, data) => {
  ctx.sessions.resolveDir(data.requestId as string, data)
}

const launchLog: MessageHandler = (ctx, data) => {
  const jobId = data.jobId as string
  if (!jobId) return
  ctx.sessions.forwardJobEvent(jobId, {
    type: 'launch_log',
    jobId,
    step: data.step,
    status: data.status,
    detail: data.detail,
    t: data.t || Date.now(),
  })
}

const spawnFailed: MessageHandler = (ctx, data) => {
  const wrapperId = data.wrapperId as string
  const exitCode = data.exitCode as number | null | undefined
  const elapsedMs = data.elapsedMs as number | undefined
  const cwd = data.cwd as string | undefined
  const earlyFailure = typeof elapsedMs === 'number' && elapsedMs < 5000
  const errorMsg =
    (data.error as string) ||
    (earlyFailure
      ? `Process exited in ${elapsedMs}ms (exit ${exitCode}) - likely hook or config failure`
      : `Spawn failed (exit ${exitCode})`)
  ctx.log.info(
    `Spawn FAILED: wrapper=${wrapperId?.slice(0, 8)} exit=${exitCode} elapsed=${elapsedMs}ms${earlyFailure ? ' (early failure - likely hook/config issue)' : ''}`,
  )

  // Route through the job system so the launch monitor gets an immediate job_failed
  // instead of timing out after 30s with a generic error
  if (wrapperId) {
    const jobId = ctx.sessions.getJobByWrapper(wrapperId)
    if (jobId) {
      // Emit first-class progress alongside the legacy job_failed event
      ctx.sessions.forwardJobEvent(jobId, {
        type: 'launch_progress',
        jobId,
        step: 'failed',
        status: 'error',
        t: Date.now(),
        error: errorMsg,
        wrapperId,
        elapsed: elapsedMs,
      })
      ctx.sessions.failJob(jobId, errorMsg)
    }
  }

  // Also broadcast for any non-job listeners (session detail, diag, etc.)
  if (cwd) {
    ctx.broadcastScoped({ type: 'spawn_failed', wrapperId, exitCode, elapsedMs, error: errorMsg, pid: data.pid }, cwd)
  } else {
    ctx.broadcast({ type: 'spawn_failed', wrapperId, exitCode, elapsedMs, error: errorMsg, pid: data.pid })
  }
}

const agentDiag: MessageHandler = (ctx, data) => {
  if (Array.isArray(data.entries)) {
    for (const entry of data.entries) {
      ctx.sessions.pushAgentDiag(entry)
    }
  }
}

const usageUpdate: MessageHandler = (ctx, data) => {
  const usage = data as unknown as import('../../shared/protocol').UsageUpdate
  if (usage.fiveHour && usage.sevenDay) {
    ctx.sessions.setUsage(usage)
    ctx.log.debug(
      `Usage: 5h=${usage.fiveHour.usedPercent}% 7d=${usage.sevenDay.usedPercent}%${usage.sevenDayOpus ? ` opus=${usage.sevenDayOpus.usedPercent}%` : ''}${usage.sevenDaySonnet ? ` sonnet=${usage.sevenDaySonnet.usedPercent}%` : ''}`,
    )
  }
}

export function registerAgentHandlers(): void {
  registerHandlers({
    agent_identify: agentIdentify,
    revive_result: reviveResult,
    spawn_result: spawnResult,
    spawn_failed: spawnFailed,
    list_dirs_result: listDirsResult,
    launch_log: launchLog,
    agent_diag: agentDiag,
    usage_update: usageUpdate,
  })
}
