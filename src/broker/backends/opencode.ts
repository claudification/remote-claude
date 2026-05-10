/**
 * OpenCode backend -- spawns OpenCode behind the generic ACP agent host.
 *
 * The dashboard still requests `backend: 'opencode'`, the URI scheme stays
 * `opencode://`, and the user-facing identity is "OpenCode conversation" --
 * but under the hood we spawn `bin/acp-host` (the multi-agent ACP-speaking
 * binary, see plan-acp-agent-host.md) and tag agentHostType='acp' with
 * acpAgent='opencode'. The sentinel routes to bin/acp-host and applies the
 * OpenCode recipe (src/sentinel/acp-recipes.ts).
 *
 * The legacy NDJSON path (`bin/opencode-host`, src/opencode-agent-host/)
 * remains in the tree as a fallback during the ACP rollout. It's no longer
 * reachable from the dashboard -- to reach it, set agentHostType='opencode'
 * directly via API.
 *
 * See plan-acp-agent-host.md and plan-opencode-backend.md.
 */

import { randomUUID } from 'node:crypto'
import { generateConversationName } from '../../shared/conversation-names'
import { DEFAULT_OPENCODE_TOOL_PERMISSION, normalizeTier } from '../../shared/opencode-config'
import type {
  Conversation,
  LaunchProgressEvent,
  LaunchStep,
  SpawnResult as SentinelSpawnResult,
} from '../../shared/protocol'
import { deriveConversationName, validateConversationName } from '../../shared/spawn-naming'
import type { SpawnRequest } from '../../shared/spawn-schema'
import type { ConversationStore } from '../conversation-store'
import type { ConversationBackend, InputResult, SpawnDeps, SpawnResult } from './types'

/**
 * agentHostMeta keys this backend uses. The broker core never reads these --
 * only this file (and the opencode-host binary) does.
 */
const META_OPENCODE_SESSION_ID = 'openCodeSessionId'
const META_BACKEND = 'backend'
const META_PROVIDER_MODEL = 'openCodeModel'
const META_TOOL_PERMISSION = 'openCodeToolPermission'

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

export const opencodeBackend: ConversationBackend = {
  type: 'opencode',
  scheme: 'opencode',
  // The spawned opencode-host binary connects back to the broker over a
  // per-conversation WebSocket, exactly like the Claude agent host.
  requiresAgentSocket: true,

  async spawn(req: SpawnRequest, deps: SpawnDeps): Promise<SpawnResult> {
    return spawnOpenCode(req, deps)
  },

  async handleInput(): Promise<InputResult> {
    // Same contract as the Claude backend: input is forwarded over the agent
    // host socket by the unified send_input handler.
    return { ok: false, useSocket: true, error: 'OpenCode input is handled via agent host socket' }
  },
}

// --- Spawn ----------------------------------------------------------------

