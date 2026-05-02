/**
 * Plan approval handlers: relay between wrapper and dashboard for
 * plan mode approval flow (ExitPlanMode -> review -> approve/reject/feedback).
 * Also handles plan_mode_changed to update session state.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

// Plan approval request: wrapper -> broker -> dashboard
const planApproval: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return

  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) {
    // Store for reconnect recovery (same pattern as pendingDialog)
    conversation.pendingPlanApproval = {
      requestId: data.requestId as string,
      toolUseId: data.toolUseId as string | undefined,
      plan: data.plan as string,
      planFilePath: data.planFilePath as string | undefined,
      allowedPrompts: data.allowedPrompts as unknown[] | undefined,
      timestamp: Date.now(),
    }
    conversation.pendingAttention = {
      type: 'plan_approval',
      question: 'Plan approval required',
      timestamp: Date.now(),
    }
    ctx.conversations.broadcastConversationUpdate(conversationId)
  }

  const msg = {
    type: 'plan_approval',
    conversationId: conversationId,
    requestId: data.requestId,
    toolUseId: data.toolUseId,
    plan: data.plan,
    planFilePath: data.planFilePath,
    allowedPrompts: data.allowedPrompts,
  }
  if (conversation?.project) ctx.broadcastScoped(msg, conversation.project)
  else ctx.broadcast(msg)

  ctx.log.info(
    `[plan] Approval request: ${(data.requestId as string)?.slice(0, 8)} conversation=${conversationId.slice(0, 8)}`,
  )
}

// Plan approval response: dashboard -> broker -> wrapper
const planApprovalResponse: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  if (!conversationId) return

  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) ctx.requirePermission('chat', conversation.project)

  // Clear pending state + dismiss dialog on ALL subscribers
  if (conversation) {
    delete conversation.pendingPlanApproval
    if (conversation.pendingAttention?.type === 'plan_approval') {
      delete conversation.pendingAttention
    }
    ctx.conversations.broadcastConversationUpdate(conversationId)
    // Dismiss the dialog on all dashboard clients (not just the one that responded)
    const dismissMsg = { type: 'plan_approval_dismissed', conversationId: conversationId }
    if (conversation.project) ctx.broadcastScoped(dismissMsg, conversation.project)
    else ctx.broadcast(dismissMsg)
  }

  const targetWs = ctx.conversations.getConversationSocket(conversationId)
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: 'plan_approval_response',
        conversationId: conversationId,
        requestId: data.requestId,
        toolUseId: data.toolUseId,
        action: data.action,
        feedback: data.feedback,
      }),
    )
    ctx.log.info(`[plan] Response: ${data.action} conversation=${conversationId.slice(0, 8)}`)
  } else {
    ctx.log.error(`[plan] No socket for conversation ${conversationId.slice(0, 8)}`)
  }
}

// Plan mode state change: wrapper -> broker -> dashboard
const planModeChanged: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return

  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) {
    conversation.planMode = data.planMode as boolean
    // Exiting plan mode: clear pending approval + dismiss dialog on all clients
    if (!data.planMode) {
      if (conversation.pendingPlanApproval) delete conversation.pendingPlanApproval
      if (conversation.pendingAttention?.type === 'plan_approval') delete conversation.pendingAttention
      const dismissMsg = { type: 'plan_approval_dismissed', conversationId: conversationId }
      if (conversation.project) ctx.broadcastScoped(dismissMsg, conversation.project)
      else ctx.broadcast(dismissMsg)
    }
    ctx.conversations.broadcastConversationUpdate(conversationId)
  }

  ctx.log.info(`[plan] Mode changed: ${data.planMode ? 'ON' : 'OFF'} conversation=${conversationId.slice(0, 8)}`)
}

export function registerPlanApprovalHandlers(): void {
  registerHandlers({
    plan_approval: planApproval,
    plan_approval_response: planApprovalResponse,
    plan_mode_changed: planModeChanged,
  })
}
