/**
 * Permission and question relay handlers.
 * Bidirectional relay between wrapper (rclaude) and dashboard for:
 * - Tool permission requests/responses
 * - Session-scoped auto-approve rules
 * - AskUserQuestion flow
 * - Clipboard capture notifications
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

// Permission relay: wrapper -> dashboard (broadcast + store for reconnect recovery)
const permissionRequest: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)

  // Store for reconnect recovery (same pattern as pendingDialog/pendingPlanApproval)
  if (conversation) {
    conversation.pendingPermission = {
      requestId: data.requestId as string,
      toolName: data.toolName as string,
      description: data.description as string,
      inputPreview: data.inputPreview as string,
      toolUseId: data.toolUseId as string | undefined,
      timestamp: Date.now(),
    }
    conversation.pendingAttention = {
      type: 'permission',
      toolName: data.toolName as string,
      timestamp: Date.now(),
    }
    ctx.conversations.broadcastConversationUpdate(conversationId)
  }

  const msg = {
    type: 'permission_request',
    conversationId: conversationId,
    requestId: data.requestId,
    toolName: data.toolName,
    description: data.description,
    inputPreview: data.inputPreview,
    toolUseId: data.toolUseId,
  }
  if (conversation?.project) ctx.broadcastScoped(msg, conversation.project)
  else ctx.broadcast(msg)
  ctx.log.debug(`[permission] Request: ${data.requestId} ${data.toolName}`)
}

// Permission relay: dashboard -> wrapper (forward + clear stored state)
const permissionResponse: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  if (conversation) ctx.requirePermission('chat', conversation.project)
  const targetWs = conversationId ? ctx.conversations.getConversationSocket(conversationId) : null
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: 'permission_response',
        conversationId: conversationId,
        requestId: data.requestId,
        behavior: data.behavior,
        toolUseId: data.toolUseId,
      }),
    )
    // Clear pending permission state (resolved by user)
    if (conversation) {
      delete conversation.pendingPermission
      if (conversation.pendingAttention?.type === 'permission') {
        delete conversation.pendingAttention
      }
      ctx.conversations.broadcastConversationUpdate(conversationId)
    }
    ctx.log.debug(`[permission] Response: ${data.requestId} -> ${data.behavior}`)
  }
}

// Permission rule: dashboard -> wrapper (session-scoped auto-approve)
const permissionRule: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  if (conversation) ctx.requirePermission('chat', conversation.project)
  const targetWs = conversationId ? ctx.conversations.getConversationSocket(conversationId) : null
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: 'permission_rule',
        toolName: data.toolName,
        behavior: data.behavior,
      }),
    )
    ctx.log.debug(`[permission] Rule: ${data.toolName} -> ${data.behavior}`)
  }
}

// Permission auto-approved: wrapper -> dashboard (notification)
const permissionAutoApproved: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  const msg = {
    type: 'permission_auto_approved',
    conversationId: conversationId,
    requestId: data.requestId,
    toolName: data.toolName,
    description: data.description,
  }
  if (conversation?.project) ctx.broadcastScoped(msg, conversation.project)
  else ctx.broadcast(msg)
}

// Clipboard capture: wrapper -> dashboard (broadcast)
const clipboardCapture: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  const msg = {
    type: 'clipboard_capture',
    conversationId: conversationId,
    contentType: data.contentType,
    text: data.text,
    base64: data.base64,
    mimeType: data.mimeType,
    timestamp: data.timestamp || Date.now(),
  }
  if (conversation?.project) ctx.broadcastScoped(msg, conversation.project)
  else ctx.broadcast(msg)
  ctx.log.debug(`[clipboard] ${data.contentType}${data.mimeType ? ` (${data.mimeType})` : ''}`)
}

// AskUserQuestion relay: wrapper -> dashboard (broadcast + store for reconnect recovery)
const askQuestion: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)

  // Store for reconnect recovery (same pattern as pendingPermission)
  if (conversation) {
    conversation.pendingAskQuestion = {
      toolUseId: data.toolUseId as string,
      questions: data.questions as unknown[],
      timestamp: Date.now(),
    }
    conversation.pendingAttention = {
      type: 'ask',
      toolName: 'AskUserQuestion',
      timestamp: Date.now(),
    }
    ctx.conversations.broadcastConversationUpdate(conversationId)
  }

  const msg = {
    type: 'ask_question',
    conversationId: conversationId,
    toolUseId: data.toolUseId,
    questions: data.questions,
  }
  if (conversation?.project) ctx.broadcastScoped(msg, conversation.project)
  else ctx.broadcast(msg)
  ctx.log.debug(
    `[ask] Question: ${(data.toolUseId as string)?.slice(0, 12)} ${(data.questions as unknown[])?.length || 0}q`,
  )
}

// AskUserQuestion relay: dashboard -> wrapper (forward + clear stored state)
const askAnswer: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || data.conversationId) as string
  const conversation = conversationId ? ctx.conversations.getConversation(conversationId) : undefined
  if (conversation) ctx.requirePermission('chat', conversation.project)
  const targetWs = conversationId ? ctx.conversations.getConversationSocket(conversationId) : null
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: 'ask_answer',
        conversationId: conversationId,
        toolUseId: data.toolUseId,
        answers: data.answers,
        annotations: data.annotations,
        skip: data.skip,
      }),
    )
    // Clear pending ask state (resolved by user)
    if (conversation) {
      delete conversation.pendingAskQuestion
      if (conversation.pendingAttention?.type === 'ask') {
        delete conversation.pendingAttention
      }
      ctx.conversations.broadcastConversationUpdate(conversationId)
    }
    ctx.log.debug(`[ask] Answer: ${(data.toolUseId as string)?.slice(0, 12)} ${data.skip ? 'SKIP' : 'answered'}`)
  }
}

export function registerPermissionHandlers(): void {
  registerHandlers({
    permission_request: permissionRequest,
    permission_response: permissionResponse,
    permission_rule: permissionRule,
    permission_auto_approved: permissionAutoApproved,
    clipboard_capture: clipboardCapture,
    ask_question: askQuestion,
    ask_answer: askAnswer,
  })
}
