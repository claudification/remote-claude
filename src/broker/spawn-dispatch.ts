/**
 * Shared spawn dispatch logic.
 *
 * Single source of truth for "send a spawn to the sentinel, wait for ack,
 * register pending launch config, optionally register an MCP-caller rendezvous".
 *
 * Called from:
 * - HTTP `/api/spawn` route (src/broker/routes.ts)
 * - WS `spawn_request` handler (src/broker/handlers/spawn.ts)
 * - WS `channel_spawn` handler (src/broker/handlers/inter-conversation.ts)
 *
 * Every caller has already enforced its own permission/trust check BEFORE
 * invoking dispatchSpawn -- this function does NOT re-check. It trusts the
 * SpawnRequest is valid and the caller is authorized.
 */

import { randomUUID } from 'node:crypto'
import { generateConversationName } from '../shared/conversation-names'
import { validateModel } from '../shared/models'
import type { Conversation, LaunchProgressEvent, LaunchStep, ProjectSettings, SpawnResult } from '../shared/protocol'
import { resolveSpawnConfig } from '../shared/spawn-defaults'
import { deriveConversationName, validateConversationName } from '../shared/spawn-naming'
import { assertSpawnAllowed, type SpawnCallerContext, SpawnPermissionError } from '../shared/spawn-permissions'
import type { SpawnRequest } from '../shared/spawn-schema'
import type { ConversationStore } from './conversation-store'
import type { GlobalSettings } from './global-settings'

/**
 * Emit a first-class launch_progress event to all subscribers of the job.
 * No-op if jobId is undefined (callers that dispatch without tracking a job).
 */
function emitProgress(
  sessions: ConversationStore,
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
  sessions: ConversationStore
  getProjectSettings: (project: string) => ProjectSettings | null
  getGlobalSettings: () => GlobalSettings
  /** Caller context for the unified permission gate. */
  callerContext: SpawnCallerContext
  /** If set, register a rendezvous so the caller session is notified when the spawned wrapper connects. */
  rendezvousCallerSessionId?: string | null
}

export type SpawnDispatchResult =
  | { ok: true; conversationId: string; jobId: string; tmuxSession?: string }
  | { ok: false; error: string; statusCode?: number }

/**
 * Send a spawn request to the sentinel, await ack, register pending launch config.
 *
 * Does NOT enforce permissions - callers must check first. Does NOT validate the
 * SpawnRequest - callers should have parsed it via spawnRequestSchema already.
 */
