/**
 * Inter-session handlers: benevolent session operations on other sessions.
 * quit, revive, spawn, configure -- all require benevolent trust.
 */

import { randomUUID } from 'node:crypto'
import { extractProjectLabel } from '../../shared/project-uri'
import type { ConversationControlAction } from '../../shared/protocol'
import { resolveSpawnConfig } from '../../shared/spawn-defaults'
import { mapProjectTrust, type SpawnCallerContext } from '../../shared/spawn-permissions'
import { type SpawnRequest, spawnRequestSchema } from '../../shared/spawn-schema'
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
  const targetSessionId = data.sessionId as string
  const callerSession = ctx.ws.data.conversationId
  if (!targetSessionId || !callerSession) return

  ctx.requireBenevolent()
  const sentinel = ctx.requireSentinel()

  const target = ctx.conversations.getConversation(targetSessionId)
  if (!target) {
    ctx.reply({
      type: 'channel_revive_result',
      ok: false,
      error: 'Session not found. Use list_sessions to discover current sessions.',
    })
    return
  }
  if (target.status === 'active') {
    ctx.reply({ type: 'channel_revive_result', ok: false, error: 'Session is already active' })
    return
  }

  const conversationId = randomUUID()
  const projSettings = ctx.getProjectSettings(target.project)
  const name = target.title || projSettings?.label || extractProjectLabel(target.project)

  sentinel.send(
    JSON.stringify({
      type: 'revive',
      sessionId: targetSessionId,
      project: target.project,
      conversationId,
      mode: 'resume',
      effort: resolveEffort(target.project, ctx.getProjectSettings),
      sessionName: target.title || undefined,
      adHocWorktree: target.adHocWorktree || undefined,
    }),
  )

  // Register rendezvous
  ctx.conversations
    .addRendezvous(conversationId, callerSession, target.project, 'revive')
    .then(revived => {
      const callerWs = ctx.conversations.getConversationSocket(callerSession)
      if (callerWs) {
        callerWs.send(
          JSON.stringify({
            type: 'revive_ready',
            sessionId: revived.id,
            project: revived.project,
            conversationId,
            session: revived,
          }),
        )
      }
    })
    .catch(err => {
      const callerWs = ctx.conversations.getConversationSocket(callerSession)
      if (callerWs) {
        callerWs.send(
          JSON.stringify({
            type: 'revive_timeout',
            conversationId,
            sessionId: targetSessionId,
            project: target.project,
            error: typeof err === 'string' ? err : 'Revive rendezvous timed out',
          }),
        )
      }
    })

  ctx.reply({ type: 'channel_revive_result', ok: true, name })
  ctx.log.debug(`Benevolent revive: -> ${targetSessionId.slice(0, 8)}`)
}

