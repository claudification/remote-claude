/**
 * Inter-conversation handlers: benevolent conversation operations on other
 * conversations. quit, revive, spawn, configure -- all require benevolent trust.
 */

import { randomUUID } from 'node:crypto'
import { extractProjectLabel } from '../../shared/project-uri'
import type { ConversationControlAction } from '../../shared/protocol'
import { resolveSpawnConfig } from '../../shared/spawn-defaults'
import { mapProjectTrust, type SpawnCallerContext } from '../../shared/spawn-permissions'
import { type SpawnRequest, spawnRequestSchema } from '../../shared/spawn-schema'
import { buildReviveMessage } from '../build-revive'
import { getGlobalSettings } from '../global-settings'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'
import { getProjectSettings } from '../project-settings'
import { dispatchSpawn } from '../spawn-dispatch'
import { resolveConversationTarget } from './channel-id'

/** Resolve effective effort level from project + global settings */
function resolveEffort(
  project: string,
  getProjectSettings: (project: string) => { defaultEffort?: string } | null,
): string | undefined {
  return resolveSpawnConfig({}, getProjectSettings(project), getGlobalSettings()).effort
}

const handleChannelRevive: MessageHandler = (ctx, data) => {
  const targetConversationId = data.conversationId as string
  const callerConversationId = ctx.ws.data.conversationId
  if (!targetConversationId || !callerConversationId) return

  ctx.requireBenevolent()
  const sentinel = ctx.requireSentinel()

  const target = ctx.conversations.getConversation(targetConversationId)
  if (!target) {
    ctx.reply({
      type: 'channel_revive_result',
      ok: false,
      error: 'Conversation not found. Use list_conversations to discover current sessions.',
    })
    return
  }
  if (target.status === 'active') {
    ctx.reply({ type: 'channel_revive_result', ok: false, error: 'Conversation is already active' })
    return
  }

  const conversationId = randomUUID()
  const projSettings = ctx.getProjectSettings(target.project)
  const name = target.title || projSettings?.label || extractProjectLabel(target.project)

  sentinel.send(
    JSON.stringify(
      buildReviveMessage(target, conversationId, {
        effort: resolveEffort(target.project, ctx.getProjectSettings),
      }),
    ),
  )

  // Register rendezvous
  ctx.conversations
    .addRendezvous(conversationId, callerConversationId, target.project, 'revive')
    .then(revived => {
      const callerWs = ctx.conversations.getConversationSocket(callerConversationId)
      if (callerWs) {
        callerWs.send(
          JSON.stringify({
            type: 'revive_ready',
            conversationId: revived.id,
            project: revived.project,
            conversation: revived,
          }),
        )
      }
    })
    .catch(err => {
      const callerWs = ctx.conversations.getConversationSocket(callerConversationId)
      if (callerWs) {
        callerWs.send(
          JSON.stringify({
            type: 'revive_timeout',
            conversationId,
            targetConversationId,
            project: target.project,
            error: typeof err === 'string' ? err : 'Revive rendezvous timed out',
          }),
        )
      }
    })

  ctx.reply({ type: 'channel_revive_result', ok: true, name })
  ctx.log.debug(`Benevolent revive: -> ${targetConversationId.slice(0, 8)}`)
}

