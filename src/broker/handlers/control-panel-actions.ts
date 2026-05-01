/**
 * Dashboard action handlers: mutations that were previously HTTP POST/DELETE
 * endpoints, now migrated to WebSocket messages.
 *
 * Pattern: dashboard sends { type: 'action_name', ...data }
 * Handler replies { type: 'action_name_result', ok: true/false, ... }
 */

import { generateConversationName } from '../../shared/conversation-names'
import { extractProjectLabel, parseProjectUri } from '../../shared/project-uri'
import type { SendInput } from '../../shared/protocol'
import { getGlobalSettings, updateGlobalSettings } from '../global-settings'
import { GuardError, type MessageHandler, type WsData } from '../handler-context'
import { registerHandlers } from '../message-router'
import { resolvePermissions } from '../permissions'
import { getProjectOrder, type ProjectOrder, setProjectOrder } from '../project-order'
import {
  deleteProjectSettings,
  getAllProjectSettings,
  getProjectSettings,
  setProjectSettings,
} from '../project-settings'

// ─── Send input to a session ──────────────────────────────────────

const sendInput: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const input = data.input as string
  if (!sessionId || !input || typeof input !== 'string') {
    throw new GuardError('Missing sessionId or input')
  }

  const session = ctx.conversations.getConversation(sessionId)
  if (!session) throw new GuardError('Session not found')
  if (session.status === 'ended') throw new GuardError('Session has ended')
  ctx.requirePermission('chat', session.project)

  // Try by session ID first, then by wrapper IDs (handles ID changes from SessionStart)
  let ws = ctx.conversations.getConversationSocket(sessionId)
  if (!ws) {
    const conversationIds = ctx.conversations.getConversationIds(sessionId)
    for (const wid of conversationIds) {
      ws = ctx.conversations.findSocketByConversationId(wid)
      if (ws) break
    }
  }
  if (!ws) throw new GuardError('Session not connected')

  const crDelay = typeof data.crDelay === 'number' && data.crDelay > 0 ? data.crDelay : undefined
  const inputMsg: SendInput = {
    type: 'input',
    conversationId: sessionId,
    input,
    ...(crDelay && { crDelay }),
  }
  ws.send(JSON.stringify(inputMsg))
  ctx.log.debug(`send_input: ${sessionId.slice(0, 8)} "${input.slice(0, 50)}"`)
  ctx.reply({ type: 'send_input_result', ok: true })
}

