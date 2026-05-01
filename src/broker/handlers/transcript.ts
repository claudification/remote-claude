/**
 * Transcript and data streaming handlers.
 * Handles transcript entries, subagent transcripts, tasks, bg task output,
 * and diagnostic entries from rclaude -> broker cache -> dashboard.
 */

import { randomUUID } from 'node:crypto'
import { resolveModelFamily } from '../../shared/models'
import type { TranscriptLaunchEntry, WrapperLaunchStep } from '../../shared/protocol'
import { filterDisplayEntries } from '../../shared/transcript-filter'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

/** Stored session_info snapshot shape used for cross-turn diffing. */
interface SessionInfoSnapshot {
  tools?: unknown[]
  slashCommands?: unknown[]
  skills?: unknown[]
  agents?: unknown[]
  mcpServers?: Array<{ name: string; status?: string }>
  plugins?: unknown[]
  model?: string
  permissionMode?: string
  claudeCodeVersion?: string
  fastModeState?: string
}

function nameOf(x: unknown): string | undefined {
  if (typeof x === 'string') return x
  if (x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string') {
    return (x as { name: string }).name
  }
  return undefined
}

function arrNames(arr?: unknown[]): string[] {
  if (!Array.isArray(arr)) return []
  const names = arr.map(nameOf).filter((n): n is string => !!n)
  return names
}

function setDiff(prev: string[], next: string[]): { added: string[]; removed: string[] } {
  const prevSet = new Set(prev)
  const nextSet = new Set(next)
  return {
    added: next.filter(n => !prevSet.has(n)),
    removed: prev.filter(n => !nextSet.has(n)),
  }
}

/**
 * Compare two session_info snapshots and return structured launch entries for
 * every meaningful change. The wrapper sends raw session_info every turn; the
 * broker is the single brain that decides "something changed, notify
 * the user." Each change becomes its own TranscriptLaunchEntry (phase: 'live',
 * fresh launchId) so they render as separate cards.
 */
function diffSessionInfo(prev: SessionInfoSnapshot, next: SessionInfoSnapshot): TranscriptLaunchEntry[] {
  const out: TranscriptLaunchEntry[] = []
  const ts = () => new Date().toISOString()
  const mkEntry = (step: WrapperLaunchStep, detail: string, raw: Record<string, unknown>): TranscriptLaunchEntry => ({
    type: 'launch',
    launchId: randomUUID(),
    phase: 'live',
    step,
    detail,
    raw,
    timestamp: ts(),
  })

  if (prev.model !== next.model && next.model) {
    out.push(mkEntry('model_changed', `${prev.model || '?'} -> ${next.model}`, { from: prev.model, to: next.model }))
  }
  if (prev.permissionMode !== next.permissionMode && next.permissionMode) {
    out.push(
      mkEntry('permission_mode_changed', `${prev.permissionMode || '?'} -> ${next.permissionMode}`, {
        from: prev.permissionMode,
        to: next.permissionMode,
      }),
    )
  }
  if (prev.fastModeState !== next.fastModeState) {
    out.push(
      mkEntry('fast_mode_changed', `${prev.fastModeState || 'off'} -> ${next.fastModeState || 'off'}`, {
        from: prev.fastModeState,
        to: next.fastModeState,
      }),
    )
  }

  // Collection diffs (names/identities, not identity-by-reference).
  const cases: Array<{ key: keyof SessionInfoSnapshot; step: WrapperLaunchStep }> = [
    { key: 'mcpServers', step: 'mcp_servers_changed' },
    { key: 'tools', step: 'tools_changed' },
    { key: 'slashCommands', step: 'slash_commands_changed' },
    { key: 'skills', step: 'skills_changed' },
    { key: 'agents', step: 'agents_changed' },
    { key: 'plugins', step: 'plugins_changed' },
  ]
  for (const { key, step } of cases) {
    const prevNames = arrNames(prev[key] as unknown[] | undefined)
    const nextNames = arrNames(next[key] as unknown[] | undefined)
    const { added, removed } = setDiff(prevNames, nextNames)
    if (added.length === 0 && removed.length === 0) continue
    const parts: string[] = []
    if (added.length > 0) parts.push(`+${added.length}`)
    if (removed.length > 0) parts.push(`-${removed.length}`)
    out.push(mkEntry(step, parts.join(' / '), { added, removed, count: nextNames.length }))
  }

  return out
}

