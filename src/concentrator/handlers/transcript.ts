/**
 * Transcript and data streaming handlers.
 * Handles transcript entries, subagent transcripts, tasks, bg task output,
 * and diagnostic entries from rclaude -> concentrator cache -> dashboard.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

const tasksUpdate: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || data.sessionId
  if (!sessionId) return
  const tasks = data.tasks || []
  ctx.sessions.updateTasks(sessionId, tasks)
  ctx.sessions.broadcastToChannel('session:tasks', sessionId, {
    type: 'tasks_update',
    sessionId,
    tasks,
  })
  ctx.log.debug(`tasks_update (${tasks.length} tasks)`)
}

const diagHandler: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || data.sessionId
  if (!sessionId || !Array.isArray(data.entries)) return
  const session = ctx.sessions.getSession(sessionId)
  if (session) {
    session.diagLog.push(...data.entries)
    if (session.diagLog.length > 500) {
      session.diagLog.splice(0, session.diagLog.length - 500)
    }
  }
}

const transcriptEntries: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || data.sessionId
  if (!sessionId) return
  const entries = data.entries || []
  ctx.sessions.addTranscriptEntries(sessionId, entries, !!data.isInitial)
  ctx.sessions.broadcastToChannel('session:transcript', sessionId, data)
  console.log(`[transcript] ${sessionId.slice(0, 8)}... ${entries.length} entries (initial: ${data.isInitial})`)
}

const subagentTranscript: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || data.sessionId
  const agentId = data.agentId
  if (!sessionId || !agentId) return
  const entries = data.entries || []
  ctx.sessions.addSubagentTranscriptEntries(sessionId, agentId, entries, !!data.isInitial)
  ctx.sessions.broadcastToChannel('session:subagent_transcript', sessionId, data, agentId)
  console.log(`[transcript] ${sessionId.slice(0, 8)}... subagent ${agentId.slice(0, 7)} ${entries.length} entries`)
}

const bgTaskOutput: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || data.sessionId
  if (!sessionId || !data.taskId) return
  ctx.sessions.addBgTaskOutput(sessionId, data.taskId, data.data || '', !!data.done)
  ctx.sessions.broadcastToChannel('session:bg_output', sessionId, data)
}

const transcriptRequest: MessageHandler = (ctx, data) => {
  if (!data.sessionId) return
  const sess = ctx.sessions.getSession(data.sessionId as string)
  if (sess) ctx.requirePermission('chat:read', sess.cwd)
  if (ctx.sessions.hasTranscriptCache(data.sessionId)) {
    const entries = ctx.sessions.getTranscriptEntries(data.sessionId, data.limit)
    ctx.reply({ type: 'transcript_entries', sessionId: data.sessionId, entries, isInitial: true })
  } else {
    const sessionSocket = ctx.sessions.getSessionSocket(data.sessionId)
    if (sessionSocket) sessionSocket.send(JSON.stringify(data))
  }
}

const subagentTranscriptRequest: MessageHandler = (ctx, data) => {
  if (!data.sessionId || !data.agentId) return
  const sess = ctx.sessions.getSession(data.sessionId as string)
  if (sess) ctx.requirePermission('chat:read', sess.cwd)
  if (ctx.sessions.hasSubagentTranscriptCache(data.sessionId, data.agentId)) {
    const entries = ctx.sessions.getSubagentTranscriptEntries(data.sessionId, data.agentId, data.limit)
    ctx.reply({
      type: 'subagent_transcript',
      sessionId: data.sessionId,
      agentId: data.agentId,
      entries,
      isInitial: true,
    })
  } else {
    const sessionSocket = ctx.sessions.getSessionSocket(data.sessionId)
    if (sessionSocket) sessionSocket.send(JSON.stringify(data))
  }
}

export function registerTranscriptHandlers(): void {
  registerHandlers({
    tasks_update: tasksUpdate,
    diag: diagHandler,
    transcript_entries: transcriptEntries,
    subagent_transcript: subagentTranscript,
    bg_task_output: bgTaskOutput,
    transcript_request: transcriptRequest,
    subagent_transcript_request: subagentTranscriptRequest,
  })
}
