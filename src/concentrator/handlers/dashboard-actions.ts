/**
 * Dashboard action handlers: mutations that were previously HTTP POST/DELETE
 * endpoints, now migrated to WebSocket messages.
 *
 * Pattern: dashboard sends { type: 'action_name', ...data }
 * Handler replies { type: 'action_name_result', ok: true/false, ... }
 */

import type { SendInput } from '../../shared/protocol'
import { getGlobalSettings, updateGlobalSettings } from '../global-settings'
import { GuardError, type MessageHandler, type WsData } from '../handler-context'
import { registerHandlers } from '../message-router'
import { resolvePermissions } from '../permissions'
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

  // Try by session ID first, then by wrapper IDs (handles ID changes from SessionStart)
  let ws = ctx.sessions.getSessionSocket(sessionId)
  if (!ws) {
    const wrapperIds = ctx.sessions.getWrapperIds(sessionId)
    for (const wid of wrapperIds) {
      ws = ctx.sessions.getSessionSocketByWrapper(wid)
      if (ws) break
    }
  }
  if (!ws) throw new GuardError('Session not connected')

  const crDelay = typeof data.crDelay === 'number' && data.crDelay > 0 ? data.crDelay : undefined
  const inputMsg: SendInput = {
    type: 'input',
    sessionId,
    input,
    ...(crDelay && { crDelay }),
  }
  ws.send(JSON.stringify(inputMsg))
  ctx.log.debug(`send_input: ${sessionId.slice(0, 8)} "${input.slice(0, 50)}"`)
  ctx.reply({ type: 'send_input_result', ok: true })
}

/** Broadcast project settings filtered per subscriber's grants */
function broadcastFilteredProjectSettings(
  ctx: { sessions: { getSubscribers(): Set<import('bun').ServerWebSocket<unknown>> } },
  all: Record<string, unknown>,
): void {
  for (const ws of ctx.sessions.getSubscribers()) {
    try {
      const wsGrants = (ws.data as WsData).grants
      if (!wsGrants) {
        ws.send(JSON.stringify({ type: 'project_settings_updated', settings: all }))
      } else {
        const filtered: Record<string, unknown> = {}
        for (const [cwd, settings] of Object.entries(all)) {
          const { permissions } = resolvePermissions(wsGrants, cwd)
          if (permissions.has('chat:read')) filtered[cwd] = settings
        }
        ws.send(JSON.stringify({ type: 'project_settings_updated', settings: filtered }))
      }
    } catch {
      /* dead socket */
    }
  }
}

// ─── Dismiss an ended session ─────────────────────────────────────

const dismissSession: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  if (!sessionId) throw new GuardError('Missing sessionId')

  const session = ctx.sessions.getSession(sessionId)
  if (!session) throw new GuardError('Session not found')
  if (session.status !== 'ended') throw new GuardError('Only ended sessions can be dismissed')
  ctx.requirePermission('settings', session.cwd)

  const cwd = session.cwd
  ctx.sessions.removeSession(sessionId)
  ctx.broadcastScoped({ type: 'session_dismissed', sessionId }, cwd)
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
  broadcastFilteredProjectSettings(ctx, all)
  ctx.reply({ type: 'update_project_settings_result', ok: true, projectSettings: all })
}

// ─── Delete project settings ──────────────────────────────────────

const deleteProjectSettingsHandler: MessageHandler = (ctx, data) => {
  const cwd = data.cwd as string
  if (!cwd) throw new GuardError('Missing cwd')
  ctx.requirePermission('settings')

  deleteProjectSettings(cwd)
  const all = getAllProjectSettings()
  broadcastFilteredProjectSettings(ctx, all)
  ctx.reply({ type: 'delete_project_settings_result', ok: true, projectSettings: all })
}

// ─── Update session order ─────────────────────────────────────────