const tasksUpdate: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || data.sessionId
  if (!sessionId) return
  const tasks = data.tasks || []
  ctx.sessions.updateTasks(sessionId, tasks)
  ctx.sessions.broadcastToChannel('conversation:tasks', sessionId, {
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
  ctx.sessions.broadcastToChannel('conversation:transcript', sessionId, data)
  console.log(`[transcript] ${sessionId.slice(0, 8)}... ${entries.length} entries (initial: ${data.isInitial})`)
}

const subagentTranscript: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || data.sessionId
  const agentId = data.agentId
  if (!sessionId || !agentId) return
  const entries = data.entries || []
  ctx.sessions.addSubagentTranscriptEntries(sessionId, agentId, entries, !!data.isInitial)
  ctx.sessions.broadcastToChannel('conversation:subagent_transcript', sessionId, data, agentId)
  console.log(`[transcript] ${sessionId.slice(0, 8)}... subagent ${agentId.slice(0, 7)} ${entries.length} entries`)
}

const bgTaskOutput: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || data.sessionId
  if (!sessionId || !data.taskId) return
  ctx.sessions.addBgTaskOutput(sessionId, data.taskId, data.data || '', !!data.done)
  ctx.sessions.broadcastToChannel('conversation:bg_output', sessionId, data)
}

const transcriptRequest: MessageHandler = (ctx, data) => {
  if (!data.sessionId) return
  const sess = ctx.sessions.getSession(data.sessionId as string)
  if (sess) ctx.requirePermission('chat:read', sess.project)
  if (ctx.sessions.hasTranscriptCache(data.sessionId)) {
    let entries =
      data.filter === 'display'
        ? filterDisplayEntries(ctx.sessions.getTranscriptEntries(data.sessionId), data.limit)
        : ctx.sessions.getTranscriptEntries(data.sessionId, data.limit)
    // Filter user entries for share viewers with hideUserInput
    if (ctx.ws.data.hideUserInput) {
      entries = entries.filter(e => (e as { type?: string }).type !== 'user')
    }
    ctx.reply({ type: 'transcript_entries', sessionId: data.sessionId, entries, isInitial: true })
  } else {
    const sessionSocket = ctx.sessions.getSessionSocket(data.sessionId)
    if (sessionSocket) sessionSocket.send(JSON.stringify(data))
  }
}

