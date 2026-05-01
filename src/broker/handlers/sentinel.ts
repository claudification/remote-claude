/**
 * Sentinel handlers: identification, spawn/revive results,
 * directory listing results, diagnostic entries.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

const sentinelIdentify: MessageHandler = (ctx, data) => {
  // Prefer auth-derived sentinel identity from WS upgrade (per-sentinel secret)
  // over self-reported values from the identify message
  const authSentinelId = ctx.ws.data.sentinelId
  const authAlias = ctx.ws.data.sentinelAlias

  const sentinelMeta = {
    machineId: typeof data.machineId === 'string' ? data.machineId : undefined,
    hostname: typeof data.hostname === 'string' ? data.hostname : undefined,
    alias: authAlias || (typeof data.alias === 'string' ? data.alias : undefined),
    spawnRoot: typeof data.spawnRoot === 'string' ? data.spawnRoot : undefined,
    sentinelId: authSentinelId,
  }
  const accepted = ctx.conversations.setSentinel(ctx.ws, sentinelMeta)
  if (accepted) {
    ctx.ws.data.isSentinel = true
    ctx.reply({ type: 'ack', eventId: 'sentinel' })
    const label = sentinelMeta.hostname ? ` (${sentinelMeta.hostname} / ${sentinelMeta.machineId})` : ''
    const aliasLabel = sentinelMeta.alias ? ` alias=${sentinelMeta.alias}` : ''
    ctx.log.info(`Sentinel connected${label}${aliasLabel}`)
  } else {
    ctx.reply({ type: 'sentinel_reject', reason: 'Sentinel rejected' })
    ctx.ws.close(4409, 'Sentinel rejected')
  }
}

const reviveResult: MessageHandler = (ctx, data) => {
  const ok = data.success ? 'OK' : 'FAIL'
  const ccSessionId = data.ccSessionId as string
  const conversationId = (data.conversationId || data.wrapperId) as string | undefined
  const jobId = data.jobId as string | undefined
  ctx.log.debug(`Revive ccSession=${ccSessionId?.slice(0, 8)} ${ok}${data.error ? ` (${data.error})` : ''}`)

  // Forward to dashboard so the launch monitor can show step-by-step progress.
  // Resolve CWD from the conversation store for scoped broadcast.
  const conversation = ccSessionId ? ctx.conversations.getConversation(ccSessionId) : null
  const project = conversation?.project || (data.project as string)
  if (project) {
    ctx.broadcastScoped(
      {
        type: 'revive_result',
        ccSessionId,
        conversationId,
        jobId,
        success: data.success,
        error: data.error,
        continued: data.continued,
        tmuxSession: data.tmuxSession,
      },
      project,
    )
  }

  // Forward failure to job subscribers
  if (jobId && !data.success) {
    ctx.conversations.failJob(jobId, (data.error as string) || 'Revive failed')
  }
}

const spawnResult: MessageHandler = (ctx, data) => {
  const ok = data.success ? 'OK' : 'FAIL'
  ctx.log.debug(`Spawn ${ok}${data.error ? ` (${data.error})` : ''}`)
  ctx.conversations.resolveSpawn(data.requestId as string, data)
  const jobId = data.jobId as string | undefined
  if (jobId) {
    if (data.success) {
      // Sentinel confirmed the wrapper process has started (tmux session is up)
      ctx.conversations.forwardJobEvent(jobId, {
        type: 'launch_progress',
        jobId,
        step: 'wrapper_booted',
        status: 'done',
        t: Date.now(),
        detail: typeof data.tmuxSession === 'string' ? data.tmuxSession : undefined,
      })
    } else {
      // Forward failure to job subscribers so launch monitor can show the error
      ctx.conversations.failJob(jobId, (data.error as string) || 'Spawn failed')
    }
  }
}

const listDirsResult: MessageHandler = (ctx, data) => {
  ctx.conversations.resolveDir(data.requestId as string, data)
}

const launchLog: MessageHandler = (ctx, data) => {
  const jobId = data.jobId as string
  if (!jobId) return
  ctx.conversations.forwardJobEvent(jobId, {
    type: 'launch_log',
    jobId,
    step: data.step,
    status: data.status,
    detail: data.detail,
    t: data.t || Date.now(),
  })
}

const spawnFailed: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.wrapperId) as string
  const exitCode = data.exitCode as number | null | undefined
  const elapsedMs = data.elapsedMs as number | undefined
  const projectPath = data.cwd as string | undefined
  const earlyFailure = typeof elapsedMs === 'number' && elapsedMs < 5000
  const errorMsg =
    (data.error as string) ||
    (earlyFailure
      ? `Process exited in ${elapsedMs}ms (exit ${exitCode}) - likely hook or config failure`
      : `Spawn failed (exit ${exitCode})`)
  ctx.log.info(
    `Spawn FAILED: conv=${conversationId?.slice(0, 8)} exit=${exitCode} elapsed=${elapsedMs}ms${earlyFailure ? ' (early failure - likely hook/config issue)' : ''}`,
  )

  // Route through the job system so the launch monitor gets an immediate job_failed
  // instead of timing out after 30s with a generic error
  if (conversationId) {
    const jobId = ctx.conversations.getJobByConversation(conversationId)
    if (jobId) {
      // Emit first-class progress alongside the legacy job_failed event
      ctx.conversations.forwardJobEvent(jobId, {
        type: 'launch_progress',
        jobId,
        step: 'failed',
        status: 'error',
        t: Date.now(),
        error: errorMsg,
        conversationId,
        elapsed: elapsedMs,
      })
      ctx.conversations.failJob(jobId, errorMsg)
    }
  }

  // Also broadcast for any non-job listeners (session detail, diag, etc.)
  if (projectPath) {
    ctx.broadcastScoped(
      { type: 'spawn_failed', conversationId, exitCode, elapsedMs, error: errorMsg, pid: data.pid },
      projectPath,
    )
  } else {
    ctx.broadcast({ type: 'spawn_failed', conversationId, exitCode, elapsedMs, error: errorMsg, pid: data.pid })
  }
}

const sentinelDiag: MessageHandler = (ctx, data) => {
  if (Array.isArray(data.entries)) {
    for (const entry of data.entries) {
      ctx.conversations.pushSentinelDiag(entry)
    }
  }
}

const usageUpdate: MessageHandler = (ctx, data) => {
  const usage = data as unknown as import('../../shared/protocol').UsageUpdate
  if (usage.fiveHour && usage.sevenDay) {
    ctx.conversations.setUsage(usage)
    ctx.log.debug(
      `Usage: 5h=${usage.fiveHour.usedPercent}% 7d=${usage.sevenDay.usedPercent}%${usage.sevenDayOpus ? ` opus=${usage.sevenDayOpus.usedPercent}%` : ''}${usage.sevenDaySonnet ? ` sonnet=${usage.sevenDaySonnet.usedPercent}%` : ''}`,
    )
  }
}

export function registerSentinelHandlers(): void {
  registerHandlers({
    sentinel_identify: sentinelIdentify,
    revive_result: reviveResult,
    spawn_result: spawnResult,
    spawn_failed: spawnFailed,
    list_dirs_result: listDirsResult,
    launch_log: launchLog,
    sentinel_diag: sentinelDiag,
    usage_update: usageUpdate,
  })
}