async function spawnOpenCode(req: SpawnRequest, deps: SpawnDeps): Promise<SpawnResult> {
  // Resolve sentinel
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
    resolvedSentinelId = deps.conversationStore.getConnectedSentinels().find(s => s.alias === targetAlias)?.sentinelId
  } else {
    sentinel = deps.conversationStore.getSentinel()
    if (!sentinel) return { ok: false, error: 'No sentinel connected', statusCode: 503 }
    resolvedSentinelId = deps.conversationStore.getDefaultSentinelId()
  }

  if (resolvedSentinelId && !deps.conversationStore.isSentinelAlive(resolvedSentinelId)) {
    return { ok: false, error: 'Sentinel not responding (no heartbeat received recently)', statusCode: 503 }
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

  // Build a project URI of the form `opencode://{slug}` where slug is derived
  // from the model or a config name. Falls back to "default".
  const slug = deriveOpenCodeSlug(req)
  const project = `opencode://${slug}`

  // Resolve the OpenCode tool permission tier:
  //   request override -> project setting -> safe default.
  // The opencode:// project URI is what opencode conversations key off; the
  // dashboard saves the project setting under the same URI.
  const projSettings = deps.getProjectSettings(project)
  const toolPermission = normalizeTier(req.toolPermission ?? projSettings?.defaultOpenCodeToolPermission)

  const sessionName =
    deriveConversationName(req) ??
    generateConversationName(
      new Set(
        deps.conversationStore
          .getAllConversations()
          .map((s: Conversation) => s.title)
          .filter(Boolean) as string[],
      ),
    )

  // Send a sentinel spawn message tagged with backend=opencode so the sentinel
  // launches the opencode-host binary instead of rclaude. The sentinel speaks
  // a small wire protocol; we set `agentHostType` to drive its dispatch.
  const result = await new Promise<SentinelSpawnResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      deps.conversationStore.removeSpawnListener(requestId)
      reject(new Error('Sentinel did not respond (15s timeout)'))
    }, 15000)

    deps.conversationStore.addSpawnListener(requestId, msg => {
      clearTimeout(timeout)
      resolve(msg as SentinelSpawnResult)
    })

    emitProgress(deps.conversationStore, jobId, 'spawn_sent', 'active')

    deps.conversationStore.recordJobConfig(jobId, {
      cwd: req.cwd,
      worktree: req.worktree,
      mkdir: req.mkdir,
      mode: req.mode || 'fresh',
      headless: true,
      model: req.openCodeModel ?? req.model,
      bare: false,
      repl: false,
      leaveRunning: req.leaveRunning,
      name: req.name,
    })

    deps.conversationStore.setPendingLaunchConfig(conversationId, {
      headless: true,
      model: req.openCodeModel ?? req.model,
      bare: false,
      repl: false,
      env: req.env || undefined,
    })

    try {
      sentinel.send(
        JSON.stringify({
          type: 'spawn',
          requestId,
          conversationId,
          jobId,
          // Sentinel routes ACP-tagged spawns to bin/acp-host. acpAgent
          // selects the recipe (acp-recipes.ts) used to launch the underlying
          // agent CLI (e.g. `opencode acp`). The wire protocol the host
          // speaks back to the broker is identical to the legacy NDJSON
          // path's, so the broker doesn't care which one is in use.
          agentHostType: 'acp',
          acpAgent: 'opencode',
          cwd: req.cwd,
          mkdir: req.mkdir || false,
          mode: req.mode || 'fresh',
          model: req.openCodeModel ?? req.model,
          sessionName,
          sessionDescription: req.description || undefined,
          prompt: req.prompt || undefined,
          worktree: req.worktree || undefined,
          env: req.env || undefined,
          // Pass through OpenCode-specific extras (later: from req.backendExtras).
          openCodeModel: req.openCodeModel ?? req.model,
          toolPermission,
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
    } as SentinelSpawnResult
  })

  if (!result.success) {
    const errorMsg = result.error || 'Spawn failed'
    emitProgress(deps.conversationStore, jobId, 'failed', 'error', { error: errorMsg })
    deps.conversationStore.failJob(jobId, errorMsg)
    return { ok: false, error: errorMsg, statusCode: 500 }
  }

  // Tag the conversation now so subsequent boot/input messages route correctly.
  // The opencode-host binary will send agent_host_boot which fills in the
  // remaining fields; we pre-populate the type so resolveBackend() works
  // before that arrives.
  let conv = deps.conversationStore.getConversation(conversationId)
  if (!conv) {
    conv = deps.conversationStore.createConversation(
      conversationId,
      project,
      req.openCodeModel ?? req.model,
      [],
      ['headless', 'channel'],
    )
  }
  conv.agentHostType = 'acp'
  conv.agentHostMeta = {
    [META_BACKEND]: 'opencode',
    acpAgent: 'opencode',
    [META_PROVIDER_MODEL]: req.openCodeModel ?? req.model,
    [META_TOOL_PERMISSION]: toolPermission,
  }
  conv.project = project
  conv.title = req.name || sessionName
  if (req.description) conv.description = req.description
  deps.conversationStore.persistConversationById(conversationId)

  emitProgress(deps.conversationStore, jobId, 'agent_acked', 'done')

  return { ok: true, conversationId, jobId, tmuxSession: result.tmuxSession }
}

/**
 * Build a stable slug for the project URI. Uses the model name (e.g.
 * `openrouter/anthropic/claude-haiku-4.5` -> `openrouter-claude-haiku-4-5`)
 * so all conversations talking to the same provider/model land in the same
 * project bucket in the sidebar.
 */
function deriveOpenCodeSlug(req: SpawnRequest): string {
  const model = req.openCodeModel ?? req.model
  if (!model) return 'default'
  // Strip the path-style provider prefix and slugify
  const tail = model.split('/').pop() || model
  const provider = model.split('/')[0]
  const base = provider && provider !== tail ? `${provider}-${tail}` : tail
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'default'
  )
}

/** Helper for tests + downstream consumers (kept off the public type until needed). */
export const _internal = {
  META_OPENCODE_SESSION_ID,
  META_BACKEND,
  META_PROVIDER_MODEL,
  META_TOOL_PERMISSION,
  DEFAULT_OPENCODE_TOOL_PERMISSION,
  deriveOpenCodeSlug,
}
