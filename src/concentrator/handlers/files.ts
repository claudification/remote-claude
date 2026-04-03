/**
 * File editor relay handlers.
 * Bidirectional proxy between dashboard and rclaude for file operations.
 * Dashboard sends requests (with sessionId), concentrator forwards to wrapper.
 * Wrapper sends responses (with requestId), concentrator forwards to subscribers.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

// Wrapper -> dashboard: file response (also handles server-side requests like keyterms)
const fileResponse: MessageHandler = (ctx, data) => {
  if (data.requestId && ctx.sessions.resolveFile(data.requestId as string, data)) {
    return // Handled server-side, don't broadcast
  }
  ctx.broadcast(data)
}

// Dashboard -> wrapper: file operation requests
const fileEditorRequest: MessageHandler = (ctx, data) => {
  if (!ctx.ws.data.isDashboard || !data.sessionId) return
  const targetSocket = ctx.sessions.getSessionSocket(data.sessionId as string)
  if (targetSocket) {
    targetSocket.send(JSON.stringify(data))
  } else {
    const replyType = (data.type as string).replace('_request', '_response').replace('_save', '_save_response')
    ctx.reply({ type: replyType, requestId: data.requestId, error: 'Session not connected' })
  }
}

// Wrapper -> dashboard: file operation responses (forward to all subscribers)
const fileEditorResponse: MessageHandler = (ctx, data) => {
  ctx.broadcast(data)
}

// Dashboard -> wrapper: file request (proxy to rclaude)
const fileRequest: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  if (!sessionId) return
  const sessionSocket = ctx.sessions.getSessionSocket(sessionId)
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
    quick_note_append: fileEditorRequest,
    // Wrapper -> dashboard responses (all share the same handler)
    file_list_response: fileEditorResponse,
    file_content_response: fileEditorResponse,
    file_save_response: fileEditorResponse,
    file_history_response: fileEditorResponse,
    file_restore_response: fileEditorResponse,
    quick_note_response: fileEditorResponse,
    file_changed: fileEditorResponse,
    // File proxy
    file_request: fileRequest,
  })
}
