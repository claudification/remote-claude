import { z } from 'zod'
import { type SpawnRequest, spawnRequestSchema } from '../../shared/spawn-schema'
import { debug } from '../debug'
import type { McpToolContext, ToolDef } from './types'

function buildSpawnToolInputSchema(): {
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
          'Action to perform. "spawn" = new conversation at cwd, "revive" = bring back an ended conversation, "restart" = terminate + auto-revive. Default: spawn.',
        ),
      conversation_id: z
        .string()
        .optional()
        .describe('Target conversation ID from list_conversations. Required for revive and restart actions.'),
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
    spawn_conversation: {
      description:
        'Unified conversation lifecycle tool. Spawn new conversations, revive ended ones, or restart active ones (terminate + auto-revive). Requires benevolent trust level. Conversations boot in tmux on the host - takes 10-30 seconds. Use list_conversations to poll for status.\n\nWhen spawning: ALWAYS provide a short `description` (1-2 sentences) explaining what the conversation will do. This is shown in the control panel and helps the user understand each conversation at a glance. Also provide a `name` when you have a meaningful label.\n\nActions:\n- spawn (default): Start a new conversation at a directory\n- revive: Bring back an ended/inactive conversation\n- restart: Terminate an active conversation and automatically revive it. For self-restart, the MCP response may not arrive (your process dies and reboots).',
      inputSchema: spawnToolInputSchema,
      async handle(params, toolCtx) {
        const action = (params.action as 'spawn' | 'revive' | 'restart') || 'spawn'

        if (action === 'revive') return handleRevive(ctx, params)
        if (action === 'restart') return handleRestart(ctx, params)
        return handleSpawn(ctx, params, toolCtx)
      },
    },
  }
}

async function handleRevive(ctx: McpToolContext, params: Record<string, string>) {
  const targetConversationId = params.conversation_id
  if (!targetConversationId)
    return { content: [{ type: 'text', text: 'Error: conversation_id is required for revive' }], isError: true }
  const result = await ctx.callbacks.onReviveConversation?.(targetConversationId)
  if (!result?.ok) {
    debug(`[channel] spawn_conversation(revive) failed: ${result?.error}`)
    return { content: [{ type: 'text', text: result?.error || 'Failed to revive conversation' }], isError: true }
  }
  debug(`[channel] spawn_conversation(revive): ${targetConversationId.slice(0, 8)} (${result.name})`)
  return {
    content: [
      {
        type: 'text',
        text: `Reviving conversation ${result.name || targetConversationId.slice(0, 8)}. This is async - the conversation takes 10-30 seconds to start. Use list_conversations to check when status changes to "live".`,
      },
    ],
  }
}

async function handleRestart(ctx: McpToolContext, params: Record<string, string>) {
  const targetConversationId = params.conversation_id
  if (!targetConversationId)
    return { content: [{ type: 'text', text: 'Error: conversation_id is required for restart' }], isError: true }
  const result = await ctx.callbacks.onRestartConversation?.(targetConversationId)
  if (!result?.ok) {
    debug(`[channel] spawn_conversation(restart) failed: ${result?.error}`)
    return { content: [{ type: 'text', text: result?.error || 'Failed to restart conversation' }], isError: true }
  }
  debug(
    `[channel] spawn_conversation(restart): ${targetConversationId.slice(0, 8)} (${result.name}) self=${result.selfRestart}`,
  )
  if (result.selfRestart) {
    return {
      content: [
        {
          type: 'text',
          text: `Self-restart initiated for ${result.name || targetConversationId.slice(0, 8)}. This conversation will terminate and automatically revive. You may not receive this response.`,
        },
      ],
    }
  }
  if (result.alreadyEnded) {
    return {
      content: [
        {
          type: 'text',
          text: `Conversation ${result.name || targetConversationId.slice(0, 8)} was already ended - reviving instead. Use list_conversations to check when ready.`,
        },
      ],
    }
  }
  return {
    content: [
      {
        type: 'text',
        text: `Restarting conversation ${result.name || targetConversationId.slice(0, 8)}. The conversation will terminate and automatically revive. Use list_conversations to check when ready (10-30 seconds).`,
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
        conversation?: Record<string, unknown>
        timedOut?: boolean
      }
    | undefined
  if (!result?.ok) {
    debug(`[channel] spawn_conversation failed: ${result?.error}`)
    return { content: [{ type: 'text', text: result?.error || 'Failed to spawn conversation' }], isError: true }
  }
  const modeDesc = mode === 'resume' ? `resuming ${resumeId}` : 'fresh start'
  debug(
    `[channel] spawn_conversation: ${cwd} (${modeDesc}) conversation=${result.conversation ? 'ready' : 'pending'}`,
  )

  if (result.conversation) {
    const convObj = result.conversation as Record<string, unknown>
    const mismatch = convObj.modelMismatch as { requested: string; actual: string; detectedAt: number } | undefined
    const responsePayload: Record<string, unknown> = {
      status: 'ready',
      message: `Conversation spawned and connected at ${cwd} (${modeDesc})`,
      conversation_id: convObj.id,
      conversation: result.conversation,
      jobId: result.jobId,
      conversationId: result.conversationId,
    }
    if (mismatch) {
      responsePayload.modelWarning = `Requested model ${mismatch.requested} but conversation is running ${mismatch.actual}`
      responsePayload.modelMismatch = mismatch
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(responsePayload, null, 2) }],
    }
  }

  const idTrailer = [
    result.conversationId ? `conversationId=${result.conversationId}` : '',
    result.jobId ? `jobId=${result.jobId}` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const trailer = idTrailer ? ` ${idTrailer}` : ''
  return {
    content: [
      {
        type: 'text',
        text: result.timedOut
          ? `Conversation spawn sent to ${cwd} (${modeDesc}) but conversation did not connect within the rendezvous timeout. It may still be booting - use list_conversations (it will show status="spawning" until the agent host connects) or get_spawn_diagnostics to check.${trailer}`
          : `Conversation spawning at ${cwd} (${modeDesc}). It appears in list_conversations with status="spawning" until the agent host connects. Use get_spawn_diagnostics to debug if it never becomes live.${trailer}`,
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
    conversation_connected: 95,
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
      message = 'Conversation connected'
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
