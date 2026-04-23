/**
 * Inter-session handlers: benevolent session operations on other sessions.
 * quit, revive, spawn, configure -- all require benevolent trust.
 */

import { randomUUID } from 'node:crypto'
import type { SessionControlAction } from '../../shared/protocol'
import { resolveSpawnConfig } from '../../shared/spawn-defaults'
import { mapProjectTrust, type SpawnCallerContext } from '../../shared/spawn-permissions'
import { type SpawnRequest, spawnRequestSchema } from '../../shared/spawn-schema'
import { getGlobalSettings } from '../global-settings'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'
import { getProjectSettings, setProjectSettings } from '../project-settings'
import { dispatchSpawn } from '../spawn-dispatch'

/** Resolve effective effort level from project + global settings */
function resolveEffort(
  cwd: string,
  getProjectSettings: (cwd: string) => { defaultEffort?: string } | null,
): string | undefined {
  return resolveSpawnConfig({}, getProjectSettings(cwd), getGlobalSettings()).effort
}

const handleChannelRevive: MessageHandler = (ctx, data) => {
  const targetSessionId = data.sessionId as string
  const callerSession = ctx.ws.data.sessionId
  if (!targetSessionId || !callerSession) return

  ctx.requireBenevolent()
  const agent = ctx.requireAgent()

  const target = ctx.sessions.getSession(targetSessionId)
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

  const wrapperId = randomUUID()
  const projSettings = ctx.getProjectSettings(target.cwd)
  const name = target.title || projSettings?.label || target.cwd.split('/').pop() || targetSessionId.slice(0, 8)

  agent.send(
    JSON.stringify({
      type: 'revive',
      sessionId: targetSessionId,
      cwd: target.cwd,
      wrapperId,
      mode: 'resume',
      effort: resolveEffort(target.cwd, ctx.getProjectSettings),
      sessionName: target.title || undefined,
      adHocWorktree: target.adHocWorktree || undefined,
    }),
  )

  // Register rendezvous
  ctx.sessions
    .addRendezvous(wrapperId, callerSession, target.cwd, 'revive')
    .then(revived => {
      const callerWs = ctx.sessions.getSessionSocket(callerSession)
      if (callerWs) {
        callerWs.send(
          JSON.stringify({
            type: 'revive_ready',
            sessionId: revived.id,
            cwd: revived.cwd,
            wrapperId,
            session: revived,
          }),
        )
      }
    })
    .catch(err => {
      const callerWs = ctx.sessions.getSessionSocket(callerSession)
      if (callerWs) {
        callerWs.send(
          JSON.stringify({
            type: 'revive_timeout',
            wrapperId,
            sessionId: targetSessionId,
            cwd: target.cwd,
            error: typeof err === 'string' ? err : 'Revive rendezvous timed out',
          }),
        )
      }
    })

  ctx.reply({ type: 'channel_revive_result', ok: true, name })
  ctx.log.debug(`Benevolent revive: -> ${targetSessionId.slice(0, 8)}`)
}

const handleChannelSpawn: MessageHandler = (ctx, data) => {
  const callerSession = ctx.ws.data.sessionId
  if (!callerSession) return

  ctx.requireBenevolent()
  ctx.requireAgent()

  const cwd = data.cwd as string
  if (!cwd || typeof cwd !== 'string') {
    ctx.reply({ type: 'channel_spawn_result', ok: false, error: 'Missing cwd' })
    return
  }

  // Parse the full SpawnRequest from the channel_spawn payload.
  // jobId is always generated server-side by dispatchSpawn.
  const parsed = spawnRequestSchema.omit({ jobId: true }).safeParse({ ...data, cwd })
  if (!parsed.success) {
    ctx.reply({ type: 'channel_spawn_result', ok: false, error: `Invalid spawn params: ${parsed.error.message}` })
    return
  }
  const req: SpawnRequest = { ...parsed.data, headless: parsed.data.headless !== false }

  const callerCwd = ctx.caller?.cwd ?? null
  const callerTrust = callerCwd ? mapProjectTrust(getProjectSettings(callerCwd)?.trustLevel) : 'trusted'
  const callerContext: SpawnCallerContext = {
    kind: 'mcp',
    hasSpawnPermission: true,
    trustLevel: callerTrust,
    cwd: callerCwd,
  }

  dispatchSpawn(req, {
    sessions: ctx.sessions,
    getProjectSettings,
    getGlobalSettings,
    setProjectSettings,
    callerContext,
    rendezvousCallerSessionId: callerSession,
  })
    .then(result => {
      if (result.ok) {
        ctx.reply({ type: 'channel_spawn_result', ok: true, wrapperId: result.wrapperId, jobId: result.jobId })
        ctx.log.debug(`Benevolent spawn: -> ${cwd}`)
      } else {
        ctx.reply({ type: 'channel_spawn_result', ok: false, error: result.error })
      }
    })
    .catch((err: unknown) => {
      ctx.reply({
        type: 'channel_spawn_result',
        ok: false,
        error: err instanceof Error ? err.message : 'Spawn error',
      })
    })
}

