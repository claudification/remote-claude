/**
 * Dashboard action handlers: mutations that were previously HTTP POST/DELETE
 * endpoints, now migrated to WebSocket messages.
 *
 * Pattern: dashboard sends { type: 'action_name', ...data }
 * Handler replies { type: 'action_name_result', ok: true/false, ... }
 */

import type { SendInput } from '../../shared/protocol'
import { updateGlobalSettings } from '../global-settings'
import { GuardError, type MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'
import {
  deleteProjectSettings,
  getAllProjectSettings,
  getProjectSettings,
  setProjectSettings,
} from '../project-settings'
import { getSessionOrder, type SessionOrderV2, setSessionOrder } from '../session-order'

// ─── Send input to a session ──────────────────────────────────────

const sendInput: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const input = data.input as string
  if (!sessionId || !input || typeof input !== 'string') {
    throw new GuardError('Missing sessionId or input')
  }

  const session = ctx.sessions.getSession(sessionId)
  if (!session) throw new GuardError('Session not found')
  if (session.status === 'ended') throw new GuardError('Session has ended')
  ctx.requirePermission('chat', session.cwd)

  const ws = ctx.sessions.getSessionSocket(sessionId)
  if (!ws) throw new GuardError('Session not connected')

  const crDelay = typeof data.crDelay === 'number' && data.crDelay > 0 ? data.crDelay : undefined
  const inputMsg: SendInput = {
    type: 'input',
    sessionId,
    input,
    ...(crDelay && { crDelay }),
  }
  ws.send(JSON.stringify(inputMsg))
  ctx.reply({ type: 'send_input_result', ok: true })
}

// ─── Dismiss an ended session ─────────────────────────────────────

const dismissSession: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  if (!sessionId) throw new GuardError('Missing sessionId')

  const session = ctx.sessions.getSession(sessionId)
  if (!session) throw new GuardError('Session not found')
  if (session.status !== 'ended') throw new GuardError('Only ended sessions can be dismissed')
  ctx.requirePermission('admin', session.cwd)

  ctx.sessions.removeSession(sessionId)
  ctx.broadcast({ type: 'session_dismissed', sessionId })
  ctx.reply({ type: 'dismiss_session_result', ok: true })
}

// ─── Update global settings ───────────────────────────────────────

const updateSettings: MessageHandler = (ctx, data) => {
  // Settings update is handled by the imported module
  const settings = data.settings as Record<string, unknown>
  if (!settings || typeof settings !== 'object') throw new GuardError('Missing settings object')
  ctx.requirePermission('settings')

  const result = updateGlobalSettings(settings)
  ctx.broadcast({ type: 'settings_updated', settings: result.settings })
  ctx.reply({ type: 'update_settings_result', ok: true, settings: result.settings, errors: result.errors })
}

// ─── Update project settings ──────────────────────────────────────

const updateProjectSettings: MessageHandler = (ctx, data) => {
  const cwd = data.cwd as string
  const settings = data.settings as Record<string, unknown>
  if (!cwd || !settings) throw new GuardError('Missing cwd or settings')
  ctx.requirePermission('settings')

  setProjectSettings(cwd, settings)
  const all = getAllProjectSettings()
  ctx.broadcast({ type: 'project_settings_updated', settings: all })
  ctx.reply({ type: 'update_project_settings_result', ok: true, projectSettings: all })
}

// ─── Delete project settings ──────────────────────────────────────

const deleteProjectSettingsHandler: MessageHandler = (ctx, data) => {
  const cwd = data.cwd as string
  if (!cwd) throw new GuardError('Missing cwd')
  ctx.requirePermission('settings')

  deleteProjectSettings(cwd)
  const all = getAllProjectSettings()
  ctx.broadcast({ type: 'project_settings_updated', settings: all })
  ctx.reply({ type: 'delete_project_settings_result', ok: true, projectSettings: all })
}

// ─── Update session order ─────────────────────────────────────────

const updateSessionOrder: MessageHandler = (ctx, data) => {
  const order = data.order as SessionOrderV2
  if (!order || order.version !== 2 || !Array.isArray(order.tree)) {
    throw new GuardError('Invalid session order: expected { version: 2, tree: [...] }')
  }
  ctx.requirePermission('admin')

  setSessionOrder(order)
  const saved = getSessionOrder()
  ctx.broadcast({ type: 'session_order_updated', order: saved })
  ctx.reply({ type: 'update_session_order_result', ok: true, order: saved })
}

// ─── Revive a session ─────────────────────────────────────────────

const reviveSession: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  if (!sessionId) throw new GuardError('Missing sessionId')

  const session = ctx.sessions.getSession(sessionId)
  if (!session) throw new GuardError('Session not found')
  if (session.status === 'active') throw new GuardError('Session is already active')
  ctx.requirePermission('spawn', session.cwd)

  const agent = ctx.getAgent()
  if (!agent) throw new GuardError('No host agent connected')

  const wrapperId = crypto.randomUUID()
  const name =
    session.title || getProjectSettings(session.cwd)?.label || session.cwd.split('/').pop() || sessionId.slice(0, 8)
  agent.send(JSON.stringify({ type: 'revive', sessionId, cwd: session.cwd, wrapperId, mode: 'continue' }))

  ctx.log.info(`[revive] ${name} (${sessionId.slice(0, 8)}) via WS, wrapperId=${wrapperId.slice(0, 8)}`)
  ctx.reply({ type: 'revive_session_result', ok: true, name, wrapperId, message: 'Revive command sent to agent' })
}

// ─── Register all dashboard action handlers ───────────────────────

export function registerDashboardActionHandlers(): void {
  registerHandlers({
    send_input: sendInput,
    dismiss_session: dismissSession,
    update_settings: updateSettings,
    update_project_settings: updateProjectSettings,
    delete_project_settings: deleteProjectSettingsHandler,
    update_session_order: updateSessionOrder,
    revive_session: reviveSession,
  })
}