const handleChannelSpawn: MessageHandler = (ctx, data) => {
  const callerConversationId = ctx.ws.data.conversationId
  if (!callerConversationId) return

  // Trust gating happens inside dispatchSpawn -- non-benevolent callers don't
  // hard-fail here, they get the in-panel approval prompt via
  // pendingSpawnApproval. Sentinel must still exist so the eventual dispatch
  // (immediate or post-approval) can land.
  ctx.requireSentinel()

  const reqId = typeof data.requestId === 'string' ? data.requestId : undefined
  const spawnPath = data.cwd as string
  if (!spawnPath || typeof spawnPath !== 'string') {
    ctx.reply({ type: 'channel_spawn_result', ok: false, error: 'Missing cwd', requestId: reqId })
    return
  }

  // Parse the full SpawnRequest from the channel_spawn payload.
  // jobId is always generated server-side by dispatchSpawn.
  const parsed = spawnRequestSchema.omit({ jobId: true }).safeParse({ ...data, cwd: spawnPath })
  if (!parsed.success) {
    ctx.reply({
      type: 'channel_spawn_result',
      ok: false,
      error: `Invalid spawn params: ${parsed.error.message}`,
      requestId: reqId,
    })
    return
  }
  const req: SpawnRequest = { ...parsed.data, headless: parsed.data.headless !== false }

  const callerProject = ctx.caller?.project ?? null
  const callerTrust = callerProject ? mapProjectTrust(getProjectSettings(callerProject)?.trustLevel) : 'trusted'
  const callerContext: SpawnCallerContext = {
    kind: 'mcp',
    hasSpawnPermission: true,
    trustLevel: callerTrust,
    callerProject: callerProject,
  }

  dispatchSpawn(req, {
    conversationStore: ctx.conversations,
    getProjectSettings,
    getGlobalSettings,
    callerContext,
    rendezvousCallerConversationId: callerConversationId,
  })
    .then(result => {
      if (result.ok) {
        ctx.reply({
          type: 'channel_spawn_result',
          ok: true,
          conversationId: result.conversationId,
          jobId: result.jobId,
          requestId: reqId,
        })
        ctx.log.debug(`Spawn dispatched: -> ${spawnPath}`)
        return
      }
      // Pending approval -- the caller's MCP tool sees a structured pending
      // response. The spawn outcome arrives later as a
      // TranscriptSpawnNotificationEntry in the caller's transcript.
      if (result.pendingApproval) {
        ctx.reply({
          type: 'channel_spawn_result',
          ok: false,
          pending: true,
          requestId: reqId,
          approvalRequestId: result.pendingApproval.requestId,
          message: result.pendingApproval.message,
        })
        ctx.log.debug(`Spawn pending approval: req=${result.pendingApproval.requestId.slice(0, 8)} -> ${spawnPath}`)
        return
      }
      ctx.reply({ type: 'channel_spawn_result', ok: false, error: result.error, requestId: reqId })
    })
    .catch((err: unknown) => {
      ctx.reply({
        type: 'channel_spawn_result',
        ok: false,
        error: err instanceof Error ? err.message : 'Spawn error',
        requestId: reqId,
      })
    })
}

const handleChannelRestart: MessageHandler = (ctx, data) => {
  const targetId = data.conversationId as string
  const callerConversationId = ctx.ws.data.conversationId
  if (!targetId || !callerConversationId) return

  ctx.requireBenevolent()

  const callerConv = ctx.conversations.getConversation(callerConversationId)
  const resolved = resolveConversationTarget(targetId, {
    callerConversationId: callerConversationId,
    getAllConversations: () => Array.from(ctx.conversations.getAllConversations()),
    getConversation: id => ctx.conversations.getConversation(id),
    findConversationByConversationId: id => ctx.conversations.findConversationByConversationId(id),
    getActiveConversationCount: id => ctx.conversations.getActiveConversationCount(id),
    getProjectSettings: p => ctx.getProjectSettings(p),
    addressBook: ctx.addressBook,
    callerProject: callerConv?.project,
  })
  const target = resolved.kind === 'resolved' ? ctx.conversations.getConversation(resolved.conversation.id) : undefined
  const targetWs =
    resolved.kind === 'resolved'
      ? ctx.conversations.findSocketByConversationId(resolved.conversation.id) ||
        ctx.conversations.getConversationSocket(resolved.conversation.id)
      : undefined

  if (!target) {
    ctx.reply({
      type: 'channel_restart_result',
      ok: false,
      error: resolved.kind !== 'resolved' ? resolved.error : 'Conversation not found',
    })
    return
  }

  // If target is already ended, just revive it directly (no need to terminate)
  if (!targetWs || target.status === 'ended') {
    const sentinel = ctx.requireSentinel()
    const conversationId = randomUUID()
    const projSettings = ctx.getProjectSettings(target.project)
    const name = target.title || projSettings?.label || extractProjectLabel(target.project)

    sentinel.send(
      JSON.stringify(
        buildReviveMessage(target, conversationId, {
          effort: resolveEffort(target.project, ctx.getProjectSettings),
        }),
      ),
    )

    ctx.conversations
      .addRendezvous(conversationId, callerConversationId, target.project, 'restart')
      .then(revived => {
        const callerWs = ctx.conversations.getConversationSocket(callerConversationId)
        callerWs?.send(
          JSON.stringify({
            type: 'restart_ready',
            conversationId: revived.id,
            project: revived.project,
            conversation: revived,
          }),
        )
      })
      .catch(err => {
        const callerWs = ctx.conversations.getConversationSocket(callerConversationId)
        callerWs?.send(
          JSON.stringify({
            type: 'restart_timeout',
            conversationId,
            project: target.project,
            error: typeof err === 'string' ? err : 'Restart rendezvous timed out',
          }),
        )
      })

    ctx.reply({ type: 'channel_restart_result', ok: true, name, alreadyEnded: true })
    ctx.log.debug(`Benevolent restart (already ended, reviving): -> ${target.id.slice(0, 8)}`)
    return
  }

  // Target is active -- determine if self-restart
  const callerConnectionId = ctx.ws.data.conversationId as string
  const targetConnectionIds = ctx.conversations.getConnectionIds(target.id)
  const targetConnectionId = targetConnectionIds[0] || ''
  const isSelfRestart = targetConnectionIds.includes(callerConnectionId) || target.id === callerConversationId

  // Store pending restart for the close handler to pick up
  ctx.conversations.addPendingRestart(targetConnectionId, {
    callerConversationId: callerConversationId,
    targetConversationId: target.id,
    project: target.project,
    isSelfRestart,
  })

  // Terminate the target. Tag with inter-conversation-restart + the calling
  // conversation as initiator so the termination log answers "which agent
  // killed this".
  targetWs.send(
    JSON.stringify({
      type: 'terminate_conversation',
      conversationId: target.id,
      source: 'inter-conversation-restart',
      initiator: callerConversationId ? `agent:${callerConversationId}` : undefined,
    }),
  )

  const projSettings = ctx.getProjectSettings(target.project)
  const name = target.title || projSettings?.label || extractProjectLabel(target.project)
  ctx.reply({ type: 'channel_restart_result', ok: true, name, selfRestart: isSelfRestart })
  ctx.log.debug(`Benevolent restart: -> ${target.id.slice(0, 8)} (${isSelfRestart ? 'self' : 'remote'})`)
}

