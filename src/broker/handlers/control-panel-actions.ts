/**
 * Dashboard action handlers: mutations that were previously HTTP POST/DELETE
 * endpoints, now migrated to WebSocket messages.
 *
 * Pattern: dashboard sends { type: 'action_name', ...data }
 * Handler replies { type: 'action_name_result', ok: true/false, ... }
 */

import type { ServerWebSocket } from 'bun'
import { generateConversationName } from '../../shared/conversation-names'
import { extractProjectLabel } from '../../shared/project-uri'
import type { SendInput, SubscriptionChannel } from '../../shared/protocol'
import { resolveBackend } from '../backends'
import { buildReviveMessage } from '../build-revive'
import { getGlobalSettings, updateGlobalSettings } from '../global-settings'
import { GuardError, type MessageHandler, type WsData } from '../handler-context'
import { DASHBOARD_ROLES, registerHandlers } from '../message-router'
import { resolvePermissions } from '../permissions'
import { getProjectOrder, type ProjectOrder, setProjectOrder } from '../project-order'
import {
  deleteProjectSettings,
  getAllProjectSettings,
  getProjectSettings,
  setProjectSettings,
} from '../project-settings'

// ─── Send input to a conversation ──────────────────────────────────────

const sendInput: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  const input = data.input as string
  if (!conversationId || !input || typeof input !== 'string') {
    throw new GuardError('Missing conversationId or input')
  }

  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) throw new GuardError('Conversation not found')
  if (conversation.status === 'ended') throw new GuardError('Conversation has ended')
  ctx.requirePermission('chat', conversation.project)

  // Backend-proxied conversations (Chat API, future: OpenCode, Pi, etc.)
  const backend = resolveBackend(conversation)
  if (!backend.requiresAgentSocket) {
    backend
      .handleInput(conversationId, input, {
        conversationStore: ctx.conversations,
        kv: ctx.store.kv,
        broadcastScoped: ctx.broadcastScoped,
        broadcastToChannel: (channel: SubscriptionChannel, cid: string, msg: Record<string, unknown>) =>
          ctx.conversations.broadcastToChannel(channel, cid, msg),
      })
      .then((result: { ok: boolean; error?: string }) => {
        if (!result.ok) ctx.log.error(`[${backend.type}] proxy error: ${result.error}`)
      })
      .catch((err: unknown) => ctx.log.error(`[${backend.type}] proxy failed`, err))
    ctx.log.debug(`send_input: ${conversationId.slice(0, 8)} [${backend.type}] "${input.slice(0, 50)}"`)
    ctx.reply({ type: 'send_input_result', ok: true })
    return
  }

  // Socket-based backends (Claude CC) -- forward to agent host WebSocket
  let ws = ctx.conversations.getConversationSocket(conversationId)
  if (!ws) {
    const routingIds = ctx.conversations.getConnectionIds(conversationId)
    for (const wid of routingIds) {
      ws = ctx.conversations.findSocketByConversationId(wid)
      if (ws) break
    }
  }
  if (!ws) throw new GuardError('Conversation not connected')

  const crDelay = typeof data.crDelay === 'number' && data.crDelay > 0 ? data.crDelay : undefined
  const inputMsg: SendInput = {
    type: 'input',
    conversationId,
    input,
    ...(crDelay && { crDelay }),
  }
  ws.send(JSON.stringify(inputMsg))
  ctx.log.debug(`send_input: ${conversationId.slice(0, 8)} "${input.slice(0, 50)}"`)
  ctx.reply({ type: 'send_input_result', ok: true })
}

/** Broadcast project settings filtered per subscriber's grants */
function broadcastFilteredProjectSettings(
  ctx: { conversations: { getSubscribers(): Set<ServerWebSocket<unknown>> } },
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

// ─── Dismiss an ended conversations ─────────────────────────────────────

const dismissConversation: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  if (!conversationId) throw new GuardError('Missing conversationId')

  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) throw new GuardError('Conversation not found')
  if (conversation.status !== 'ended') throw new GuardError('Only ended conversations can be dismissed')
  ctx.requirePermission('settings', conversation.project)

  const project = conversation.project
  ctx.conversations.removeConversation(conversationId)
  ctx.broadcastScoped({ type: 'conversation_dismissed', conversationId: conversationId }, project)
  ctx.reply({ type: 'dismiss_conversation_result', ok: true })
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

// ─── Interrupt a conversation (headless) ───────────────────────────────

