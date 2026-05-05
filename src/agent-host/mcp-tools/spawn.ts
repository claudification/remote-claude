import { z } from 'zod'
import { type SpawnRequest, spawnRequestSchema } from '../../shared/spawn-schema'
import { debug } from '../debug'
import type { McpToolContext, ToolDef } from './types'

export function buildSpawnToolInputSchema(): {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
} {
  const spawnToolSchema = spawnRequestSchema
    .omit({ jobId: true })
    .extend({
      action: z
        .enum(['spawn', 'revive', 'restart'])
        .optional()
        .describe(
          'Action to perform. "spawn" = new session at cwd, "revive" = bring back an ended session, "restart" = terminate + auto-revive. Default: spawn.',
        ),
      session_id: z
        .string()
        .optional()
        .describe('Target session ID from list_conversations. Required for revive and restart actions.'),
      resume_id: z.string().optional().describe('Claude Code session ID to resume (alias for resumeId).'),
      host: z.string().optional().describe('Target sentinel alias (from list_hosts). Maps to sentinel field.'),
    })
    .partial({ cwd: true })
  return z.toJSONSchema(spawnToolSchema) as {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

export function registerSpawnTools(ctx: McpToolContext): Record<string, ToolDef> {
  const spawnToolInputSchema = buildSpawnToolInputSchema()

  return {
    spawn_session: {
      description:
        'Unified session lifecycle tool. Spawn new sessions, revive ended ones, or restart active sessions (terminate + auto-revive). Requires benevolent trust level. Sessions boot in tmux on the host - takes 10-30 seconds. Use list_conversations to poll for status.\n\nWhen spawning: ALWAYS provide a short `description` (1-2 sentences) explaining what the session will do. This is shown in the dashboard and helps the user understand each session at a glance. Also provide a `name` when you have a meaningful label.\n\nActions:\n- spawn (default): Start a new session at a directory\n- revive: Bring back an ended/inactive session\n- restart: Terminate an active session and automatically revive it. For self-restart, the MCP response may not arrive (your process dies and reboots).',
      inputSchema: spawnToolInputSchema,
      async handle(params, toolCtx) {
        const action = (params.action as 'spawn' | 'revive' | 'restart') || 'spawn'

        if (action === 'revive') return handleRevive(ctx, params)
        if (action === 'restart') return handleRestart(ctx, params)
        return handleSpawn(ctx, params, toolCtx)
      },
    },

    revive_session: {
      description: 'Legacy alias for spawn_session with action=revive. Prefer spawn_session.',
      hidden: true,
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Target session ID from list_conversations' },
        },
        required: ['session_id'],
      },
      async handle(params) {
        const targetConversationId = params.session_id
        if (!targetConversationId)
          return { content: [{ type: 'text', text: 'Error: session_id is required' }], isError: true }
        const result = await ctx.callbacks.onReviveConversation?.(targetConversationId)
        if (!result?.ok) {
          return { content: [{ type: 'text', text: result?.error || 'Failed to revive session' }], isError: true }
        }
        return {
          content: [
            {
              type: 'text',
              text: `Reviving session ${result.name || targetConversationId.slice(0, 8)}. Use list_conversations to check when ready.`,
            },
          ],
        }
      },
    },
  }
}

async function handleRevive(ctx: McpToolContext, params: Record<string, string>) {
  const targetConversationId = params.session_id
  if (!targetConversationId)
    return { content: [{ type: 'text', text: 'Error: session_id is required for revive' }], isError: true }
  const result = await ctx.callbacks.onReviveConversation?.(targetConversationId)
  if (!result?.ok) {
    debug(`[channel] spawn_session(revive) failed: ${result?.error}`)
    return { content: [{ type: 'text', text: result?.error || 'Failed to revive session' }], isError: true }
  }
  debug(`[channel] spawn_session(revive): ${targetConversationId.slice(0, 8)} (${result.name})`)
  return {
    content: [
      {
        type: 'text',
        text: `Reviving session ${result.name || targetConversationId.slice(0, 8)}. This is async - the session takes 10-30 seconds to start. Use list_conversations to check when status changes to "live".`,
      },
    ],
  }
}

async function handleRestart(ctx: McpToolContext, params: Record<string, string>) {
  const targetConversationId = params.session_id
  if (!targetConversationId)
    return { content: [{ type: 'text', text: 'Error: session_id is required for restart' }], isError: true }
  const result = await ctx.callbacks.onRestartConversation?.(targetConversationId)
  if (!result?.ok) {
    debug(`[channel] spawn_session(restart) failed: ${result?.error}`)
    return { content: [{ type: 'text', text: result?.error || 'Failed to restart session' }], isError: true }
  }
  debug(
    `[channel] spawn_session(restart): ${targetConversationId.slice(0, 8)} (${result.name}) self=${result.selfRestart}`,
  )
  if (result.selfRestart) {
    return {
      content: [
        {
          type: 'text',
          text: `Self-restart initiated for ${result.name || targetConversationId.slice(0, 8)}. This session will terminate and automatically revive. You may not receive this response.`,
        },
      ],
    }
  }
  if (result.alreadyEnded) {
    return {
      content: [
        {
          type: 'text',
          text: `Session ${result.name || targetConversationId.slice(0, 8)} was already ended - reviving instead. Use list_conversations to check when ready.`,
        },
      ],
    }
  }
  return {
    content: [
      {
        type: 'text',
        text: `Restarting session ${result.name || targetConversationId.slice(0, 8)}. The session will terminate and automatically revive. Use list_conversations to check when ready (10-30 seconds).`,
      },
    ],
  }
}