const subagentTranscriptRequest: MessageHandler = (ctx, data) => {
  if (!data.sessionId || !data.agentId) return
  const sess = ctx.sessions.getSession(data.sessionId as string)
  if (sess) ctx.requirePermission('chat:read', sess.project)
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
  const conversationId = ctx.ws.data.conversationId as string | undefined
  // Resolve session: try session ID first, then wrapper ID (session ID may have changed via SessionStart)
  const session =
    (wsSessionId ? ctx.sessions.getSession(wsSessionId) : null) ||
    (conversationId ? ctx.sessions.getSessionByConversation(conversationId) : null)
  if (!session) {
    ctx.log.debug(
      `session_info: no session found (wsSessionId=${wsSessionId?.slice(0, 8)}, conversationId=${conversationId?.slice(0, 8)})`,
    )
    return
  }
  const sessionId = session.id
  const prevSnapshot =
    ((session as unknown as Record<string, unknown>).sessionInfo as SessionInfoSnapshot | undefined) || {}
  const nextSnapshot: SessionInfoSnapshot = {
    tools: data.tools as unknown[] | undefined,
    slashCommands: data.slashCommands as unknown[] | undefined,
    skills: data.skills as unknown[] | undefined,
    agents: data.agents as unknown[] | undefined,
    mcpServers: data.mcpServers as Array<{ name: string; status?: string }> | undefined,
    plugins: data.plugins as unknown[] | undefined,
    model: data.model as string | undefined,
    permissionMode: data.permissionMode as string | undefined,
    claudeCodeVersion: data.claudeCodeVersion as string | undefined,
    fastModeState: data.fastModeState as string | undefined,
  }
  ;(session as unknown as Record<string, unknown>).sessionInfo = nextSnapshot

  // CC's stream-json init reports the full model ID including [1m] suffix,
  // but assistant message `model` fields strip it. Use init as the
  // authoritative source for configuredModel (context window detection).
  const initModel = data.model as string | undefined
  if (initModel) {
    session.configuredModel = initModel

    const requestedModel = session.launchConfig?.model
    const requestedFamily = requestedModel ? resolveModelFamily(requestedModel)?.familyId : undefined
    const actualFamily = resolveModelFamily(initModel)?.familyId
    if (requestedModel && requestedModel !== initModel && requestedFamily !== actualFamily) {
      session.modelMismatch = { requested: requestedModel, actual: initModel, detectedAt: Date.now() }
      ctx.log.info(`Model mismatch: requested=${requestedModel} actual=${initModel} session=${sessionId.slice(0, 8)}`)
      const warningEntry: import('../../shared/protocol').TranscriptSystemEntry = {
        type: 'system',
        subtype: 'model_mismatch',
        content: `Model mismatch: requested ${requestedModel} but CC is using ${initModel}`,
        level: 'warning',
        timestamp: new Date().toISOString(),
      }
      ctx.sessions.addTranscriptEntries(sessionId, [warningEntry], false)
      ctx.sessions.broadcastToChannel('conversation:transcript', sessionId, {
        type: 'transcript_entries',
        sessionId,
        entries: [warningEntry],
        isInitial: false,
      })
      ctx.sessions.broadcastSessionUpdate(sessionId)
    }
  }

  const initPermMode = data.permissionMode as string | undefined
  if (initPermMode) {
    session.permissionMode = initPermMode
  }

  // Diff against the previous snapshot (if any) and emit one transcript entry
  // per meaningful change. Only on subsequent snapshots -- the first
  // session_info is the initial state captured already by launch_event init_received,
  // so we skip it (prev is empty object => all fields look "new" which is noise).
  const hadPrevious = Object.keys(prevSnapshot).length > 0
  if (hadPrevious) {
    const changes = diffSessionInfo(prevSnapshot, nextSnapshot)
    if (changes.length > 0) {
      ctx.sessions.addTranscriptEntries(sessionId, changes, false)
      ctx.sessions.broadcastToChannel('conversation:transcript', sessionId, {
        type: 'transcript_entries',
        sessionId,
        entries: changes,
        isInitial: false,
      })
      ctx.log.info(`session_info diff: ${changes.map(c => c.step).join(', ')} (${sessionId.slice(0, 8)})`)
    }
  }

  // Broadcast with canonical session ID (not whatever the wrapper sent)
  if (session.project) {
    ctx.broadcastScoped({ ...data, type: 'conversation_info', sessionId }, session.project)
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
  if (session?.project) {
    ctx.broadcastScoped({ type: 'stream_delta', sessionId, event: data.event }, session.project)
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

    // Record to persistent cost store (delta computed internally)
    const now = Date.now()
    ctx.store.costs.recordTurnFromCumulatives({
      timestamp: now,
      conversationId: sessionId,
      projectUri: session.project,
      account: session.claudeAuth?.email || '',
      orgId: session.claudeAuth?.orgId || '',
      model: session.model || '',
      totalInputTokens: session.stats.totalInputTokens,
      totalOutputTokens: session.stats.totalOutputTokens,
      totalCacheRead: session.stats.totalCacheRead,
      totalCacheWrite: session.stats.totalCacheCreation,
      totalCostUsd: costUsd,
      exactCost: true,
    })

    // Broadcast live update for stats page
    ctx.broadcast({
      type: 'turn_recorded',
      sessionId,
      project: session.project,
      account: session.claudeAuth?.email || '',
      model: session.model || '',
      costUsd,
      inputTokens: session.stats.totalInputTokens,
      outputTokens: session.stats.totalOutputTokens,
      timestamp: now,
    })
  }
}

const sessionName: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const name = data.name as string
  const description = typeof data.description === 'string' ? data.description : undefined
  const session = ctx.sessions.getSession(sessionId)
  if (session && name) {
    if (data.userSet) {
      session.titleUserSet = true
    }
    if (session.titleUserSet && !data.userSet) {
      ctx.log.debug(`Ignoring auto session name "${name}" -- user-set title "${session.title}" preserved`)
      return
    }
    session.title = name
    if (description !== undefined) {
      session.description = description || undefined
    }
    ctx.sessions.broadcastSessionUpdate(sessionId)
    ctx.log.info(`Session name: "${name}" (${sessionId.slice(0, 8)})`)
  }
}

