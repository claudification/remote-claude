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

// Session info from headless init - store on session and broadcast to dashboard
const sessionInfo: MessageHandler = (ctx, data) => {
  const wsSessionId = ctx.ws.data.sessionId as string | undefined
  const wrapperId = ctx.ws.data.wrapperId as string | undefined
  // Resolve session: try session ID first, then wrapper ID (session ID may have changed via SessionStart)
  const session =
    (wsSessionId ? ctx.sessions.getSession(wsSessionId) : null) ||
    (wrapperId ? ctx.sessions.getSessionByWrapper(wrapperId) : null)
  if (!session) {
    ctx.log.debug(
      `session_info: no session found (wsSessionId=${wsSessionId?.slice(0, 8)}, wrapperId=${wrapperId?.slice(0, 8)})`,
    )
    return
  }
  const sessionId = session.id
  ;(session as unknown as Record<string, unknown>).sessionInfo = {
    tools: data.tools,
    slashCommands: data.slashCommands,
    skills: data.skills,
    agents: data.agents,
    mcpServers: data.mcpServers,
    plugins: data.plugins,
    model: data.model,
    permissionMode: data.permissionMode,
    claudeCodeVersion: data.claudeCodeVersion,
    fastModeState: data.fastModeState,
  }
  // Broadcast with canonical session ID (not whatever the wrapper sent)
  if (session.cwd) {
    ctx.broadcastScoped({ ...data, type: 'session_info', sessionId }, session.cwd)
  }
  ctx.log.debug(
    `session_info: ${(data.tools as unknown[])?.length} tools, ${(data.skills as unknown[])?.length} skills, ${(data.agents as unknown[])?.length} agents`,
  )
}

// Headless stream deltas - forward raw API SSE events to dashboard subscribers
const streamDelta: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return
  const session = ctx.sessions.getSession(sessionId)
  if (session?.cwd) {
    ctx.broadcastScoped({ type: 'stream_delta', sessionId, event: data.event }, session.cwd)
  }
}

// Rate limit event from headless backend - store on session and broadcast update
const rateLimitHandler: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return
  const session = ctx.sessions.getSession(sessionId)
  if (!session) return
  session.rateLimit = {
    retryAfterMs: (data.retryAfterMs as number) || 5000,
    message: (data.message as string) || 'Rate limited',
    timestamp: Date.now(),
  }
  ctx.sessions.broadcastSessionUpdate(sessionId)
}

const MAX_COST_TIMELINE = 500

const turnCost: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const costUsd = data.costUsd as number
  const session = ctx.sessions.getSession(sessionId)
  if (session) {
    session.stats.totalCostUsd = costUsd
    if (!session.costTimeline) session.costTimeline = []
    session.costTimeline.push({ t: Date.now(), cost: costUsd })
    if (session.costTimeline.length > MAX_COST_TIMELINE) {
      session.costTimeline = session.costTimeline.slice(-MAX_COST_TIMELINE)
    }
    ctx.sessions.broadcastSessionUpdate(sessionId)
  }
}

const sessionName: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const name = data.name as string
  const session = ctx.sessions.getSession(sessionId)
  if (session && name) {
    session.title = name
    ctx.sessions.broadcastSessionUpdate(sessionId)
    ctx.log.info(`Session name: "${name}" (${sessionId.slice(0, 8)})`)
  }
}

export function registerTranscriptHandlers(): void {
  registerHandlers({
    session_name: sessionName,
    turn_cost: turnCost,
    tasks_update: tasksUpdate,
    diag: diagHandler,
    transcript_entries: transcriptEntries,
    subagent_transcript: subagentTranscript,
    bg_task_output: bgTaskOutput,
    transcript_request: transcriptRequest,
    subagent_transcript_request: subagentTranscriptRequest,
    stream_delta: streamDelta,
    rate_limit: rateLimitHandler,
    session_info: sessionInfo,
  })
}
