/**
 * Inter-session handlers: benevolent session operations on other sessions.
 * quit, revive, spawn, configure -- all require benevolent trust.
 */

import { randomUUID } from 'node:crypto'
import { resolveSpawnConfig } from '../../shared/spawn-defaults'
import { mapProjectTrust, type SpawnCallerContext } from '../../shared/spawn-permissions'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { getGlobalSettings } from '../global-settings'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'
import { getProjectSettings } from '../project-settings'
import { dispatchSpawn } from '../spawn-dispatch'

/** Resolve effective effort level from project + global settings */
function resolveEffort(
  cwd: string,
  getProjectSettings: (cwd: string) => { defaultEffort?: string } | null,
): string | undefined {
  return resolveSpawnConfig({}, getProjectSettings(cwd), getGlobalSettings()).effort
}

const handleQuitRemoteSession: MessageHandler = (ctx, data) => {
  const targetId = data.targetSession as string
  const fromSession = (data.fromSession as string) || ctx.ws.data.sessionId
  if (!targetId) return

  ctx.requireBenevolent()

  // Resolve target: wrapper ID first, then session ID
  const targetSess = ctx.sessions.getSessionByWrapper(targetId) || ctx.sessions.getSession(targetId)
  const targetWs = ctx.sessions.getSessionSocketByWrapper(targetId) || ctx.sessions.getSessionSocket(targetId)
  if (!targetWs || !targetSess) {
    ctx.reply({
      type: 'quit_remote_result',
      ok: false,
      error: 'Target not connected. Use list_sessions to find current sessions.',
    })
    return
  }

  targetWs.send(JSON.stringify({ type: 'terminate_session', sessionId: targetSess.id }))
  ctx.reply({
    type: 'quit_remote_result',
    ok: true,
    name: targetSess.title || targetSess.cwd?.split('/').pop(),
  })
  ctx.log.debug(`Benevolent quit: ${fromSession?.slice(0, 8)} -> ${targetSess.id.slice(0, 8)}`)
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

  // Build a SpawnRequest from the narrower channel_spawn payload.
  // Inter-session callers today only pass cwd/mkdir/mode/resumeId/headless.
  // `effort` is resolved from project/global settings inside dispatchSpawn.
  //
  // jobId flows through when the caller wants to track the spawn: the MCP
  // wrapper subscribes before sending channel_spawn so it can receive
  // launch_progress events and forward them as notifications/progress.
  const req: SpawnRequest = {
    cwd,
    mkdir: !!data.mkdir,
    mode: (data.mode as SpawnRequest['mode']) || 'fresh',
    resumeId: typeof data.resumeId === 'string' ? data.resumeId : undefined,
    headless: data.headless !== false,
    jobId: typeof data.jobId === 'string' ? data.jobId : undefined,
  }

  // Inter-session callers are always another session acting MCP-style --
  // `requireBenevolent()` above already enforces the trust floor, but
  // dispatchSpawn re-validates via assertSpawnAllowed for belt-and-braces.
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
    callerContext,
    rendezvousCallerSessionId: callerSession,
  })
    .then(result => {
      if (result.ok) {
        ctx.reply({ type: 'channel_spawn_result', ok: true, wrapperId: result.wrapperId, jobId: req.jobId })
        ctx.log.debug(`Benevolent spawn: -> ${cwd}`)
      } else {
        ctx.reply({ type: 'channel_spawn_result', ok: false, error: result.error, jobId: req.jobId })
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

export function registerInterSessionHandlers(): void {
  registerHandlers({
    quit_remote_session: handleQuitRemoteSession,
    channel_revive: handleChannelRevive,
    channel_spawn: handleChannelSpawn,
    channel_restart: handleChannelRestart,
    channel_configure: handleChannelConfigure,
  })
}