// Monitor lifecycle events - update session monitor state and broadcast
const monitorUpdate: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return
  const session = ctx.sessions.getSession(sessionId)
  if (!session) return
  const monitor = data.monitor as Record<string, unknown>
  if (!monitor?.taskId) return

  const taskId = monitor.taskId as string
  const existing = session.monitors.findIndex(m => m.taskId === taskId)

  if (existing >= 0) {
    // Update existing monitor
    const prev = session.monitors[existing]
    session.monitors[existing] = {
      ...prev,
      status: (monitor.status as 'running' | 'completed' | 'timed_out' | 'failed') || prev.status,
      eventCount: (monitor.eventCount as number) ?? prev.eventCount,
      stoppedAt: monitor.status !== 'running' ? Date.now() : undefined,
    }
  } else {
    // Add new monitor
    session.monitors.push({
      taskId,
      toolUseId: (monitor.toolUseId as string) || '',
      description: (monitor.description as string) || '',
      command: monitor.command as string | undefined,
      persistent: monitor.persistent as boolean | undefined,
      timeoutMs: monitor.timeoutMs as number | undefined,
      startedAt: (monitor.startedAt as number) || Date.now(),
      status: (monitor.status as 'running' | 'completed' | 'timed_out' | 'failed') || 'running',
      eventCount: (monitor.eventCount as number) || 0,
    })
  }

  // Cap stored monitors (keep last 50)
  if (session.monitors.length > 50) {
    session.monitors = session.monitors.slice(-50)
  }

  ctx.sessions.broadcastSessionUpdate(sessionId)
  ctx.log.debug(
    `monitor ${monitor.status}: ${taskId.toString().slice(0, 8)} "${(monitor.description as string)?.slice(0, 40)}"`,
  )
}

// Scheduled task fire - broadcast to dashboard subscribers
const scheduledTaskFire: MessageHandler = (ctx, data) => {
  const sessionId = ctx.ws.data.sessionId || (data.sessionId as string)
  if (!sessionId) return
  const session = ctx.sessions.getSession(sessionId)
  if (!session) return
  // Broadcast as a distinct event for dashboard to handle
  if (session.project) {
    ctx.broadcastScoped(
      {
        type: 'scheduled_task_fire',
        sessionId,
        content: data.content,
        timestamp: data.timestamp || Date.now(),
      },
      session.project,
    )
  }
  ctx.log.debug(`scheduled_task_fire: "${(data.content as string)?.slice(0, 60)}"`)
}

// Store the final result text from headless sessions (used for ad-hoc task completion display)
const resultText: MessageHandler = (ctx, data) => {
  const sessionId = data.sessionId as string
  const text = data.text as string
  const session = ctx.sessions.getSession(sessionId)
  if (session && text) {
    session.resultText = text
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
    result_text: resultText,
    monitor_update: monitorUpdate,
    scheduled_task_fire: scheduledTaskFire,
  })
}