/** Broadcast project settings filtered per subscriber's grants */
function broadcastFilteredProjectSettings(
  ctx: { conversations: { getSubscribers(): Set<import('bun').ServerWebSocket<unknown>> } },
  all: Record<string, unknown>,
): void {
  for (const ws of ctx.conversations.getSubscribers()) {
    try {
      const wsGrants = (ws.data as WsData).grants
      if (!wsGrants) {
        ws.send(JSON.stringify({ type: 'project_settings_updated', settings: all }))
      } else {
        const filtered: Record<string, unknown> = {}
        for (const [project, settings] of Object.entries(all)) {
          const { permissions } = resolvePermissions(wsGrants, project)
          if (permissions.has('chat:read')) filtered[project] = settings
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

  const session = ctx.conversations.getConversation(sessionId)
  if (!session) throw new GuardError('Session not found')
  if (session.status !== 'ended') throw new GuardError('Only ended sessions can be dismissed')
  ctx.requirePermission('settings', session.project)

  const project = session.project
  ctx.conversations.removeConversation(sessionId)
  ctx.broadcastScoped({ type: 'conversation_dismissed', sessionId }, project)
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
  const project = (data.project as string) ?? (data.cwd as string)
  const settings = data.settings as Record<string, unknown>
  if (!project || !settings) throw new GuardError('Missing project or settings')
  ctx.requirePermission('settings')

  setProjectSettings(project, settings)
  const all = getAllProjectSettings()
  broadcastFilteredProjectSettings(ctx, all)
  ctx.reply({ type: 'update_project_settings_result', ok: true, projectSettings: all })
}

// ─── Delete project settings ──────────────────────────────────────

const deleteProjectSettingsHandler: MessageHandler = (ctx, data) => {
  const project = (data.project as string) ?? (data.cwd as string)
  if (!project) throw new GuardError('Missing project')
  ctx.requirePermission('settings')

  deleteProjectSettings(project)
  const all = getAllProjectSettings()
  broadcastFilteredProjectSettings(ctx, all)
  ctx.reply({ type: 'delete_project_settings_result', ok: true, projectSettings: all })
}

// ─── Update project order ─────────────────────────────────────────

const updateProjectOrder: MessageHandler = (ctx, data) => {
  const order = data.order as ProjectOrder
  if (!order || !Array.isArray(order.tree)) {
    throw new GuardError('Invalid project order: expected { tree: [...] }')
  }
  ctx.requirePermission('settings')

  setProjectOrder(order)
  const saved = getProjectOrder()

  // Broadcast filtered order per subscriber's grants (same as HTTP POST handler)
  for (const ws of ctx.conversations.getSubscribers()) {
    try {
      const wsGrants = (ws.data as WsData).grants
      if (!wsGrants) {
        ws.send(JSON.stringify({ type: 'project_order_updated', order: saved }))
      } else {
        const grants = wsGrants
        function filterNodes(nodes: ProjectOrder['tree']): ProjectOrder['tree'] {
          const result: ProjectOrder['tree'] = []
          for (const node of nodes) {
            if (node.type === 'project') {
              const projectUri = node.id
              const { permissions } = resolvePermissions(grants, projectUri)
              if (permissions.has('chat:read')) result.push(node)
            } else if (node.type === 'group') {
              const children = filterNodes(node.children)
              if (children.length > 0) result.push({ ...node, children })
            }
          }
          return result
        }
        ws.send(JSON.stringify({ type: 'project_order_updated', order: { ...saved, tree: filterNodes(saved.tree) } }))
      }
    } catch {
      /* dead socket */
    }
  }

  ctx.reply({ type: 'update_project_order_result', ok: true, order: saved })
}

// ─── Interrupt a session (headless) ───────────────────────────────

const sendInterrupt: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  if (!sessionId) throw new GuardError('Missing sessionId')

  const session = ctx.conversations.getConversation(sessionId)
  if (!session) throw new GuardError('Session not found')
  if (session.status === 'ended') throw new GuardError('Session has ended')
  ctx.requirePermission('chat', session.project)

  let ws = ctx.conversations.getConversationSocket(sessionId)
  if (!ws) {
    const conversationIds = ctx.conversations.getConversationIds(sessionId)
    for (const wid of conversationIds) {
      ws = ctx.conversations.findSocketByConversationId(wid)
      if (ws) break
    }
  }
  if (!ws) throw new GuardError('Session not connected')

  ws.send(JSON.stringify({ type: 'interrupt', sessionId }))
  // Immediately set idle -- CC won't fire a Stop hook after interrupt
  session.status = 'idle'
  ctx.conversations.broadcastConversationUpdate(sessionId)
  ctx.log.debug(`send_interrupt: ${sessionId.slice(0, 8)}`)
  ctx.reply({ type: 'send_interrupt_result', ok: true })
}

// ─── Revive a session ─────────────────────────────────────────────

const reviveSession: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  if (!sessionId) throw new GuardError('Missing sessionId')

  const session = ctx.conversations.getConversation(sessionId)
  if (!session) throw new GuardError('Session not found')
  if (session.status === 'active') throw new GuardError('Session is already active')
  ctx.requirePermission('spawn', session.project)

  const sentinel = ctx.getSentinel()
  if (!sentinel) throw new GuardError('No sentinel connected')

  const conversationId = crypto.randomUUID()
  const jobId = data.jobId as string | undefined
  const projSettings = getProjectSettings(session.project)
  const lc = session.launchConfig // stored launch config from original spawn

  // Generate a funny session name for revived sessions that don't have one
  const usedNames = new Set(
    ctx.conversations
      .getAllConversations()
      .map(s => s.title)
      .filter(Boolean) as string[],
  )
  const sessionName = session.title || generateConversationName(usedNames)
  const name = sessionName || projSettings?.label || extractProjectLabel(session.project) || sessionId.slice(0, 8)

  // Resolve headless: explicit override > launch config > project default > global setting
  const headlessParam = data.headless as boolean | undefined
  const globalSettings = getGlobalSettings()
  const headless =
    headlessParam ?? lc?.headless ?? (projSettings?.defaultLaunchMode || globalSettings.defaultLaunchMode) !== 'pty'

  // Resolve effort + model: dashboard override > launch config > project/global defaults
  const effortOverride = data.effort as string | undefined
  const modelOverride = data.model as string | undefined
  const effortRaw = effortOverride || lc?.effort || projSettings?.defaultEffort || globalSettings.defaultEffort
  const effort = effortRaw && effortRaw !== 'default' ? effortRaw : undefined
  const model = modelOverride || lc?.model || projSettings?.defaultModel || globalSettings.defaultModel || undefined

  // Register launch job if dashboard provided a jobId
  if (jobId) {
    ctx.conversations.createJob(jobId, conversationId)
  }

  sentinel.send(
    JSON.stringify({
      type: 'revive',
      sessionId,
      project: session.project,
      conversationId,
      jobId,
      mode: 'resume',
      headless,
      effort,
      model,
      sessionName,
      agent: lc?.agent || undefined,
      bare: lc?.bare || undefined,
      repl: lc?.repl || undefined,
      permissionMode: lc?.permissionMode || undefined,
      autocompactPct: (data.autocompactPct as number | undefined) || lc?.autocompactPct || session.autocompactPct,
      maxBudgetUsd: (data.maxBudgetUsd as number | undefined) || lc?.maxBudgetUsd || session.maxBudgetUsd,
      adHocWorktree: session.adHocWorktree || undefined,
      env: (data.env as Record<string, string>) || lc?.env || undefined,
    }),
  )

  ctx.log.info(
    `[revive] ${name} (${sessionId.slice(0, 8)}) via WS, conversationId=${conversationId.slice(0, 8)} headless=${headless}${jobId ? ` job=${jobId.slice(0, 8)}` : ''}${lc ? ' (launch config restored)' : ''}`,
  )
  ctx.reply({
    type: 'revive_session_result',
    ok: true,
    name,
    conversationId,
    jobId,
    message: 'Revive command sent to sentinel',
  })
}

// ─── Launch Job Subscriptions ─────────────────────────────────────
// No auth needed - the jobId is the capability token.

const subscribeJob: MessageHandler = (ctx, data) => {
  const jobId = data.jobId as string
  if (!jobId) throw new GuardError('Missing jobId')
  ctx.conversations.subscribeJob(jobId, ctx.ws)
  ctx.log.debug(`[job] Subscribed: ${jobId.slice(0, 8)}`)
}

const unsubscribeJob: MessageHandler = (ctx, data) => {
  const jobId = data.jobId as string
  if (!jobId) return
  ctx.conversations.unsubscribeJob(jobId, ctx.ws)
  ctx.log.debug(`[job] Unsubscribed: ${jobId.slice(0, 8)}`)
}

// ─── Rename Session ──────────────────────────────────────────────

const renameSession: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const name = (data.name as string)?.trim()
  const description = typeof data.description === 'string' ? data.description.trim() : undefined
  if (!sessionId) throw new GuardError('Missing sessionId')

  const session = ctx.conversations.getConversation(sessionId)
  if (!session) throw new GuardError('Session not found')
  ctx.requirePermission('chat', session.project)

  if (name) {
    session.title = name
    session.titleUserSet = true
  } else {
    session.title = undefined
    session.titleUserSet = false
  }
  if (description !== undefined) {
    session.description = description || undefined
  }
  ctx.conversations.broadcastConversationUpdate(sessionId)
  ctx.reply({ type: 'rename_session_result', ok: true })
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
    update_project_order: updateProjectOrder,
    revive_session: reviveSession,
    rename_session: renameSession,
    subscribe_job: subscribeJob,
    unsubscribe_job: unsubscribeJob,
  })
}