const handleChannelSpawn: MessageHandler = (ctx, data) => {
  const callerSession = ctx.ws.data.conversationId
  if (!callerSession) return

  ctx.requireBenevolent()
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
    sessions: ctx.conversations,
    getProjectSettings,
    getGlobalSettings,
    callerContext,
    rendezvousCallerSessionId: callerSession,
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
        ctx.log.debug(`Benevolent spawn: -> ${spawnPath}`)
      } else {
        ctx.reply({ type: 'channel_spawn_result', ok: false, error: result.error, requestId: reqId })
      }
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
  const targetId = data.sessionId as string
  const callerSession = ctx.ws.data.conversationId
  if (!targetId || !callerSession) return

  ctx.requireBenevolent()

  const callerSess = ctx.conversations.getConversation(callerSession)
  const resolved = resolveConversationTarget(targetId, {
    callerSessionId: callerSession,
    getAllConversations: () => Array.from(ctx.conversations.getAllConversations()),
    getConversation: id => ctx.conversations.getConversation(id),
    findConversationByConversationId: id => ctx.conversations.findConversationByConversationId(id),
    getActiveConversationCount: id => ctx.conversations.getActiveConversationCount(id),
    getProjectSettings: p => ctx.getProjectSettings(p),
    addressBook: ctx.addressBook,
    callerProject: callerSess?.project,
  })
  const target = resolved.kind === 'resolved' ? ctx.conversations.getConversation(resolved.session.id) : undefined
  const targetWs =
    resolved.kind === 'resolved'
      ? ctx.conversations.findSocketByConversationId(resolved.session.id) ||
        ctx.conversations.getConversationSocket(resolved.session.id)
      : undefined

  if (!target) {
    ctx.reply({
      type: 'channel_restart_result',
      ok: false,
      error: resolved.kind !== 'resolved' ? resolved.error : 'Session not found',
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
      JSON.stringify({
        type: 'revive',
        sessionId: target.id,
        project: target.project,
        conversationId,
        mode: 'resume',
        effort: resolveEffort(target.project, ctx.getProjectSettings),
        sessionName: target.title || undefined,
      }),
    )

    ctx.conversations
      .addRendezvous(conversationId, callerSession, target.project, 'restart')
      .then(revived => {
        const callerWs = ctx.conversations.getConversationSocket(callerSession)
        callerWs?.send(
          JSON.stringify({
            type: 'restart_ready',
            sessionId: revived.id,
            project: revived.project,
            conversationId,
            session: revived,
          }),
        )
      })
      .catch(err => {
        const callerWs = ctx.conversations.getConversationSocket(callerSession)
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
  const callerWrapper = ctx.ws.data.conversationId as string
  const targetCcSessionIds = ctx.conversations.getCcSessionIds(target.id)
  const targetWrapper = targetCcSessionIds[0] || ''
  const isSelfRestart = targetCcSessionIds.includes(callerWrapper) || target.id === callerSession

  // Store pending restart for the close handler to pick up
  ctx.conversations.addPendingRestart(targetWrapper, {
    callerSessionId: callerSession,
    targetSessionId: target.id,
    project: target.project,
    isSelfRestart,
  })

  // Terminate the target
  targetWs.send(JSON.stringify({ type: 'terminate_conversation', sessionId: target.id }))

  const projSettings = ctx.getProjectSettings(target.project)
  const name = target.title || projSettings?.label || extractProjectLabel(target.project)
  ctx.reply({ type: 'channel_restart_result', ok: true, name, selfRestart: isSelfRestart })
  ctx.log.debug(`Benevolent restart: -> ${target.id.slice(0, 8)} (${isSelfRestart ? 'self' : 'remote'})`)
}

const handleChannelConfigure: MessageHandler = (ctx, data) => {
  const targetId = data.sessionId as string
  if (!targetId) {
    ctx.reply({ type: 'channel_configure_result', ok: false, error: 'Missing target ID' })
    return
  }

  ctx.requireBenevolent()

  const callerSession = ctx.ws.data.conversationId
  const callerSess = callerSession ? ctx.conversations.getConversation(callerSession) : undefined
  const resolved = resolveConversationTarget(targetId, {
    callerSessionId: callerSession,
    getAllConversations: () => Array.from(ctx.conversations.getAllConversations()),
    getConversation: id => ctx.conversations.getConversation(id),
    findConversationByConversationId: id => ctx.conversations.findConversationByConversationId(id),
    getActiveConversationCount: id => ctx.conversations.getActiveConversationCount(id),
    getProjectSettings: p => ctx.getProjectSettings(p),
    addressBook: ctx.addressBook,
    callerProject: callerSess?.project,
  })
  const target = resolved.kind === 'resolved' ? ctx.conversations.getConversation(resolved.session.id) : undefined
  if (!target) {
    ctx.reply({
      type: 'channel_configure_result',
      ok: false,
      error: resolved.kind !== 'resolved' ? resolved.error : 'Session not found.',
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

// ─── Unified session control ───

const VALID_CONTROL_ACTIONS = new Set(['clear', 'quit', 'interrupt', 'set_model', 'set_effort', 'set_permission_mode'])

const handleSessionControl: MessageHandler = (ctx, data) => {
  const targetId = data.targetSession as string
  const action = data.action as string
  const model = typeof data.model === 'string' ? data.model : undefined
  const effort = typeof data.effort === 'string' ? data.effort : undefined
  const permissionMode = typeof data.permissionMode === 'string' ? data.permissionMode : undefined
  const fromSession = (data.fromSession as string) || ctx.ws.data.conversationId

  if (!targetId) {
    ctx.reply({ type: 'conversation_control_result', ok: false, error: 'Missing targetSession' })
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

  // Resolve target: compound ID (project:session-slug), bare slug, or raw internal ID
  const callerSession = ctx.ws.data.conversationId
  const callerSess = callerSession ? ctx.conversations.getConversation(callerSession) : undefined
  const resolved = resolveConversationTarget(targetId, {
    callerSessionId: callerSession,
    getAllConversations: () => Array.from(ctx.conversations.getAllConversations()),
    getConversation: id => ctx.conversations.getConversation(id),
    findConversationByConversationId: id => ctx.conversations.findConversationByConversationId(id),
    getActiveConversationCount: id => ctx.conversations.getActiveConversationCount(id),
    getProjectSettings: p => ctx.getProjectSettings(p),
    addressBook: ctx.addressBook,
    callerProject: callerSess?.project,
  })
  if (resolved.kind !== 'resolved') {
    ctx.reply({ type: 'conversation_control_result', ok: false, action, error: resolved.error })
    return
  }
  const targetSess = ctx.conversations.getConversation(resolved.session.id)
  const targetWs =
    ctx.conversations.findSocketByConversationId(resolved.session.id) ||
    ctx.conversations.getConversationSocket(resolved.session.id)
  if (!targetSess || !targetWs) {
    ctx.reply({
      type: 'conversation_control_result',
      ok: false,
      action,
      error: 'Target not connected. Use list_sessions to find current sessions.',
    })
    return
  }
  if (targetSess.status === 'ended') {
    ctx.reply({ type: 'conversation_control_result', ok: false, action, error: 'Session has ended' })
    return
  }

  // Auth: dashboard needs chat permission on target project; inter-session needs benevolent.
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
      ...(fromSession && { fromSession }),
    }),
  )

  // For interrupt, mark idle immediately (matches send_interrupt behavior -- CC won't fire Stop).
  if (action === 'interrupt') {
    targetSess.status = 'idle'
    ctx.conversations.broadcastConversationUpdate(targetSess.id)
  }

  ctx.reply({
    type: 'conversation_control_result',
    ok: true,
    action: action as ConversationControlAction,
    name: targetSess.title || extractProjectLabel(targetSess.project),
  })
  ctx.log.debug(
    `session_control: ${fromSession?.slice(0, 8) ?? 'dashboard'} -> ${targetSess.id.slice(0, 8)} action=${action}${model ? ` model=${model}` : ''}${effort ? ` effort=${effort}` : ''}${permissionMode ? ` mode=${permissionMode}` : ''}`,
  )
}

export function registerInterConversationHandlers(): void {
  registerHandlers({
    channel_revive: handleChannelRevive,
    channel_spawn: handleChannelSpawn,
    channel_restart: handleChannelRestart,
    channel_configure: handleChannelConfigure,
    session_control: handleSessionControl,
  })
}