const handleChannelConfigure: MessageHandler = (ctx, data) => {
  const targetId = data.conversationId as string
  if (!targetId) {
    ctx.reply({ type: 'channel_configure_result', ok: false, error: 'Missing target ID' })
    return
  }

  ctx.requireBenevolent()

  const callerConversationId = ctx.ws.data.conversationId
  const callerConv = callerConversationId ? ctx.conversations.getConversation(callerConversationId) : undefined
  const resolved = resolveConversationTarget(targetId, {
    callerConversationId: callerConversationId,
    getAllConversations: () => Array.from(ctx.conversations.getAllConversations()),
    getConversation: id => ctx.conversations.getConversation(id),
    findConversationByConversationId: id => ctx.conversations.findConversationByConversationId(id),
    getActiveConversationCount: id => ctx.conversations.getActiveConversationCount(id),
    getProjectSettings: p => ctx.getProjectSettings(p),
    addressBook: ctx.addressBook,
    callerProject: callerConv?.project,
  })
  const target = resolved.kind === 'resolved' ? ctx.conversations.getConversation(resolved.conversation.id) : undefined
  if (!target) {
    ctx.reply({
      type: 'channel_configure_result',
      ok: false,
      error: resolved.kind !== 'resolved' ? resolved.error : 'Conversation not found.',
    })
    return
  }

  // Build update -- NEVER allow trustLevel changes via MCP
  const update: Record<string, unknown> = {}
  if (data.label !== undefined) update.label = data.label
  if (data.icon !== undefined) update.icon = data.icon
  if (data.color !== undefined) update.color = data.color
  if (data.keyterms !== undefined) update.keyterms = data.keyterms

  if (Object.keys(update).length === 0) {
    ctx.reply({ type: 'channel_configure_result', ok: false, error: 'No settings to update' })
    return
  }

  ctx.setProjectSettings(target.project, update as Record<string, string>)
  ctx.broadcast({ type: 'project_settings_updated', settings: ctx.getAllProjectSettings() })
  ctx.reply({ type: 'channel_configure_result', ok: true })
  ctx.log.debug(`Configure: -> ${target.id.slice(0, 8)} ${Object.keys(update).join(',')}`)
}

// ─── Unified conversation control ───

const VALID_CONTROL_ACTIONS = new Set(['clear', 'quit', 'interrupt', 'set_model', 'set_effort', 'set_permission_mode'])

