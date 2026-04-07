/**
 * Explorer handlers: rich UI dialog relay between wrapper and dashboard.
 *
 * Flow:
 *   Claude -> mcp__rclaude__explore(layout) -> wrapper -> explorer_show -> concentrator
 *   -> broadcast to dashboard subscribers -> user interacts -> explorer_result
 *   -> concentrator -> forward to wrapper -> resolve MCP tool call
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

// Explorer show: wrapper -> concentrator -> dashboard (broadcast)
const explorerShow: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return

  const explorerId = data.explorerId as string
  const layout = data.layout as Record<string, unknown>
  if (!explorerId || !layout) return

  // Store pending explorer on the session for reconnect recovery + attention indicator
  const session = ctx.sessions.getSession(sessionId)
  if (session) {
    session.pendingExplorer = {
      explorerId,
      layout: layout as unknown as import('../../shared/explorer-schema').ExplorerLayout,
      timestamp: Date.now(),
    }
    session.pendingAttention = {
      type: 'explorer',
      question: (layout.title as string) || 'Explorer dialog',
      timestamp: Date.now(),
    }
    ctx.sessions.broadcastSessionUpdate(sessionId)
  }

  // Broadcast to dashboard subscribers
  // Note: uses unscoped broadcast (all subscribers). The security boundary is on
  // explorer_result where ctx.requirePermission('chat') blocks unauthorized responses.
  // Share viewers without chat perm see the modal but cannot submit answers.
  // TODO: expose broadcastSessionScoped on HandlerContext and use it here.
  ctx.broadcast({
    type: 'explorer_show',
    sessionId,
    explorerId,
    layout,
  })

  ctx.log.info(
    `[explorer] Show: "${layout.title}" (${explorerId.toString().slice(0, 8)}) session=${sessionId.slice(0, 8)}`,
  )
}

// Explorer result: dashboard -> concentrator -> wrapper (forward)
const explorerResult: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const explorerId = data.explorerId as string
  const result = data.result as Record<string, unknown>

  if (!sessionId || !explorerId || !result) return

  // Permission check: user must have chat permission for this session
  const sess = sessionId ? ctx.sessions.getSession(sessionId) : undefined
  if (sess) ctx.requirePermission('chat', sess.cwd)

  // Clear pending explorer + attention from session
  if (sess) {
    delete sess.pendingExplorer
    if (sess.pendingAttention?.type === 'explorer') {
      delete sess.pendingAttention
    }
    ctx.sessions.broadcastSessionUpdate(sessionId)
  }

  // Forward to the wrapper that owns this session
  const targetWs = ctx.sessions.getSessionSocket(sessionId)
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: 'explorer_result',
        sessionId,
        explorerId,
        result,
      }),
    )
    ctx.log.info(
      `[explorer] Result: ${explorerId.slice(0, 8)} action=${result._action} session=${sessionId.slice(0, 8)}`,
    )
  } else {
    ctx.log.error(`[explorer] No socket for session ${sessionId.slice(0, 8)}`)
  }

  // Broadcast dismiss to other dashboard subscribers (clean up UI)
  ctx.broadcast({
    type: 'explorer_dismiss',
    sessionId,
    explorerId,
  })
}

// Explorer dismiss: wrapper -> concentrator -> dashboard
// (e.g. timeout on wrapper side, session ended)
const explorerDismiss: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  const explorerId = data.explorerId as string
  if (!sessionId || !explorerId) return

  // Clear pending explorer + attention from session
  const session = ctx.sessions.getSession(sessionId)
  if (session) {
    delete session.pendingExplorer
    if (session.pendingAttention?.type === 'explorer') {
      delete session.pendingAttention
    }
    ctx.sessions.broadcastSessionUpdate(sessionId)
  }

  ctx.broadcast({
    type: 'explorer_dismiss',
    sessionId,
    explorerId,
  })

  ctx.log.debug(`[explorer] Dismiss: ${explorerId.slice(0, 8)} session=${sessionId.slice(0, 8)}`)
}

export function registerExplorerHandlers(): void {
  registerHandlers({
    explorer_show: explorerShow,
    explorer_result: explorerResult,
    explorer_dismiss: explorerDismiss,
  })
}
