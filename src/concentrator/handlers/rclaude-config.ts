/**
 * Handlers for .rclaude/rclaude.json config read/write via the wrapper.
 *
 * Follows the same pattern as file_request/file_save:
 *   dashboard -> concentrator -> wrapper (by CWD) -> filesystem
 *   wrapper response -> concentrator -> broadcastScoped to dashboard
 *
 * After a successful save, broadcasts notify_config_updated to all
 * wrappers at the target CWD so they hot-reload permission rules.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

function findWrapperSocketByCwd(ctx: Parameters<MessageHandler>[0], cwd: string) {
  for (const session of ctx.sessions.getAllSessions()) {
    if (session.cwd !== cwd) continue
    const socket = ctx.sessions.getSessionSocket(session.id)
    if (socket) return { socket, session }
  }
  return undefined
}

const rclaudeConfigGet: MessageHandler = (ctx, data) => {
  const cwd = data.cwd as string
  if (!cwd) return
  ctx.requirePermission('settings', cwd)

  const target = findWrapperSocketByCwd(ctx, cwd)
  if (target) {
    target.socket.send(JSON.stringify(data))
  } else {
    ctx.reply({
      type: 'rclaude_config_data',
      requestId: data.requestId,
      config: null,
      cwd,
      error: 'No session connected at this CWD',
    })
  }
}

const rclaudeConfigSet: MessageHandler = (ctx, data) => {
  const cwd = data.cwd as string
  if (!cwd) return
  ctx.requirePermission('settings', cwd)

  const target = findWrapperSocketByCwd(ctx, cwd)
  if (target) {
    target.socket.send(JSON.stringify(data))
  } else {
    ctx.reply({
      type: 'rclaude_config_ok',
      requestId: data.requestId,
      ok: false,
      error: 'No session connected at this CWD',
    })
  }
}

const rclaudeConfigData: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  const session = sessionId ? ctx.sessions.getSession(sessionId) : undefined
  if (session?.cwd) ctx.broadcastScoped(data, session.cwd)
  else ctx.broadcast(data)
}

const rclaudeConfigOk: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  const session = sessionId ? ctx.sessions.getSession(sessionId) : undefined
  const cwd = session?.cwd

  if (cwd) {
    ctx.broadcastScoped(data, cwd)
    if (data.ok) {
      const notified = ctx.sessions.broadcastToWrappersAtCwd(cwd, { type: 'notify_config_updated' })
      ctx.log.info(`Config saved for ${cwd} -- notified ${notified} wrapper(s)`)
    }
  } else {
    ctx.broadcast(data)
  }
}

export function registerRclaudeConfigHandlers(): void {
  registerHandlers({
    rclaude_config_get: rclaudeConfigGet,
    rclaude_config_set: rclaudeConfigSet,
    rclaude_config_data: rclaudeConfigData,
    rclaude_config_ok: rclaudeConfigOk,
  })
}