const sendInterrupt: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  if (!conversationId) throw new GuardError('Missing conversationId')

  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) throw new GuardError('Conversation not found')
  if (conversation.status === 'ended') throw new GuardError('Conversation has ended')
  ctx.requirePermission('chat', conversation.project)

  let ws = ctx.conversations.getConversationSocket(conversationId)
  if (!ws) {
    const routingIds = ctx.conversations.getConnectionIds(conversationId)
    for (const wid of routingIds) {
      ws = ctx.conversations.findSocketByConversationId(wid)
      if (ws) break
    }
  }
  if (!ws) throw new GuardError('Conversation not connected')

  ws.send(JSON.stringify({ type: 'interrupt', conversationId: conversationId }))
  // Immediately set idle -- CC won't fire a Stop hook after interrupt
  conversation.status = 'idle'
  ctx.conversations.broadcastConversationUpdate(conversationId)
  ctx.log.debug(`send_interrupt: ${conversationId.slice(0, 8)}`)
  ctx.reply({ type: 'send_interrupt_result', ok: true })
}

// ─── Revive a conversation ─────────────────────────────────────────────

const reviveConversation: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  if (!conversationId) throw new GuardError('Missing conversationId')

  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) throw new GuardError('Conversation not found')
  if (conversation.status === 'active') throw new GuardError('Conversation is already active')
  ctx.requirePermission('spawn', conversation.project)

  const sentinel = ctx.getSentinel()
  if (!sentinel) throw new GuardError('No sentinel connected')

  const jobId = data.jobId as string | undefined
  const projSettings = getProjectSettings(conversation.project)
  const lc = conversation.launchConfig // stored launch config from original spawn

  // Generate a funny name for revived conversations that don't have one
  const usedNames = new Set(
    ctx.conversations
      .getAllConversations()
      .map(s => s.title)
      .filter(Boolean) as string[],
  )
  const convName = conversation.title || generateConversationName(usedNames)
  const name =
    convName || projSettings?.label || extractProjectLabel(conversation.project) || conversationId.slice(0, 8)

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

  // Reuse the original conversation ID so transcript + sidebar entry persist
  ctx.conversations.resumeConversation(conversationId)

  // Register launch job if dashboard provided a jobId
  if (jobId) {
    ctx.conversations.createJob(jobId, conversationId)
  }

  sentinel.send(
    JSON.stringify(
      buildReviveMessage(conversation, conversationId, {
        jobId,
        headless,
        effort,
        model,
        autocompactPct: (data.autocompactPct as number | undefined) || undefined,
        maxBudgetUsd: (data.maxBudgetUsd as number | undefined) || undefined,
        env: (data.env as Record<string, string>) || undefined,
      }),
    ),
  )

  ctx.log.info(
    `[revive] ${name} (${conversationId.slice(0, 8)}) via WS, headless=${headless}${jobId ? ` job=${jobId.slice(0, 8)}` : ''}${lc ? ' (launch config restored)' : ''}`,
  )
  ctx.reply({
    type: 'revive_conversation_result',
    ok: true,
    name,
    conversationId,
    jobId,
    message: 'Revive command sent to sentinel',
  })
}

// ─── Launch Job Subscriptions ─────────────────────────────────────
// jobIds are randomUUID() (128 bits) so guessing is infeasible, but we
// still gate subscribe on `spawn` permission so users without spawn
// rights can't observe other users' launches by replaying captured ids.
// (Audit M5)

const subscribeJob: MessageHandler = (ctx, data) => {
  const jobId = data.jobId as string
  if (!jobId) throw new GuardError('Missing jobId')
  ctx.requirePermission('spawn')
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

const renameConversation: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  const name = (data.name as string)?.trim()
  const description = typeof data.description === 'string' ? data.description.trim() : undefined
  if (!conversationId) throw new GuardError('Missing conversationId')

  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) throw new GuardError('Conversation not found')
  ctx.requirePermission('chat', conversation.project)

  if (name) {
    conversation.title = name
    conversation.titleUserSet = true
  } else {
    conversation.title = undefined
    conversation.titleUserSet = false
  }
  if (description !== undefined) {
    conversation.description = description || undefined
  }
  ctx.conversations.persistConversationById(conversationId)
  ctx.conversations.broadcastConversationUpdate(conversationId)
  ctx.reply({ type: 'rename_conversation_result', ok: true })
}

// ─── Register all dashboard action handlers ───────────────────────

export function registerDashboardActionHandlers(): void {
  // All dashboard actions originate from a dashboard or share viewer.
  registerHandlers(
    {
      send_input: sendInput,
      send_interrupt: sendInterrupt,
      dismiss_conversation: dismissConversation,
      dismiss_session: dismissConversation, // backward compat
      update_settings: updateSettings,
      update_project_settings: updateProjectSettings,
      delete_project_settings: deleteProjectSettingsHandler,
      update_project_order: updateProjectOrder,
      revive_conversation: reviveConversation,
      revive_session: reviveConversation, // backward compat
      rename_conversation: renameConversation,
      rename_session: renameConversation, // backward compat
      subscribe_job: subscribeJob,
      unsubscribe_job: unsubscribeJob,
    },
    DASHBOARD_ROLES,
  )
}
