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
import { cwdToProjectUri } from '../shared/project-uri'
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
  conversationStore: ConversationStore,
  jobId: string | undefined,
  step: LaunchStep,
  status: LaunchProgressEvent['status'],
  extra?: Partial<LaunchProgressEvent>,
): void {
  if (!jobId) return
  conversationStore.forwardJobEvent(jobId, {
    type: 'launch_progress',
    jobId,
    step,
    status,
    t: Date.now(),
    ...extra,
  })
}

export type SpawnDispatchDeps = {
  conversationStore: ConversationStore
  getProjectSettings: (project: string) => ProjectSettings | null
  getGlobalSettings: () => GlobalSettings
  /** Caller context for the unified permission gate. */
  callerContext: SpawnCallerContext
  /** If set, register a rendezvous so the caller conversation is notified when the spawned agent host connects. */
  rendezvousCallerConversationId?: string | null
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

  // --- Chat API backend: bypass sentinel entirely -------------------------
  if (req.backend === 'chat-api') {
    return dispatchChatApiSpawn(req, deps)
  }

  // --- Hermes gateway backend: bypass sentinel, routes via gateway socket --
  if (req.backend === 'hermes') {
    return dispatchHermesSpawn(req, deps)
  }

  // Route to the specified sentinel, or default
  const targetAlias = req.sentinel
  let sentinel: ReturnType<typeof deps.conversationStore.getSentinel>
  let resolvedSentinelId: string | undefined
  if (targetAlias) {
    sentinel = deps.conversationStore.getSentinelByAlias(targetAlias)
    if (!sentinel) {
      const connected = deps.conversationStore.getConnectedSentinels()
      const available = connected.map(s => s.alias).join(', ') || 'none'
      return {
        ok: false,
        error: `Sentinel "${targetAlias}" is offline. Available: ${available}`,
        statusCode: 503,
      }
    }
    const connectedSentinels = deps.conversationStore.getConnectedSentinels()
    resolvedSentinelId = connectedSentinels.find(s => s.alias === targetAlias)?.sentinelId
  } else {
    sentinel = deps.conversationStore.getSentinel()
    if (!sentinel) return { ok: false, error: 'No sentinel connected', statusCode: 503 }
    resolvedSentinelId = deps.conversationStore.getDefaultSentinelId()
  }

  // Pre-flight liveness check: verify sentinel has sent a heartbeat recently.
  // Catches stale/half-open WS connections that would otherwise timeout after 15s.
  if (resolvedSentinelId && !deps.conversationStore.isSentinelAlive(resolvedSentinelId)) {
    return {
      ok: false,
      error: 'Sentinel not responding (no heartbeat received recently)',
      statusCode: 503,
    }
  }

  if (req.mode === 'resume' && !req.resumeId) {
    return { ok: false, error: 'resumeId required for resume mode', statusCode: 400 }
  }

  if (req.name) {
    const usedNames = new Set(
      deps.conversationStore
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

  deps.conversationStore.createJob(jobId, conversationId)
  emitProgress(deps.conversationStore, jobId, 'job_created', 'done', { conversationId })

  const projectLabel = req.cwd.split('/').pop() || req.cwd
  if (req.adHoc) {
    console.log(
      `[ad-hoc] Spawn request: ${projectLabel} task=${req.adHocTaskId || 'none'} conv=${conversationId.slice(0, 8)} prompt=${req.prompt?.length || 0}chars worktree=${req.worktree || 'none'}`,
    )
  }

  // Best-effort settings lookup. Non-absolute paths (~/..., ./...) won't match
  // any stored project settings -- that's fine, global defaults apply. The
  // sentinel resolves the real path and returns the canonical URI.
  const settingsUri = req.cwd.includes('://') ? req.cwd : req.cwd.startsWith('/') ? cwdToProjectUri(req.cwd) : null
  const projSettings = settingsUri ? deps.getProjectSettings(settingsUri) : null
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
      emitProgress(deps.conversationStore, jobId, 'failed', 'error', { error: validation.warning })
      return { ok: false, error: validation.warning || `Unknown model: ${model}`, statusCode: 400 }
    }
  }

  const result = await new Promise<SpawnResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      deps.conversationStore.removeSpawnListener(requestId)
      reject(new Error('Sentinel did not respond (15s timeout)'))
    }, 15000)

    deps.conversationStore.addSpawnListener(requestId, msg => {
      clearTimeout(timeout)
      resolve(msg as SpawnResult)
    })

    emitProgress(deps.conversationStore, jobId, 'spawn_sent', 'active')

    // Record the resolved config on the job so MCP get_spawn_diagnostics can
    // return it later -- we intentionally drop the prompt (can be large / PII)
    // and the env map (sensitive values live there; diagnostics builder
    // redacts known-secret keys).
    deps.conversationStore.recordJobConfig(jobId, {
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

    deps.conversationStore.setPendingLaunchConfig(conversationId, {
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

    try {
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
                deps.conversationStore
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
    } catch {
      clearTimeout(timeout)
      deps.conversationStore.removeSpawnListener(requestId)
      reject(new Error('Sentinel offline (send failed)'))
      return
    }
  }).catch((err: unknown) => {
    return {
      type: 'spawn_result',
      requestId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    } as SpawnResult
  })

  if (!result.success) {
    const errorMsg = result.error || 'Spawn failed'
    if (req.adHoc) console.log(`[ad-hoc] Spawn FAILED: ${errorMsg} (${projectLabel})`)
    emitProgress(deps.conversationStore, jobId, 'failed', 'error', { error: errorMsg })
    deps.conversationStore.failJob(jobId, errorMsg)
    return { ok: false, error: errorMsg, statusCode: 500 }
  }
  const project = result.project ?? projectLabel
  emitProgress(deps.conversationStore, jobId, 'agent_acked', 'done', { detail: result.tmuxSession })
  if (req.adHoc) console.log(`[ad-hoc] Spawn OK: conv=${conversationId.slice(0, 8)} tmux=${result.tmuxSession}`)

  const callerConversationId = deps.rendezvousCallerConversationId
  if (callerConversationId) {
    // Don't block the response -- caller gets immediate success + conversationId.
    // Rendezvous resolves async and pushes spawn_ready / spawn_timeout.
    deps.conversationStore
      .addRendezvous(conversationId, callerConversationId, project, 'spawn')
      .then(conv => {
        emitProgress(deps.conversationStore, jobId, 'session_connected', 'done', {
          ccSessionId: (conv.agentHostMeta?.ccSessionId as string) || conv.id,
          conversationId,
        })
        const callerWs = deps.conversationStore.getConversationSocket(callerConversationId)
        callerWs?.send(
          JSON.stringify({
            type: 'spawn_ready',
            ccSessionId: (conv.agentHostMeta?.ccSessionId as string) || conv.id,
            project: conv.project,
            conversationId,
            conv,
          }),
        )
      })
      .catch(err => {
        const errMsg = typeof err === 'string' ? err : 'Spawn rendezvous timed out'
        emitProgress(deps.conversationStore, jobId, 'failed', 'error', { error: errMsg })
        const callerWs = deps.conversationStore.getConversationSocket(callerConversationId)
        callerWs?.send(
          JSON.stringify({
            type: 'spawn_timeout',
            conversationId,
            project,
            error: errMsg,
          }),
        )
      })
  }

  return { ok: true, conversationId, jobId, tmuxSession: result.tmuxSession }
}

/**
 * Spawn a Chat API conversation directly -- no sentinel, no process.
 * Creates the conversation record immediately and returns.
 */
function dispatchChatApiSpawn(req: SpawnRequest, deps: SpawnDispatchDeps): SpawnDispatchResult {
  if (!req.chatConnectionId) {
    return { ok: false, error: 'chatConnectionId is required for backend=chat-api', statusCode: 400 }
  }

  const conversationId = randomUUID()
  const jobId = req.jobId ?? randomUUID()
  const connectionName = req.chatConnectionName || 'default'
  const slug = connectionName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const project = `chat://${slug || 'default'}`

  deps.conversationStore.createJob(jobId, conversationId)

  const conv = deps.conversationStore.createConversation(
    conversationId,
    project,
    req.model,
    [],
    ['headless', 'channel'],
  )
  conv.status = 'active'
  conv.agentHostType = 'chat-api'
  conv.agentHostMeta = {
    chatConnectionId: req.chatConnectionId,
    backend: 'chat-api',
  }
  conv.title =
    req.name ||
    deriveConversationName(req) ||
    generateConversationName(
      new Set(
        deps.conversationStore
          .getAllConversations()
          .map((s: Conversation) => s.title)
          .filter(Boolean) as string[],
      ),
    )
  if (req.description) conv.description = req.description

  deps.conversationStore.persistConversationById(conversationId)
  deps.conversationStore.broadcastConversationUpdate(conversationId)
  emitProgress(deps.conversationStore, jobId, 'session_connected', 'done', { conversationId })

  return { ok: true, conversationId, jobId }
}

/**
 * Spawn a Hermes gateway conversation -- no sentinel, no process.
 * Creates the conversation record and relies on the Hermes gateway adapter
 * (connected via gateway_register) to handle input when it arrives.
 */
function dispatchHermesSpawn(req: SpawnRequest, deps: SpawnDispatchDeps): SpawnDispatchResult {
  const conversationId = randomUUID()
  const jobId = req.jobId ?? randomUUID()

  const connectionName = 'gateway'
  const nameSlug = (req.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const project = nameSlug ? `hermes://${connectionName}/${nameSlug}` : `hermes://${connectionName}`

  deps.conversationStore.createJob(jobId, conversationId)

  const gatewayWs = deps.conversationStore.getGatewaySocket('hermes')
  if (!gatewayWs) {
    deps.conversationStore.failJob(jobId, 'Hermes gateway not connected')
    return { ok: false, error: 'Hermes gateway not connected', statusCode: 503 }
  }

  const conv = deps.conversationStore.createConversation(
    conversationId,
    project,
    req.model,
    [],
    ['headless', 'channel'],
  )
  conv.status = 'idle'
  conv.agentHostType = 'hermes'
  conv.agentHostMeta = { backend: 'hermes' }
  conv.title =
    req.name ||
    deriveConversationName(req) ||
    generateConversationName(
      new Set(
        deps.conversationStore
          .getAllConversations()
          .map((s: Conversation) => s.title)
          .filter(Boolean) as string[],
      ),
    )
  if (req.description) conv.description = req.description

  deps.conversationStore.persistConversationById(conversationId)
  deps.conversationStore.broadcastConversationUpdate(conversationId)
  emitProgress(deps.conversationStore, jobId, 'session_connected', 'done', { conversationId })

  return { ok: true, conversationId, jobId }
}