async function handleSpawn(
  ctx: McpToolContext,
  params: Record<string, string>,
  toolCtx: { progressToken?: string | number; extra: unknown },
) {
  const cwd = params.cwd
  if (!cwd) return { content: [{ type: 'text', text: 'Error: cwd is required for spawn' }], isError: true }
  const mode = params.mode as 'fresh' | 'resume' | undefined
  const resumeId = params.resume_id
  if (mode === 'resume' && !resumeId) {
    return {
      content: [{ type: 'text', text: 'Error: resume_id is required when mode is "resume"' }],
      isError: true,
    }
  }
  const mkdir = String(params.mkdir) === 'true'
  const spawnHeadless = params.headless !== undefined ? String(params.headless) !== 'false' : true

  const onProgress = buildProgressHandler(toolCtx)

  const { jobId: _jobId, cwd: _cwd, host: _host, ...spawnRest } = params as SpawnRequest & Record<string, unknown>
  const sentinel = (params.host as string) || (params.sentinel as string) || undefined
  const result = (await ctx.callbacks.onSpawnConversation?.({
    ...spawnRest,
    cwd,
    sentinel,
    mode,
    resumeId,
    mkdir,
    headless: spawnHeadless,
    onProgress,
  })) as
    | {
        ok: boolean
        error?: string
        conversationId?: string
        jobId?: string
        session?: Record<string, unknown>
        timedOut?: boolean
      }
    | undefined
  if (!result?.ok) {
    debug(`[channel] spawn_session failed: ${result?.error}`)
    return { content: [{ type: 'text', text: result?.error || 'Failed to spawn session' }], isError: true }
  }
  const modeDesc = mode === 'resume' ? `resuming ${resumeId}` : 'fresh start'
  debug(`[channel] spawn_session: ${cwd} (${modeDesc}) session=${result.session ? 'ready' : 'pending'}`)

  if (result.session) {
    const sessionObj = result.session as Record<string, unknown>
    const mismatch = sessionObj.modelMismatch as { requested: string; actual: string; detectedAt: number } | undefined
    const responsePayload: Record<string, unknown> = {
      status: 'ready',
      message: `Session spawned and connected at ${cwd} (${modeDesc})`,
      session_id: sessionObj.id,
      session: result.session,
      jobId: result.jobId,
      conversationId: result.conversationId,
    }
    if (mismatch) {
      responsePayload.modelWarning = `Requested model ${mismatch.requested} but session is running ${mismatch.actual}`
      responsePayload.modelMismatch = mismatch
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(responsePayload, null, 2) }],
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: result.timedOut
          ? `Session spawn sent to ${cwd} (${modeDesc}) but session did not connect within the rendezvous timeout. It may still be booting - use list_conversations to check.${result.jobId ? ` jobId=${result.jobId}` : ''}`
          : `Session spawning at ${cwd} (${modeDesc}). Use list_conversations to check when ready.${result.jobId ? ` jobId=${result.jobId}` : ''}`,
      },
    ],
  }
}

function buildProgressHandler(toolCtx: {
  progressToken?: string | number
  extra: unknown
}): ((event: Record<string, unknown>) => void) | undefined {
  const { progressToken } = toolCtx
  if (progressToken === undefined) return undefined

  const extra = toolCtx.extra as {
    sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>
  }
  const stepToPercent: Record<string, number> = {
    job_created: 5,
    spawn_sent: 15,
    agent_acked: 30,
    agent_host_booted: 60,
    session_connected: 95,
    completed: 100,
  }

  return (event: Record<string, unknown>) => {
    const type = event.type as string
    const step = typeof event.step === 'string' ? event.step : undefined
    const status = typeof event.status === 'string' ? event.status : undefined
    const detail = typeof event.detail === 'string' ? event.detail : undefined
    let progress = 0
    let message = step || type
    if (type === 'job_complete') {
      progress = 100
      message = 'Session connected'
    } else if (type === 'job_failed') {
      progress = 100
      message = `Failed: ${typeof event.error === 'string' ? event.error : 'unknown'}`
    } else if (step && step in stepToPercent) {
      progress = stepToPercent[step]
      if (detail) message = `${step}: ${detail}`
      else message = step
      if (status === 'error') message = `Failed at ${step}`
    }
    extra
      .sendNotification?.({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress,
          total: 100,
          message,
        },
      })
      .catch(() => {})
  }
}