const updateSessionOrder: MessageHandler = (ctx, data) => {
  const order = data.order as SessionOrderV2
  if (!order || order.version !== 2 || !Array.isArray(order.tree)) {
    throw new GuardError('Invalid session order: expected { version: 2, tree: [...] }')
  }
  ctx.requirePermission('settings')

  setSessionOrder(order)
  const saved = getSessionOrder()

  // Broadcast filtered order per subscriber's grants (same as HTTP POST handler)
  for (const ws of ctx.sessions.getSubscribers()) {
    try {
      const wsGrants = (ws.data as WsData).grants
      if (!wsGrants) {
        ws.send(JSON.stringify({ type: 'session_order_updated', order: saved }))
      } else {
        const grants = wsGrants
        function filterNodes(nodes: SessionOrderV2['tree']): SessionOrderV2['tree'] {
          const result: SessionOrderV2['tree'] = []
          for (const node of nodes) {
            if (node.type === 'session') {
              const cwd = node.id.startsWith('cwd:') ? node.id.slice(4) : node.id
              const { permissions } = resolvePermissions(grants, cwd)
              if (permissions.has('chat:read')) result.push(node)
            } else if (node.type === 'group') {
              const children = filterNodes(node.children)
              if (children.length > 0) result.push({ ...node, children })
            }
          }
          return result
        }
        ws.send(JSON.stringify({ type: 'session_order_updated', order: { ...saved, tree: filterNodes(saved.tree) } }))
      }
    } catch {
      /* dead socket */
    }
  }

  ctx.reply({ type: 'update_session_order_result', ok: true, order: saved })
}

// ─── Interrupt a session (headless) ───────────────────────────────

const sendInterrupt: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  if (!sessionId) throw new GuardError('Missing sessionId')

  const session = ctx.sessions.getSession(sessionId)
  if (!session) throw new GuardError('Session not found')
  if (session.status === 'ended') throw new GuardError('Session has ended')
  ctx.requirePermission('chat', session.cwd)

  let ws = ctx.sessions.getSessionSocket(sessionId)
  if (!ws) {
    const wrapperIds = ctx.sessions.getWrapperIds(sessionId)
    for (const wid of wrapperIds) {
      ws = ctx.sessions.getSessionSocketByWrapper(wid)
      if (ws) break
    }
  }
  if (!ws) throw new GuardError('Session not connected')

  ws.send(JSON.stringify({ type: 'interrupt', sessionId }))
  // Immediately set idle -- CC won't fire a Stop hook after interrupt
  session.status = 'idle'
  ctx.sessions.broadcastSessionUpdate(sessionId)
  ctx.log.debug(`send_interrupt: ${sessionId.slice(0, 8)}`)
  ctx.reply({ type: 'send_interrupt_result', ok: true })
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
  const projSettings = getProjectSettings(session.cwd)
  const name = session.title || projSettings?.label || session.cwd.split('/').pop() || sessionId.slice(0, 8)

  // Resolve headless: explicit override > project default > global setting
  const headlessParam = data.headless as boolean | undefined
  const globalSettings = getGlobalSettings()
  const headless = headlessParam ?? (projSettings?.defaultLaunchMode || globalSettings.defaultLaunchMode) !== 'pty'

  // Resolve effort + model from project/global defaults
  const effortRaw = projSettings?.defaultEffort || globalSettings.defaultEffort
  const effort = effortRaw && effortRaw !== 'default' ? effortRaw : undefined
  const model = projSettings?.defaultModel || globalSettings.defaultModel || undefined

  agent.send(
    JSON.stringify({
      type: 'revive',
      sessionId,
      cwd: session.cwd,
      wrapperId,
      mode: 'continue',
      headless,
      effort,
      model,
    }),
  )

  ctx.log.info(
    `[revive] ${name} (${sessionId.slice(0, 8)}) via WS, wrapperId=${wrapperId.slice(0, 8)} headless=${headless}`,
  )
  ctx.reply({ type: 'revive_session_result', ok: true, name, wrapperId, message: 'Revive command sent to agent' })
}

// ─── Register all dashboard action handlers ───────────────────────

export function registerDashboardActionHandlers(): void {
  registerHandlers({
    send_input: sendInput,
    send_interrupt: sendInterrupt,
    dismiss_session: dismissSession,
    update_settings: updateSettings,
    update_project_settings: updateProjectSettings,
    delete_project_settings: deleteProjectSettingsHandler,
    update_session_order: updateSessionOrder,
    revive_session: reviveSession,
  })
}
