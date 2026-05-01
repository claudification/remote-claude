/**
 * File editor relay handlers.
 * Bidirectional proxy between dashboard and rclaude for file operations.
 * Dashboard sends requests (with sessionId), broker forwards to wrapper.
 * Wrapper sends responses (with requestId), broker forwards to subscribers.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

// Wrapper -> dashboard: file response (also handles server-side requests like keyterms)
const fileResponse: MessageHandler = (ctx, data) => {
  if (data.requestId && ctx.conversations.resolveFile(data.requestId as string, data)) {
    return // Handled server-side, don't broadcast
  }
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  const session = sessionId ? ctx.conversations.getConversation(sessionId) : undefined
  if (session?.project) ctx.broadcastScoped(data, session.project)
  else ctx.broadcast(data)
}

// Dashboard -> wrapper: file operation requests
const fileEditorRequest: MessageHandler = (ctx, data) => {
  if (!ctx.ws.data.isControlPanel || !data.sessionId) return
  // Permission: write ops need 'files', read ops need 'files:read'
  const msgType = data.type as string
  const isWrite =
    msgType === 'file_save' ||
    msgType === 'file_restore' ||
    msgType === 'project_quick_add' ||
    msgType === 'project_create' ||
    msgType === 'project_move' ||
    msgType === 'project_delete' ||
    msgType === 'project_update'
  const sess = ctx.conversations.getConversation(data.sessionId as string)
  if (sess) ctx.requirePermission(isWrite ? 'files' : 'files:read', sess.project)
  const targetSocket = ctx.conversations.getConversationSocket(data.sessionId as string)
  if (targetSocket) {
    targetSocket.send(JSON.stringify(data))
  } else {
    const t = data.type as string
    const replyType = t.startsWith('project_')
      ? `${t}_response`
      : t.replace('_request', '_response').replace('_save', '_save_response')
    ctx.reply({ type: replyType, requestId: data.requestId, error: 'Session not connected' })
  }
}

// Wrapper -> dashboard: file operation responses (forward to subscribers with access)
const fileEditorResponse: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  const session = sessionId ? ctx.conversations.getConversation(sessionId) : undefined
  if (session?.project) ctx.broadcastScoped(data, session.project)
  else ctx.broadcast(data)
}

// Dashboard -> wrapper: file request (proxy to rclaude)
const fileRequest: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  if (!sessionId) return
  const sess = ctx.conversations.getConversation(sessionId)
  if (sess) ctx.requirePermission('files:read', sess.project)
  const sessionSocket = ctx.conversations.getConversationSocket(sessionId)
  if (sessionSocket) {
    sessionSocket.send(JSON.stringify(data))
  } else {
    ctx.reply({ type: 'file_response', requestId: data.requestId, error: 'Session not connected' })
  }
}

export function registerFileHandlers(): void {
  registerHandlers({
    file_response: fileResponse,
    // Dashboard -> wrapper requests (all share the same handler)
    file_list_request: fileEditorRequest,
    file_content_request: fileEditorRequest,
    file_save: fileEditorRequest,
    file_watch: fileEditorRequest,
    file_unwatch: fileEditorRequest,
    file_history_request: fileEditorRequest,
    file_restore: fileEditorRequest,
    project_quick_add: fileEditorRequest,
    // Project board (dashboard -> wrapper)
    project_list: fileEditorRequest,
    project_create: fileEditorRequest,
    project_move: fileEditorRequest,
    project_delete: fileEditorRequest,
    project_read: fileEditorRequest,
    project_update: fileEditorRequest,
    // Wrapper -> dashboard responses (all share the same handler)
    file_list_response: fileEditorResponse,
    file_content_response: fileEditorResponse,
    file_save_response: fileEditorResponse,
    file_history_response: fileEditorResponse,
    file_restore_response: fileEditorResponse,
    project_quick_add_response: fileEditorResponse,
    file_changed: fileEditorResponse,
    // Project board responses (wrapper -> dashboard)
    project_list_response: fileEditorResponse,
    project_create_response: fileEditorResponse,
    project_move_response: fileEditorResponse,
    project_delete_response: fileEditorResponse,
    project_read_response: fileEditorResponse,
    project_update_response: fileEditorResponse,
    // Project board filesystem change notification (wrapper -> dashboard)
    project_changed: fileEditorResponse,
    // File proxy
    file_request: fileRequest,
  })
}
