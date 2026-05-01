/**
 * Handlers for .rclaude/rclaude.json config read/write via the wrapper.
 *
 * Follows the same pattern as file_request/file_save:
 *   dashboard -> broker -> wrapper (by project) -> filesystem
 *   wrapper response -> broker -> broadcastScoped to dashboard
 *
 * After a successful save, broadcasts notify_config_updated to all
 * wrappers at the target project so they hot-reload permission rules.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

function findWrapperSocketByProject(ctx: Parameters<MessageHandler>[0], project: string) {
  for (const session of ctx.conversations.getAllConversations()) {
    if (session.project !== project) continue
    const socket = ctx.conversations.getConversationSocket(session.id)
    if (socket) return { socket, session }
  }
  return undefined
}

const rclaudeConfigGet: MessageHandler = (ctx, data) => {
  const project = data.project as string
  if (!project) return
  ctx.requirePermission('settings', project)

  const target = findWrapperSocketByProject(ctx, project)
  if (target) {
    target.socket.send(JSON.stringify(data))
  } else {
    ctx.reply({
      type: 'rclaude_config_data',
      requestId: data.requestId,
      config: null,
      project,
      error: 'No session connected at this project',
    })
  }
}

const rclaudeConfigSet: MessageHandler = (ctx, data) => {
  const project = data.project as string
  if (!project) return
  ctx.requirePermission('settings', project)

  const target = findWrapperSocketByProject(ctx, project)
  if (target) {
    target.socket.send(JSON.stringify(data))
  } else {
    ctx.reply({
      type: 'rclaude_config_ok',
      requestId: data.requestId,
      ok: false,
      error: 'No session connected at this project',
    })
  }
}

const rclaudeConfigData: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.sessionId || ctx.ws.data.conversationId) as string
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  if (conversation?.project) ctx.broadcastScoped(data, conversation.project)
  else ctx.broadcast(data)
}

const rclaudeConfigOk: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.sessionId || ctx.ws.data.conversationId) as string
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  const project = conversation?.project

  if (project) {
    ctx.broadcastScoped(data, project)
    if (data.ok) {
      const notified = ctx.conversations.broadcastToConversationsAtCwd(project, { type: 'notify_config_updated' })
      ctx.log.info(`Config saved for ${project} -- notified ${notified} wrapper(s)`)
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
