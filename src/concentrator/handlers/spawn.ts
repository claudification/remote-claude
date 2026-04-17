/**
 * Dashboard spawn handler (WS `spawn_request`).
 *
 * Counterpart to the HTTP /api/spawn route -- delegates to the same
 * `dispatchSpawn` helper so behavior stays in lockstep.
 *
 * Ack shape: `{ type: 'spawn_request_ack', ok, jobId?, wrapperId?, tmuxSession?, error? }`
 * -- caller correlates by jobId.
 */

import { mapProjectTrust, type SpawnCallerContext } from '../../shared/spawn-permissions'
import { spawnRequestSchema } from '../../shared/spawn-schema'
import { getGlobalSettings } from '../global-settings'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'
import { getProjectSettings } from '../project-settings'
import { dispatchSpawn } from '../spawn-dispatch'

const handleSpawnRequest: MessageHandler = (ctx, data) => {
  const jobIdFromClient = typeof data.jobId === 'string' ? data.jobId : undefined

  // Permission first -- dashboard users must hold `spawn` permission.
  // Wrappers/agents bypass (not applicable here; spawn_request is dashboard-only).
  ctx.requirePermission('spawn', '*')

  const parsed = spawnRequestSchema.safeParse(data)
  if (!parsed.success) {
    ctx.reply({
      type: 'spawn_request_ack',
      ok: false,
      jobId: jobIdFromClient,
      error: parsed.error.message,
    })
    return
  }
  const req = parsed.data

  const callerCwd = ctx.caller?.cwd ?? null
  const trustLevel = callerCwd ? mapProjectTrust(ctx.getProjectSettings(callerCwd)?.trustLevel) : 'trusted'
  const callerContext: SpawnCallerContext = {
    kind: 'ws',
    hasSpawnPermission: true, // already validated by ctx.requirePermission above
    trustLevel,
    cwd: callerCwd,
  }

  // Fire-and-track: dispatchSpawn is async but the router doesn't await handlers.
  // We catch promise rejections to ensure the caller always gets an ack.
  dispatchSpawn(req, {
    sessions: ctx.sessions,
    getProjectSettings,
    getGlobalSettings,
    callerContext,
    // Dashboard-initiated spawns do not participate in the inter-session
    // rendezvous channel -- the dashboard already gets launch events via jobId.
    rendezvousCallerSessionId: null,
  })
    .then(result => {
      if (result.ok) {
        ctx.reply({
          type: 'spawn_request_ack',
          ok: true,
          jobId: req.jobId,
          wrapperId: result.wrapperId,
          tmuxSession: result.tmuxSession,
        })
      } else {
        ctx.reply({
          type: 'spawn_request_ack',
          ok: false,
          jobId: req.jobId,
          error: result.error,
        })
      }
    })
    .catch((err: unknown) => {
      ctx.log.error('spawn_request dispatch error', err)
      ctx.reply({
        type: 'spawn_request_ack',
        ok: false,
        jobId: req.jobId,
        error: err instanceof Error ? err.message : 'Spawn dispatch failed',
      })
    })
}

/**
 * Fetch a diagnostic snapshot for a job by ID. Mirrors what the dashboard's
 * "Copy diagnostics" button builds client-side, but driven from concentrator
 * state so MCP / other back-end callers can retrieve it after the fact.
 *
 * Permission: `spawn` -- same gate as actually spawning. Anyone who could
 * have initiated the spawn can read its trail.
 */
const handleGetSpawnDiagnostics: MessageHandler = (ctx, data) => {
  ctx.requirePermission('spawn', '*')

  const jobId = typeof data.jobId === 'string' ? data.jobId : null
  if (!jobId) {
    ctx.reply({
      type: 'spawn_diagnostics_result',
      ok: false,
      error: 'jobId required',
    })
    return
  }

  const diag = ctx.sessions.getJobDiagnostics(jobId)
  if (!diag) {
    ctx.reply({
      type: 'spawn_diagnostics_result',
      ok: false,
      jobId,
      error: 'Job not found (may have expired after 5 minutes)',
    })
    return
  }

  ctx.reply({
    type: 'spawn_diagnostics_result',
    ok: true,
    jobId,
    diagnostics: diag,
  })
}

export function registerSpawnHandlers(): void {
  registerHandlers({
    spawn_request: handleSpawnRequest,
    get_spawn_diagnostics: handleGetSpawnDiagnostics,
  })
}
