/**
 * Transcript and data streaming handlers.
 * Handles transcript entries, subagent transcripts, tasks, bg task output,
 * and diagnostic entries from rclaude -> concentrator cache -> dashboard.
 */

import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

// biome-ignore lint/suspicious/noExplicitAny: WS JSON data is untyped at the boundary
function d(data: Record<string, unknown>): any {
  return data
}

const tasksUpdate: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return
  const tasks = d(data).tasks || []
  ctx.sessions.updateTasks(sessionId, tasks)
  ctx.sessions.broadcastToChannel('session:tasks', sessionId, {
    type: 'tasks_update',
    sessionId,
    tasks,
  })
  ctx.log.debug(`tasks_update (${tasks.length} tasks)`)
}

const diagHandler: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId || !Array.isArray(data.entries)) return
  const session = ctx.sessions.getSession(sessionId)
  if (session) {
    session.diagLog.push(...(data.entries as Array<{ t: number; type: string; msg: string; args?: unknown }>))
    if (session.diagLog.length > 500) {
      session.diagLog.splice(0, session.diagLog.length - 500)
    }
  }
}

const transcriptEntries: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return
  const entries = d(data).entries || []
  ctx.sessions.addTranscriptEntries(sessionId, entries, !!data.isInitial)
  ctx.sessions.broadcastToChannel('session:transcript', sessionId, data)
  console.log(`[transcript] ${sessionId.slice(0, 8)}... ${entries.length} entries (initial: ${data.isInitial})`)
}

const subagentTranscript: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  const agentId = data.agentId as string
  if (!sessionId || !agentId) return
  const entries = d(data).entries || []
  ctx.sessions.addSubagentTranscriptEntries(sessionId, agentId, entries, !!data.isInitial)
  ctx.sessions.broadcastToChannel('session:subagent_transcript', sessionId, data, agentId)
  console.log(`[transcript] ${sessionId.slice(0, 8)}... subagent ${agentId.slice(0, 7)} ${entries.length} entries`)
}

const bgTaskOutput: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId || !data.taskId) return
  ctx.sessions.addBgTaskOutput(sessionId, data.taskId as string, (data.data as string) || '', !!data.done)
  ctx.sessions.broadcastToChannel('session:bg_output', sessionId, data)
}

// Dashboard -> rclaude: request transcript (serve from cache or proxy)
const transcriptRequest: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  if (!sessionId) return
  if (ctx.sessions.hasTranscriptCache(sessionId)) {
    const entries = ctx.sessions.getTranscriptEntries(sessionId, data.limit as number | undefined)
    ctx.reply({ type: 'transcript_entries', sessionId, entries, isInitial: true })
  } else {
    const sessionSocket = ctx.sessions.getSessionSocket(sessionId)
    if (sessionSocket) sessionSocket.send(JSON.stringify(data))
  }
}

// Dashboard -> rclaude: request subagent transcript
const subagentTranscriptRequest: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const agentId = data.agentId as string
  if (!sessionId || !agentId) return
  if (ctx.sessions.hasSubagentTranscriptCache(sessionId, agentId)) {
    const entries = ctx.sessions.getSubagentTranscriptEntries(sessionId, agentId, data.limit as number | undefined)
    ctx.reply({ type: 'subagent_transcript', sessionId, agentId, entries, isInitial: true })
  } else {
    const sessionSocket = ctx.sessions.getSessionSocket(sessionId)
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
