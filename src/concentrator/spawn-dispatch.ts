/**
 * Shared spawn dispatch logic.
 *
 * Single source of truth for "send a spawn to the host agent, wait for ack,
 * register pending launch config, optionally register an MCP-caller rendezvous".
 *
 * Called from:
 * - HTTP `/api/spawn` route (src/concentrator/routes.ts)
 * - WS `spawn_request` handler (src/concentrator/handlers/spawn.ts)
 * - WS `channel_spawn` handler (src/concentrator/handlers/inter-session.ts)
 *
 * Every caller has already enforced its own permission/trust check BEFORE
 * invoking dispatchSpawn -- this function does NOT re-check. It trusts the
 * SpawnRequest is valid and the caller is authorized.
 */

import { randomUUID } from 'node:crypto'
import type { LaunchProgressEvent, LaunchStep, ProjectSettings, Session, SpawnResult } from '../shared/protocol'
import { generateSessionName } from '../shared/session-names'
import { resolveSpawnConfig } from '../shared/spawn-defaults'
import { deriveSessionName } from '../shared/spawn-naming'
import { assertSpawnAllowed, type SpawnCallerContext, SpawnPermissionError } from '../shared/spawn-permissions'
import type { SpawnRequest } from '../shared/spawn-schema'
import type { GlobalSettings } from './global-settings'
import type { SessionStore } from './session-store'

/**
 * Emit a first-class launch_progress event to all subscribers of the job.
 * No-op if jobId is undefined (callers that dispatch without tracking a job).
 */
function emitProgress(
  sessions: SessionStore,
  jobId: string | undefined,
  step: LaunchStep,
  status: LaunchProgressEvent['status'],
  extra?: Partial<LaunchProgressEvent>,
): void {
  if (!jobId) return
  sessions.forwardJobEvent(jobId, {
    type: 'launch_progress',
    jobId,
    step,
    status,
    t: Date.now(),
    ...extra,
  })
}

export type SpawnDispatchDeps = {
  sessions: SessionStore
  getProjectSettings: (cwd: string) => ProjectSettings | null
  getGlobalSettings: () => GlobalSettings
  /** Caller context for the unified permission gate. */
  callerContext: SpawnCallerContext
  /** If set, register a rendezvous so the caller session is notified when the spawned wrapper connects. */
  rendezvousCallerSessionId?: string | null
}

export type SpawnDispatchResult =
  | { ok: true; wrapperId: string; jobId?: string; tmuxSession?: string }
  | { ok: false; error: string; statusCode?: number }

/**
 * Send a spawn request to the host agent, await ack, register pending launch config.
 *
 * Does NOT enforce permissions - callers must check first. Does NOT validate the
 * SpawnRequest - callers should have parsed it via spawnRequestSchema already.
 */