const handleConversationControl: MessageHandler = (ctx, data) => {
  const targetId = data.targetConversation as string
  const action = data.action as string
  const model = typeof data.model === 'string' ? data.model : undefined
  const effort = typeof data.effort === 'string' ? data.effort : undefined
  const permissionMode = typeof data.permissionMode === 'string' ? data.permissionMode : undefined
  const fromConversation = (data.fromConversation as string) || ctx.ws.data.conversationId

  if (!targetId) {
    ctx.reply({ type: 'conversation_control_result', ok: false, error: 'Missing targetConversation' })
    return
  }
  if (!VALID_CONTROL_ACTIONS.has(action)) {
    ctx.reply({ type: 'conversation_control_result', ok: false, action, error: `Unknown action "${action}"` })
    return
  }
  if (action === 'set_model' && !model) {
    ctx.reply({ type: 'conversation_control_result', ok: false, action, error: 'model is required for set_model' })
    return
  }
  if (action === 'set_effort' && !effort) {
    ctx.reply({ type: 'conversation_control_result', ok: false, action, error: 'effort is required for set_effort' })
    return
  }
  if (action === 'set_permission_mode' && !permissionMode) {
    ctx.reply({
      type: 'conversation_control_result',
      ok: false,
      action,
      error: 'permissionMode is required for set_permission_mode',
    })
    return
  }

  // Resolve target: compound ID (project:conversation-slug), bare slug, or raw internal ID
  const callerConversationId = ctx.ws.data.conversationId
  const callerConv = callerConversationId ? ctx.conversations.getConversation(callerConversationId) : undefined
  const resolved = resolveConversationTarget(targetId, {
    callerConversationId: callerConversationId,
    getAllConversations: () => Array.from(ctx.conversations.getAllConversations()),
    getConversation: id => ctx.conversations.getConversation(id),
    findConversationByConversationId: id => ctx.conversations.findConversationByConversationId(id),
    getActiveConversationCount: id => ctx.conversations.getActiveConversationCount(id),
    getProjectSettings: p => ctx.getProjectSettings(p),
    addressBook: ctx.addressBook,
    callerProject: callerConv?.project,
  })
  if (resolved.kind !== 'resolved') {
    ctx.reply({ type: 'conversation_control_result', ok: false, action, error: resolved.error })
    return
  }
  const targetSess = ctx.conversations.getConversation(resolved.conversation.id)
  const targetWs =
    ctx.conversations.findSocketByConversationId(resolved.conversation.id) ||
    ctx.conversations.getConversationSocket(resolved.conversation.id)
  if (!targetSess || !targetWs) {
    ctx.reply({
      type: 'conversation_control_result',
      ok: false,
      action,
      error: 'Target not connected. Use list_conversations to find current sessions.',
    })
    return
  }
  if (targetSess.status === 'ended') {
    ctx.reply({ type: 'conversation_control_result', ok: false, action, error: 'Conversation has ended' })
    return
  }

  // Auth: dashboard needs chat permission on target project; inter-conversation needs benevolent.
  if (ctx.ws.data.isControlPanel) {
    ctx.requirePermission('chat', targetSess.project)
  } else if (ctx.ws.data.conversationId) {
    ctx.requireBenevolent()
  } else {
    ctx.reply({ type: 'conversation_control_result', ok: false, action, error: 'Not authorized' })
    return
  }

  targetWs.send(
    JSON.stringify({
      type: 'control',
      action,
      ...(model && { model }),
      ...(effort && { effort }),
      ...(permissionMode && { permissionMode }),
      ...(fromConversation && { fromConversation }),
    }),
  )

  // For interrupt, mark idle immediately (matches send_interrupt behavior -- CC won't fire Stop).
  if (action === 'interrupt') {
    targetSess.status = 'idle'
    ctx.conversations.broadcastConversationUpdate(targetSess.id)
  }

  // Runtime model change: update launchConfig so the mismatch check in
  // transcript.ts doesn't fire a false warning on the next init.
  if (action === 'set_model' && model && targetSess.launchConfig) {
    targetSess.launchConfig.model = model
    targetSess.modelMismatch = undefined
  }

  ctx.reply({
    type: 'conversation_control_result',
    ok: true,
    action: action as ConversationControlAction,
    name: targetSess.title || extractProjectLabel(targetSess.project),
  })
  ctx.log.debug(
    `conversation_control: ${fromConversation?.slice(0, 8) ?? 'dashboard'} -> ${targetSess.id.slice(0, 8)} action=${action}${model ? ` model=${model}` : ''}${effort ? ` effort=${effort}` : ''}${permissionMode ? ` mode=${permissionMode}` : ''}`,
  )
}

export function registerInterConversationHandlers(): void {
  registerHandlers({
    channel_revive: handleChannelRevive,
    channel_spawn: handleChannelSpawn,
    channel_restart: handleChannelRestart,
    channel_configure: handleChannelConfigure,
    conversation_control: handleConversationControl,
  })
}
