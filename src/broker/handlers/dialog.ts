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
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return

  const dialogId = data.dialogId as string
  const layout = data.layout as Record<string, unknown>
  if (!dialogId || !layout) return

  // Store pending dialog on the session for reconnect recovery + attention indicator
  const session = ctx.conversations.getConversation(sessionId)
  if (session) {
    session.pendingDialog = {
      dialogId,
      layout: layout as unknown as import('../../shared/dialog-schema').DialogLayout,
      timestamp: Date.now(),
    }
    session.pendingAttention = {
      type: 'dialog',
      question: (layout.title as string) || 'Dialog',
      timestamp: Date.now(),
    }
    ctx.conversations.broadcastConversationUpdate(sessionId)
  }

  // Broadcast to dashboard subscribers with access to this session's CWD
  const dialogMsg = {
    type: 'dialog_show',
    sessionId,
    dialogId,
    layout,
  }
  if (session?.project) ctx.broadcastScoped(dialogMsg, session.project)
  else ctx.broadcast(dialogMsg)

  ctx.log.info(`[dialog] Show: "${layout.title}" (${dialogId.toString().slice(0, 8)}) session=${sessionId.slice(0, 8)}`)
}

// Dialog result: dashboard -> broker -> wrapper (forward)
const dialogResult: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const dialogId = data.dialogId as string
  const result = data.result as Record<string, unknown>

  if (!sessionId || !dialogId || !result) return

  // Permission check: user must have chat permission for this session
  const sess = sessionId ? ctx.conversations.getConversation(sessionId) : undefined
  if (sess) ctx.requirePermission('chat', sess.project)

  // Clear pending dialog + attention from session
  if (sess) {
    delete sess.pendingDialog
    if (sess.pendingAttention?.type === 'dialog') {
      delete sess.pendingAttention
    }
    ctx.conversations.broadcastConversationUpdate(sessionId)
  }

  // Forward to the wrapper that owns this session
  const targetWs = ctx.conversations.getConversationSocket(sessionId)
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: 'dialog_result',
        sessionId,
        dialogId,
        result,
      }),
    )
    ctx.log.info(`[dialog] Result: ${dialogId.slice(0, 8)} action=${result._action} session=${sessionId.slice(0, 8)}`)
  } else {
    ctx.log.error(`[dialog] No socket for session ${sessionId.slice(0, 8)}`)
  }

  // Broadcast dismiss to other dashboard subscribers (clean up UI)
  const dismissMsg = { type: 'dialog_dismiss', sessionId, dialogId }
  if (sess?.project) ctx.broadcastScoped(dismissMsg, sess.project)
  else ctx.broadcast(dismissMsg)
}

// Dialog dismiss: wrapper -> broker -> dashboard
// (e.g. timeout on wrapper side, session ended)
const dialogDismiss: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  const dialogId = data.dialogId as string
  if (!sessionId || !dialogId) return

  // Clear pending dialog + attention from session
  const session = ctx.conversations.getConversation(sessionId)
  if (session) {
    delete session.pendingDialog
    if (session.pendingAttention?.type === 'dialog') {
      delete session.pendingAttention
    }
    ctx.conversations.broadcastConversationUpdate(sessionId)
  }

  const dismissMsg2 = { type: 'dialog_dismiss', sessionId, dialogId }
  if (session?.project) ctx.broadcastScoped(dismissMsg2, session.project)
  else ctx.broadcast(dismissMsg2)

  ctx.log.debug(`[dialog] Dismiss: ${dialogId.slice(0, 8)} session=${sessionId.slice(0, 8)}`)
}

// Dialog keepalive: dashboard -> broker -> wrapper (extend timeout)
const dialogKeepalive: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const dialogId = data.dialogId as string
  if (!sessionId || !dialogId) return

  const targetWs = ctx.conversations.getConversationSocket(sessionId)
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