export async function dispatchSpawn(req: SpawnRequest, deps: SpawnDispatchDeps): Promise<SpawnDispatchResult> {
  try {
    assertSpawnAllowed(deps.callerContext, req)
  } catch (err) {
    if (err instanceof SpawnPermissionError) {
      return { ok: false, error: err.message, statusCode: 403 }
    }
    throw err
  }

  const agent = deps.sessions.getAgent()
  if (!agent) return { ok: false, error: 'No host agent connected', statusCode: 503 }

  if (req.mode === 'resume' && !req.resumeId) {
    return { ok: false, error: 'resumeId required for resume mode', statusCode: 400 }
  }

  const requestId = randomUUID()
  const wrapperId = randomUUID()
  const jobId = req.jobId

  if (jobId) {
    deps.sessions.createJob(jobId, wrapperId)
    emitProgress(deps.sessions, jobId, 'job_created', 'done', { wrapperId })
  }

  const cwdLabel = req.cwd.split('/').pop() || req.cwd
  if (req.adHoc) {
    console.log(
      `[ad-hoc] Spawn request: ${cwdLabel} task=${req.adHocTaskId || 'none'} wrapper=${wrapperId.slice(0, 8)} prompt=${req.prompt?.length || 0}chars worktree=${req.worktree || 'none'}`,
    )
  }

  const result = await new Promise<SpawnResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      deps.sessions.removeSpawnListener(requestId)
      reject(new Error('Spawn timed out (15s)'))
    }, 15000)

    deps.sessions.addSpawnListener(requestId, msg => {
      clearTimeout(timeout)
      resolve(msg as SpawnResult)
    })

    emitProgress(deps.sessions, jobId, 'spawn_sent', 'active')

    const projSettings = deps.getProjectSettings(req.cwd)
    const globalSettings = deps.getGlobalSettings()
    const resolved = resolveSpawnConfig(req, projSettings, globalSettings)
    const { headless, model, effort, permissionMode, autocompactPct, maxBudgetUsd, bare, repl } = resolved

    // Record the resolved config on the job so MCP get_spawn_diagnostics can
    // return it later -- we intentionally drop the prompt (can be large / PII)
    // and the env map (sensitive values live there; diagnostics builder
    // redacts known-secret keys).
    if (jobId) {
      deps.sessions.recordJobConfig(jobId, {
        cwd: req.cwd,
        adHoc: req.adHoc,
        adHocTaskId: req.adHocTaskId,
        worktree: req.worktree,
        mkdir: req.mkdir,
        mode: req.adHoc ? 'fresh' : req.mode || 'fresh',
        headless,
        model,
        effort,
        bare,
        repl,
        permissionMode,
        autocompactPct,
        maxBudgetUsd,
        leaveRunning: req.leaveRunning,
        name: req.name,
      })
    }

    deps.sessions.setPendingLaunchConfig(wrapperId, {
      headless,
      model,
      effort,
      bare: bare || false,
      repl: repl || false,
      permissionMode,
      autocompactPct,
      maxBudgetUsd,
      env: req.env || undefined,
    })

    agent.send(
      JSON.stringify({
        type: 'spawn',
        requestId,
        cwd: req.cwd,
        wrapperId,
        jobId,
        mkdir: req.mkdir || false,
        mode: req.adHoc ? 'fresh' : req.mode || 'fresh',
        resumeId: req.resumeId,
        headless,
        effort,
        model,
        bare: bare || false,
        repl: repl || false,
        sessionName:
          deriveSessionName(req) ??
          generateSessionName(
            new Set(
              deps.sessions
                .getAllSessions()
                .map((s: Session) => s.title)
                .filter(Boolean) as string[],
            ),
          ),
        permissionMode,
        autocompactPct,
        maxBudgetUsd,
        prompt: req.prompt || undefined,
        adHoc: req.adHoc || undefined,
        adHocTaskId: req.adHocTaskId || undefined,
        leaveRunning: req.leaveRunning || undefined,
        worktree: req.worktree || undefined,
        env: req.env || undefined,
      }),
    )
  }).catch((err: unknown) => {
    return {
      type: 'spawn_result',
      requestId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    } as SpawnResult
  })

  if (!result.success) {
    if (req.adHoc) console.log(`[ad-hoc] Spawn FAILED: ${result.error || 'unknown'} (${cwdLabel})`)
    emitProgress(deps.sessions, jobId, 'failed', 'error', { error: result.error || 'Spawn failed' })
    return { ok: false, error: result.error || 'Spawn failed', statusCode: 500 }
  }
  emitProgress(deps.sessions, jobId, 'agent_acked', 'done', { detail: result.tmuxSession })
  if (req.adHoc) console.log(`[ad-hoc] Spawn OK: wrapper=${wrapperId.slice(0, 8)} tmux=${result.tmuxSession}`)

  const callerSessionId = deps.rendezvousCallerSessionId
  if (callerSessionId) {
    // Don't block the response -- caller gets immediate success + wrapperId.
    // Rendezvous resolves async and pushes spawn_ready / spawn_timeout.
    deps.sessions
      .addRendezvous(wrapperId, callerSessionId, req.cwd, 'spawn')
      .then(session => {
        emitProgress(deps.sessions, jobId, 'session_connected', 'done', {
          sessionId: session.id,
          wrapperId,
        })
        const callerWs = deps.sessions.getSessionSocket(callerSessionId)
        callerWs?.send(
          JSON.stringify({
            type: 'spawn_ready',
            sessionId: session.id,
            cwd: session.cwd,
            wrapperId,
            session,
          }),
        )
      })
      .catch(err => {
        const errMsg = typeof err === 'string' ? err : 'Spawn rendezvous timed out'
        emitProgress(deps.sessions, jobId, 'failed', 'error', { error: errMsg })
        const callerWs = deps.sessions.getSessionSocket(callerSessionId)
        callerWs?.send(
          JSON.stringify({
            type: 'spawn_timeout',
            wrapperId,
            cwd: req.cwd,
            error: errMsg,
          }),
        )
      })
  }

  return { ok: true, wrapperId, jobId, tmuxSession: result.tmuxSession }
}