export async function dispatchSpawn(req: SpawnRequest, deps: SpawnDispatchDeps): Promise<SpawnDispatchResult> {
  // path can be absolute (/…), ~-relative (~/…), or relative (./… | ../… | bare).
  // Relative paths are resolved on the sentinel side against spawnRoot ($HOME).
  try {
    assertSpawnAllowed(deps.callerContext, req)
  } catch (err) {
    if (err instanceof SpawnPermissionError) {
      return { ok: false, error: err.message, statusCode: 403 }
    }
    throw err
  }

  // Route to the specified sentinel, or default
  const targetAlias = req.sentinel
  let sentinel: ReturnType<typeof deps.sessions.getSentinel>
  if (targetAlias) {
    sentinel = deps.sessions.getSentinelByAlias(targetAlias)
    if (!sentinel) {
      const connected = deps.sessions.getConnectedSentinels()
      const available = connected.map(s => s.alias).join(', ') || 'none'
      return {
        ok: false,
        error: `Sentinel "${targetAlias}" is offline. Available: ${available}`,
        statusCode: 503,
      }
    }
  } else {
    sentinel = deps.sessions.getSentinel()
    if (!sentinel) return { ok: false, error: 'No sentinel connected', statusCode: 503 }
  }

  if (req.mode === 'resume' && !req.resumeId) {
    return { ok: false, error: 'resumeId required for resume mode', statusCode: 400 }
  }

  if (req.name) {
    const usedNames = new Set(
      deps.sessions
        .getAllConversations()
        .map((s: Conversation) => s.title)
        .filter(Boolean) as string[],
    )
    const nameErr = validateConversationName(req.name, usedNames)
    if (nameErr) return { ok: false, error: nameErr, statusCode: 400 }
  }

  const requestId = randomUUID()
  const conversationId = randomUUID()
  const jobId = req.jobId ?? randomUUID()

  deps.sessions.createJob(jobId, conversationId)
  emitProgress(deps.sessions, jobId, 'job_created', 'done', { conversationId })

  const projectLabel = req.cwd.split('/').pop() || req.cwd
  if (req.adHoc) {
    console.log(
      `[ad-hoc] Spawn request: ${projectLabel} task=${req.adHocTaskId || 'none'} conv=${conversationId.slice(0, 8)} prompt=${req.prompt?.length || 0}chars worktree=${req.worktree || 'none'}`,
    )
  }

  const projSettings = deps.getProjectSettings(req.cwd)
  const globalSettings = deps.getGlobalSettings()
  const resolved = resolveSpawnConfig(req, projSettings, globalSettings)
  const {
    headless,
    model,
    effort,
    agent,
    permissionMode,
    autocompactPct,
    maxBudgetUsd,
    bare,
    repl,
    includePartialMessages,
  } = resolved

  if (model) {
    const validation = validateModel(model)
    if (!validation.valid) {
      emitProgress(deps.sessions, jobId, 'failed', 'error', { error: validation.warning })
      return { ok: false, error: validation.warning || `Unknown model: ${model}`, statusCode: 400 }
    }
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

    // Record the resolved config on the job so MCP get_spawn_diagnostics can
    // return it later -- we intentionally drop the prompt (can be large / PII)
    // and the env map (sensitive values live there; diagnostics builder
    // redacts known-secret keys).
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

    deps.sessions.setPendingLaunchConfig(conversationId, {
      headless,
      model,
      effort,
      agent,
      bare: bare || false,
      repl: repl || false,
      permissionMode,
      autocompactPct,
      includePartialMessages,
      maxBudgetUsd,
      env: req.env || undefined,
    })

    sentinel.send(
      JSON.stringify({
        type: 'spawn',
        requestId,
        cwd: req.cwd,
        conversationId,
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
          deriveConversationName(req) ??
          generateConversationName(
            new Set(
              deps.sessions
                .getAllConversations()
                .map((s: Conversation) => s.title)
                .filter(Boolean) as string[],
            ),
          ),
        sessionDescription: req.description || undefined,
        agent,
        permissionMode,
        autocompactPct,
        maxBudgetUsd,
        prompt: req.prompt || undefined,
        adHoc: req.adHoc || undefined,
        adHocTaskId: req.adHocTaskId || undefined,
        includePartialMessages,
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
    if (req.adHoc) console.log(`[ad-hoc] Spawn FAILED: ${result.error || 'unknown'} (${projectLabel})`)
    emitProgress(deps.sessions, jobId, 'failed', 'error', { error: result.error || 'Spawn failed' })
    return { ok: false, error: result.error || 'Spawn failed', statusCode: 500 }
  }
  emitProgress(deps.sessions, jobId, 'agent_acked', 'done', { detail: result.tmuxSession })
  if (req.adHoc) console.log(`[ad-hoc] Spawn OK: conv=${conversationId.slice(0, 8)} tmux=${result.tmuxSession}`)

  const callerSessionId = deps.rendezvousCallerSessionId
  if (callerSessionId) {
    // Don't block the response -- caller gets immediate success + conversationId.
    // Rendezvous resolves async and pushes spawn_ready / spawn_timeout.
    deps.sessions
      .addRendezvous(conversationId, callerSessionId, req.cwd, 'spawn')
      .then(session => {
        emitProgress(deps.sessions, jobId, 'session_connected', 'done', {
          ccSessionId: session.id,
          conversationId,
        })
        const callerWs = deps.sessions.getConversationSocket(callerSessionId)
        callerWs?.send(
          JSON.stringify({
            type: 'spawn_ready',
            ccSessionId: session.id,
            project: session.project,
            conversationId,
            session,
          }),
        )
      })
      .catch(err => {
        const errMsg = typeof err === 'string' ? err : 'Spawn rendezvous timed out'
        emitProgress(deps.sessions, jobId, 'failed', 'error', { error: errMsg })
        const callerWs = deps.sessions.getConversationSocket(callerSessionId)
        callerWs?.send(
          JSON.stringify({
            type: 'spawn_timeout',
            conversationId,
            cwd: req.cwd,
            error: errMsg,
          }),
        )
      })
  }

  return { ok: true, conversationId, jobId, tmuxSession: result.tmuxSession }
}
