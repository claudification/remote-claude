/**
 * Dialog handlers: rich UI dialog relay between wrapper and dashboard.
 *
 * Flow:
 *   Claude -> mcp__rclaude__dialog(layout) -> wrapper -> dialog_show -> concentrator
 *   -> broadcast to dashboard subscribers -> user interacts -> dialog_result
 *   -> concentrator -> forward to wrapper -> resolve MCP tool call
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

// Dialog show: wrapper -> concentrator -> dashboard (broadcast)
const dialogShow: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return

  const explorerId = data.explorerId as string
  const layout = data.layout as Record<string, unknown>
  if (!explorerId || !layout) return

  // Store pending dialog on the session for reconnect recovery + attention indicator
  const session = ctx.sessions.getSession(sessionId)
  if (session) {
    session.pendingExplorer = {
      explorerId,
      layout: layout as unknown as import('../../shared/explorer-schema').ExplorerLayout,
      timestamp: Date.now(),
    }
    session.pendingAttention = {
      type: 'dialog',
      question: (layout.title as string) || 'Dialog',
      timestamp: Date.now(),
    }
    ctx.sessions.broadcastSessionUpdate(sessionId)
  }

  // Broadcast to dashboard subscribers with access to this session's CWD
  const dialogMsg = {
    type: 'dialog_show',
    sessionId,
    explorerId,
    layout,
  }
  if (session?.cwd) ctx.broadcastScoped(dialogMsg, session.cwd)
  else ctx.broadcast(dialogMsg)

  ctx.log.info(
    `[dialog] Show: "${layout.title}" (${explorerId.toString().slice(0, 8)}) session=${sessionId.slice(0, 8)}`,
  )
}

// Dialog result: dashboard -> concentrator -> wrapper (forward)
const dialogResult: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const explorerId = data.explorerId as string
  const result = data.result as Record<string, unknown>

  if (!sessionId || !explorerId || !result) return

  // Permission check: user must have chat permission for this session
  const sess = sessionId ? ctx.sessions.getSession(sessionId) : undefined
  if (sess) ctx.requirePermission('chat', sess.cwd)

  // Clear pending dialog + attention from session
  if (sess) {
    delete sess.pendingExplorer
    if (sess.pendingAttention?.type === 'dialog') {
      delete sess.pendingAttention
    }
    ctx.sessions.broadcastSessionUpdate(sessionId)
  }

  // Forward to the wrapper that owns this session
  const targetWs = ctx.sessions.getSessionSocket(sessionId)
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: 'dialog_result',
        sessionId,
        explorerId,
        result,
      }),
    )
    ctx.log.info(`[dialog] Result: ${explorerId.slice(0, 8)} action=${result._action} session=${sessionId.slice(0, 8)}`)
  } else {
    ctx.log.error(`[dialog] No socket for session ${sessionId.slice(0, 8)}`)
  }

  // Broadcast dismiss to other dashboard subscribers (clean up UI)
  const dismissMsg = { type: 'dialog_dismiss', sessionId, explorerId }
  if (sess?.cwd) ctx.broadcastScoped(dismissMsg, sess.cwd)
  else ctx.broadcast(dismissMsg)
}

// Dialog dismiss: wrapper -> concentrator -> dashboard
// (e.g. timeout on wrapper side, session ended)
const dialogDismiss: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  const explorerId = data.explorerId as string
  if (!sessionId || !explorerId) return

  // Clear pending dialog + attention from session
  const session = ctx.sessions.getSession(sessionId)
  if (session) {
    delete session.pendingExplorer
    if (session.pendingAttention?.type === 'dialog') {
      delete session.pendingAttention
    }
    ctx.sessions.broadcastSessionUpdate(sessionId)
  }

  const dismissMsg2 = { type: 'dialog_dismiss', sessionId, explorerId }
  if (session?.cwd) ctx.broadcastScoped(dismissMsg2, session.cwd)
  else ctx.broadcast(dismissMsg2)

  ctx.log.debug(`[dialog] Dismiss: ${explorerId.slice(0, 8)} session=${sessionId.slice(0, 8)}`)
}

// Dialog keepalive: dashboard -> concentrator -> wrapper (extend timeout)
const dialogKeepalive: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const explorerId = data.explorerId as string
  if (!sessionId || !explorerId) return

  const targetWs = ctx.sessions.getSessionSocket(sessionId)
  if (targetWs) {
    targetWs.send(JSON.stringify({ type: 'dialog_keepalive', explorerId }))
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