const handleChannelRestart: MessageHandler = (ctx, data) => {
  const targetId = data.sessionId as string
  const callerSession = ctx.ws.data.sessionId
  if (!targetId || !callerSession) return

  ctx.requireBenevolent()

  // Resolve target session and socket
  const target = ctx.sessions.getSessionByWrapper(targetId) || ctx.sessions.getSession(targetId)
  const targetWs = ctx.sessions.getSessionSocketByWrapper(targetId) || ctx.sessions.getSessionSocket(targetId)

  if (!target) {
    ctx.reply({ type: 'channel_restart_result', ok: false, error: 'Session not found' })
    return
  }

  // If target is already ended, just revive it directly (no need to terminate)
  if (!targetWs || target.status === 'ended') {
    const agent = ctx.requireAgent()
    const wrapperId = randomUUID()
    const projSettings = ctx.getProjectSettings(target.cwd)
    const name = target.title || projSettings?.label || target.cwd.split('/').pop() || targetId.slice(0, 8)

    agent.send(
      JSON.stringify({
        type: 'revive',
        sessionId: target.id,
        cwd: target.cwd,
        wrapperId,
        mode: 'resume',
        effort: resolveEffort(target.cwd, ctx.getProjectSettings),
        sessionName: target.title || undefined,
      }),
    )

    ctx.sessions
      .addRendezvous(wrapperId, callerSession, target.cwd, 'restart')
      .then(revived => {
        const callerWs = ctx.sessions.getSessionSocket(callerSession)
        callerWs?.send(
          JSON.stringify({
            type: 'restart_ready',
            sessionId: revived.id,
            cwd: revived.cwd,
            wrapperId,
            session: revived,
          }),
        )
      })
      .catch(err => {
        const callerWs = ctx.sessions.getSessionSocket(callerSession)
        callerWs?.send(
          JSON.stringify({
            type: 'restart_timeout',
            wrapperId,
            cwd: target.cwd,
            error: typeof err === 'string' ? err : 'Restart rendezvous timed out',
          }),
        )
      })

    ctx.reply({ type: 'channel_restart_result', ok: true, name, alreadyEnded: true })
    ctx.log.debug(`Benevolent restart (already ended, reviving): -> ${target.id.slice(0, 8)}`)
    return
  }

  // Target is active -- determine if self-restart
  const callerWrapper = ctx.ws.data.wrapperId as string
  const targetWrapperIds = ctx.sessions.getWrapperIds(target.id)
  const targetWrapper = targetWrapperIds[0] || ''
  const isSelfRestart = targetWrapperIds.includes(callerWrapper) || target.id === callerSession

  // Store pending restart for the close handler to pick up
  ctx.sessions.addPendingRestart(targetWrapper, {
    callerSessionId: callerSession,
    targetSessionId: target.id,
    cwd: target.cwd,
    isSelfRestart,
  })

  // Terminate the target
  targetWs.send(JSON.stringify({ type: 'terminate_session', sessionId: target.id }))

  const projSettings = ctx.getProjectSettings(target.cwd)
  const name = target.title || projSettings?.label || target.cwd.split('/').pop() || targetId.slice(0, 8)
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

  // Resolve target: wrapper ID first, then session ID
  const target = ctx.sessions.getSessionByWrapper(targetId) || ctx.sessions.getSession(targetId)
  if (!target) {
    ctx.reply({
      type: 'channel_configure_result',
      ok: false,
      error: 'Session not found. Use list_sessions to discover current sessions.',
    })
    return
  }

  // Build update -- NEVER allow trustLevel changes via MCP
  const update: Record<string, unknown> = {}
  if (data.label !== undefined) update.label = data.label
  if (data.icon !== undefined) update.icon = data.icon
  if (data.color !== undefined) update.color = data.color
  if (data.description !== undefined) update.description = data.description
  if (data.keyterms !== undefined) update.keyterms = data.keyterms

  if (Object.keys(update).length === 0) {
    ctx.reply({ type: 'channel_configure_result', ok: false, error: 'No settings to update' })
    return
  }

  ctx.setProjectSettings(target.cwd, update as Record<string, string>)
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
  const fromSession = (data.fromSession as string) || ctx.ws.data.sessionId

  if (!targetId) {
    ctx.reply({ type: 'session_control_result', ok: false, error: 'Missing targetSession' })
    return
  }
  if (!VALID_CONTROL_ACTIONS.has(action)) {
    ctx.reply({ type: 'session_control_result', ok: false, action, error: `Unknown action "${action}"` })
    return
  }
  if (action === 'set_model' && !model) {
    ctx.reply({ type: 'session_control_result', ok: false, action, error: 'model is required for set_model' })
    return
  }
  if (action === 'set_effort' && !effort) {
    ctx.reply({ type: 'session_control_result', ok: false, action, error: 'effort is required for set_effort' })
    return
  }
  if (action === 'set_permission_mode' && !permissionMode) {
    ctx.reply({
      type: 'session_control_result',
      ok: false,
      action,
      error: 'permissionMode is required for set_permission_mode',
    })
    return
  }

  // Resolve target: wrapper ID first, then session ID
  const targetSess = ctx.sessions.getSessionByWrapper(targetId) || ctx.sessions.getSession(targetId)
  const targetWs = ctx.sessions.getSessionSocketByWrapper(targetId) || ctx.sessions.getSessionSocket(targetId)
  if (!targetSess || !targetWs) {
    ctx.reply({
      type: 'session_control_result',
      ok: false,
      action,
      error: 'Target not connected. Use list_sessions to find current sessions.',
    })
    return
  }
  if (targetSess.status === 'ended') {
    ctx.reply({ type: 'session_control_result', ok: false, action, error: 'Session has ended' })
    return
  }

  // Auth: dashboard needs chat permission on target cwd; inter-session needs benevolent.
  if (ctx.ws.data.isDashboard) {
    ctx.requirePermission('chat', targetSess.cwd)
  } else if (ctx.ws.data.sessionId) {
    ctx.requireBenevolent()
  } else {
    ctx.reply({ type: 'session_control_result', ok: false, action, error: 'Not authorized' })
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
    ctx.sessions.broadcastSessionUpdate(targetSess.id)
  }

  ctx.reply({
    type: 'session_control_result',
    ok: true,
    action: action as SessionControlAction,
    name: targetSess.title || targetSess.cwd?.split('/').pop(),
  })
  ctx.log.debug(
    `session_control: ${fromSession?.slice(0, 8) ?? 'dashboard'} -> ${targetSess.id.slice(0, 8)} action=${action}${model ? ` model=${model}` : ''}${effort ? ` effort=${effort}` : ''}${permissionMode ? ` mode=${permissionMode}` : ''}`,
  )
}

export function registerInterSessionHandlers(): void {
  registerHandlers({
    channel_revive: handleChannelRevive,
    channel_spawn: handleChannelSpawn,
    channel_restart: handleChannelRestart,
    channel_configure: handleChannelConfigure,
    session_control: handleSessionControl,
  })
}
