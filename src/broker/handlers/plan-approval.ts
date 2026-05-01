/**
 * Plan approval handlers: relay between wrapper and dashboard for
 * plan mode approval flow (ExitPlanMode -> review -> approve/reject/feedback).
 * Also handles plan_mode_changed to update session state.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

// Plan approval request: wrapper -> broker -> dashboard
const planApproval: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return

  const session = ctx.conversations.getConversation(sessionId)
  if (session) {
    // Store for reconnect recovery (same pattern as pendingDialog)
    session.pendingPlanApproval = {
      requestId: data.requestId as string,
      toolUseId: data.toolUseId as string | undefined,
      plan: data.plan as string,
      planFilePath: data.planFilePath as string | undefined,
      allowedPrompts: data.allowedPrompts as unknown[] | undefined,
      timestamp: Date.now(),
    }
    session.pendingAttention = {
      type: 'plan_approval',
      question: 'Plan approval required',
      timestamp: Date.now(),
    }
    ctx.conversations.broadcastConversationUpdate(sessionId)
  }

  const msg = {
    type: 'plan_approval',
    sessionId,
    requestId: data.requestId,
    toolUseId: data.toolUseId,
    plan: data.plan,
    planFilePath: data.planFilePath,
    allowedPrompts: data.allowedPrompts,
  }
  if (session?.project) ctx.broadcastScoped(msg, session.project)
  else ctx.broadcast(msg)

  ctx.log.info(`[plan] Approval request: ${(data.requestId as string)?.slice(0, 8)} session=${sessionId.slice(0, 8)}`)
}

// Plan approval response: dashboard -> broker -> wrapper
const planApprovalResponse: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  if (!sessionId) return

  const sess = ctx.conversations.getConversation(sessionId)
  if (sess) ctx.requirePermission('chat', sess.project)

  // Clear pending state + dismiss dialog on ALL subscribers
  if (sess) {
    delete sess.pendingPlanApproval
    if (sess.pendingAttention?.type === 'plan_approval') {
      delete sess.pendingAttention
    }
    ctx.conversations.broadcastConversationUpdate(sessionId)
    // Dismiss the dialog on all dashboard clients (not just the one that responded)
    const dismissMsg = { type: 'plan_approval_dismissed', sessionId }
    if (sess.project) ctx.broadcastScoped(dismissMsg, sess.project)
    else ctx.broadcast(dismissMsg)
  }

  const targetWs = ctx.conversations.getConversationSocket(sessionId)
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: 'plan_approval_response',
        sessionId,
        requestId: data.requestId,
        toolUseId: data.toolUseId,
        action: data.action,
        feedback: data.feedback,
      }),
    )
    ctx.log.info(`[plan] Response: ${data.action} session=${sessionId.slice(0, 8)}`)
  } else {
    ctx.log.error(`[plan] No socket for session ${sessionId.slice(0, 8)}`)
  }
}

// Plan mode state change: wrapper -> broker -> dashboard
const planModeChanged: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return

  const session = ctx.conversations.getConversation(sessionId)
  if (session) {
    session.planMode = data.planMode as boolean
    // Exiting plan mode: clear pending approval + dismiss dialog on all clients
    if (!data.planMode) {
      if (session.pendingPlanApproval) delete session.pendingPlanApproval
      if (session.pendingAttention?.type === 'plan_approval') delete session.pendingAttention
      const dismissMsg = { type: 'plan_approval_dismissed', sessionId }
      if (session.project) ctx.broadcastScoped(dismissMsg, session.project)
      else ctx.broadcast(dismissMsg)
    }
    ctx.conversations.broadcastConversationUpdate(sessionId)
  }

  ctx.log.info(`[plan] Mode changed: ${data.planMode ? 'ON' : 'OFF'} session=${sessionId.slice(0, 8)}`)
}

export function registerPlanApprovalHandlers(): void {
  registerHandlers({
    plan_approval: planApproval,
    plan_approval_response: planApprovalResponse,
    plan_mode_changed: planModeChanged,
  })
}
