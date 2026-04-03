/**
 * Inter-session handlers: benevolent session operations on other sessions.
 * quit, revive, spawn, configure -- all require benevolent trust.
 */

import { randomUUID } from 'node:crypto'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

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
      mode: 'continue',
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
  const agent = ctx.requireAgent()

  const cwd = data.cwd as string
  if (!cwd || typeof cwd !== 'string') {
    ctx.reply({ type: 'channel_spawn_result', ok: false, error: 'Missing cwd' })
    return
  }
  if (data.mode === 'resume' && !data.resumeId) {
    ctx.reply({ type: 'channel_spawn_result', ok: false, error: 'resumeId required for resume mode' })
    return
  }

  const requestId = randomUUID()
  const wrapperId = randomUUID()

  const spawnPromise = new Promise<{ success?: boolean; error?: string; tmuxSession?: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ctx.sessions.removeSpawnListener(requestId)
      reject(new Error('Spawn timed out (15s)'))
    }, 15000)
    ctx.sessions.addSpawnListener(requestId, msg => {
      clearTimeout(timeout)
      resolve(msg as { success?: boolean; error?: string; tmuxSession?: string })
    })
    agent.send(
      JSON.stringify({
        type: 'spawn',
        requestId,
        cwd,
        wrapperId,
        mkdir: !!data.mkdir,
        mode: data.mode,
        resumeId: data.resumeId,
      }),
    )
  })

  spawnPromise
    .then(result => {
      if (!result.success) {
        ctx.reply({ type: 'channel_spawn_result', ok: false, error: result.error || 'Spawn failed' })
        return
      }

      // Register rendezvous
      ctx.sessions
        .addRendezvous(wrapperId, callerSession, cwd, 'spawn')
        .then(session => {
          const callerWs = ctx.sessions.getSessionSocket(callerSession)
          if (callerWs) {
            callerWs.send(
              JSON.stringify({
                type: 'spawn_ready',
                sessionId: session.id,
                cwd: session.cwd,
                wrapperId,
                session,
              }),
            )
          }
        })
        .catch(err => {
          const callerWs = ctx.sessions.getSessionSocket(callerSession)
          if (callerWs) {
            callerWs.send(
              JSON.stringify({
                type: 'spawn_timeout',
                wrapperId,
                cwd,
                error: typeof err === 'string' ? err : 'Spawn rendezvous timed out',
              }),
            )
          }
        })

      ctx.reply({ type: 'channel_spawn_result', ok: true, wrapperId })
      ctx.log.debug(`Benevolent spawn: -> ${cwd}`)
    })
    .catch(err => {
      ctx.reply({
        type: 'channel_spawn_result',
        ok: false,
        error: err instanceof Error ? err.message : 'Spawn error',
      })
    })
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
    channel_configure: handleChannelConfigure,
  })
}
