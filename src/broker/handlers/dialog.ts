/**
 * Dialog handlers: rich UI dialog relay between wrapper and dashboard.
 *
 * Flow:
 *   Claude -> mcp__rclaude__dialog(layout) -> wrapper -> dialog_show -> broker
 *   -> broadcast to dashboard subscribers -> user interacts -> dialog_result
 *   -> broker -> forward to wrapper -> resolve MCP tool call
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

// Dialog show: wrapper -> broker -> dashboard (broadcast)
const dialogShow: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return

  const dialogId = data.dialogId as string
  const layout = data.layout as Record<string, unknown>
  if (!dialogId || !layout) return

  // Store pending dialog on the conversation for reconnect recovery + attention indicator
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) {
    conversation.pendingDialog = {
      dialogId,
      layout: layout as unknown as import('../../shared/dialog-schema').DialogLayout,
      timestamp: Date.now(),
    }
    conversation.pendingAttention = {
      type: 'dialog',
      question: (layout.title as string) || 'Dialog',
      timestamp: Date.now(),
    }
    ctx.conversations.broadcastConversationUpdate(conversationId)
  }

  // Broadcast to dashboard subscribers with access to this conversation's project
  const dialogMsg = {
    type: 'dialog_show',
    conversationId: conversationId,
    dialogId,
    layout,
  }
  if (conversation?.project) ctx.broadcastScoped(dialogMsg, conversation.project)
  else ctx.broadcast(dialogMsg)

  ctx.log.info(
    `[dialog] Show: "${layout.title}" (${dialogId.toString().slice(0, 8)}) conversation=${conversationId.slice(0, 8)}`,
  )
}

// Dialog result: dashboard -> broker -> wrapper (forward)
const dialogResult: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  const dialogId = data.dialogId as string
  const result = data.result as Record<string, unknown>

  if (!conversationId || !dialogId || !result) return

  // Permission check: user must have chat permission for this conversation
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  if (conversation) ctx.requirePermission('chat', conversation.project)

  // Clear pending dialog + attention from conversation
  if (conversation) {
    delete conversation.pendingDialog
    if (conversation.pendingAttention?.type === 'dialog') {
      delete conversation.pendingAttention
    }
    ctx.conversations.broadcastConversationUpdate(conversationId)
  }

  // Forward to the wrapper that owns this conversation
  const targetWs = ctx.conversations.getConversationSocket(conversationId)
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: 'dialog_result',
        conversationId: conversationId,
        dialogId,
        result,
      }),
    )
    ctx.log.info(
      `[dialog] Result: ${dialogId.slice(0, 8)} action=${result._action} conversation=${conversationId.slice(0, 8)}`,
    )
  } else {
    ctx.log.error(`[dialog] No socket for conversation ${conversationId.slice(0, 8)}`)
  }

  // Broadcast dismiss to other dashboard subscribers (clean up UI)
  const dismissMsg = { type: 'dialog_dismiss', conversationId: conversationId, dialogId }
  if (conversation?.project) ctx.broadcastScoped(dismissMsg, conversation.project)
  else ctx.broadcast(dismissMsg)
}

// Dialog dismiss: wrapper -> broker -> dashboard
// (e.g. timeout on wrapper side, session ended)
const dialogDismiss: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  const dialogId = data.dialogId as string
  if (!conversationId || !dialogId) return

  // Clear pending dialog + attention from conversation
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) {
    delete conversation.pendingDialog
    if (conversation.pendingAttention?.type === 'dialog') {
      delete conversation.pendingAttention
    }
    ctx.conversations.broadcastConversationUpdate(conversationId)
  }

  const dismissMsg2 = { type: 'dialog_dismiss', conversationId: conversationId, dialogId }
  if (conversation?.project) ctx.broadcastScoped(dismissMsg2, conversation.project)
  else ctx.broadcast(dismissMsg2)

  ctx.log.debug(`[dialog] Dismiss: ${dialogId.slice(0, 8)} conversation=${conversationId.slice(0, 8)}`)
}

// Dialog keepalive: dashboard -> broker -> wrapper (extend timeout)
const dialogKeepalive: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  const dialogId = data.dialogId as string
  if (!conversationId || !dialogId) return

  const targetWs = ctx.conversations.getConversationSocket(conversationId)
  if (targetWs) {
    targetWs.send(JSON.stringify({ type: 'dialog_keepalive', dialogId }))
  }
}

export function registerDialogHandlers(): void {
  registerHandlers({
    dialog_show: dialogShow,
    dialog_result: dialogResult,
    dialog_dismiss: dialogDismiss,
    dialog_keepalive: dialogKeepalive,
  })
}
