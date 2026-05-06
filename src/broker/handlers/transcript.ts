/**
 * Transcript and data streaming handlers.
 * Handles transcript entries, subagent transcripts, tasks, bg task output,
 * and diagnostic entries from rclaude -> broker cache -> dashboard.
 */

import { randomUUID } from 'node:crypto'
import { resolveModelFamily } from '../../shared/models'
import type { AgentHostLaunchStep, TranscriptLaunchEntry } from '../../shared/protocol'
import { filterDisplayEntries } from '../../shared/transcript-filter'
import type { MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'

/** Stored conversation_info snapshot shape used for cross-turn diffing. */
interface ConversationInfoSnapshot {
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
 * Compare two conversation_info snapshots and return structured launch entries for
 * every meaningful change. The agent host sends raw conversation_info every turn; the
 * broker is the single brain that decides "something changed, notify
 * the user." Each change becomes its own TranscriptLaunchEntry (phase: 'live',
 * fresh launchId) so they render as separate cards.
 */
function diffConversationInfo(prev: ConversationInfoSnapshot, next: ConversationInfoSnapshot): TranscriptLaunchEntry[] {
  const out: TranscriptLaunchEntry[] = []
  const ts = () => new Date().toISOString()
  const mkEntry = (step: AgentHostLaunchStep, detail: string, raw: Record<string, unknown>): TranscriptLaunchEntry => ({
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
  const cases: Array<{ key: keyof ConversationInfoSnapshot; step: AgentHostLaunchStep }> = [
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
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const tasks = data.tasks || []
  ctx.conversations.updateTasks(conversationId, tasks)
  ctx.conversations.broadcastToChannel('conversation:tasks', conversationId, {
    type: 'tasks_update',
    conversationId,
    tasks,
  })
  ctx.log.debug(`tasks_update (${tasks.length} tasks)`)
}

const diagHandler: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId || !Array.isArray(data.entries)) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) {
    conversation.diagLog.push(...data.entries)
    if (conversation.diagLog.length > 500) {
      conversation.diagLog.splice(0, conversation.diagLog.length - 500)
    }
  }
}

const transcriptEntries: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const entries = data.entries || []
  ctx.conversations.addTranscriptEntries(conversationId, entries, !!data.isInitial)
  ctx.conversations.broadcastToChannel('conversation:transcript', conversationId, data)
  console.log(`[transcript] ${conversationId.slice(0, 8)}... ${entries.length} entries (initial: ${data.isInitial})`)
}

const subagentTranscript: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  const agentId = data.agentId
  if (!conversationId || !agentId) return
  const entries = data.entries || []
  ctx.conversations.addSubagentTranscriptEntries(conversationId, agentId, entries, !!data.isInitial)
  ctx.conversations.broadcastToChannel('conversation:subagent_transcript', conversationId, data, agentId)
  console.log(`[transcript] ${conversationId.slice(0, 8)}... subagent ${agentId.slice(0, 7)} ${entries.length} entries`)
}

const bgTaskOutput: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId || !data.taskId) return
  ctx.conversations.addBgTaskOutput(conversationId, data.taskId, data.data || '', !!data.done)
  ctx.conversations.broadcastToChannel('conversation:bg_output', conversationId, data)
}

const transcriptRequest: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) ctx.requirePermission('chat:read', conversation.project)
  if (ctx.conversations.hasTranscriptCache(conversationId)) {
    let entries =
      data.filter === 'display'
        ? filterDisplayEntries(ctx.conversations.getTranscriptEntries(conversationId), data.limit)
        : ctx.conversations.getTranscriptEntries(conversationId, data.limit)
    // Filter user entries for share viewers with hideUserInput
    if (ctx.ws.data.hideUserInput) {
      entries = entries.filter(e => (e as { type?: string }).type !== 'user')
    }
    ctx.reply({ type: 'transcript_entries', conversationId, entries, isInitial: true })
  } else {
    const conversationSocket = ctx.conversations.getConversationSocket(conversationId)
    if (conversationSocket) conversationSocket.send(JSON.stringify(data))
  }
}

const subagentTranscriptRequest: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  if (!conversationId || !data.agentId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) ctx.requirePermission('chat:read', conversation.project)
  if (ctx.conversations.hasSubagentTranscriptCache(conversationId, data.agentId)) {
    const entries = ctx.conversations.getSubagentTranscriptEntries(conversationId, data.agentId, data.limit)
    ctx.reply({
      type: 'subagent_transcript',
      conversationId,
      agentId: data.agentId,
      entries,
      isInitial: true,
    })
  } else {
    const conversationSocket = ctx.conversations.getConversationSocket(conversationId)
    if (conversationSocket) conversationSocket.send(JSON.stringify(data))
  }
}

// Conversation info from headless init - store on conversation and broadcast to dashboard
const conversationInfo: MessageHandler = (ctx, data) => {
  const wsConversationId = ctx.ws.data.conversationId as string | undefined
  const conversation =
    (wsConversationId ? ctx.conversations.getConversation(wsConversationId) : null) ||
    (wsConversationId ? ctx.conversations.findConversationByConversationId(wsConversationId) : null)
  if (!conversation) {
    ctx.log.debug(`conversation_info: no conversation found (conversationId=${wsConversationId?.slice(0, 8)})`)
    return
  }
  const conversationId = conversation.id
  const prevSnapshot =
    ((conversation as unknown as Record<string, unknown>).conversationInfoSnapshot as
      | ConversationInfoSnapshot
      | undefined) || {}
  const nextSnapshot: ConversationInfoSnapshot = {
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
  ;(conversation as unknown as Record<string, unknown>).conversationInfoSnapshot = nextSnapshot

  // The init message is ground truth for model identity -- it's what CC
  // is actually running, not what was requested via --model.
  const initModel = data.model as string | undefined
  if (initModel) {
    conversation.model = initModel

    const requestedModel = conversation.launchConfig?.model
    const requestedFamily = requestedModel ? resolveModelFamily(requestedModel)?.familyId : undefined
    const actualFamily = resolveModelFamily(initModel)?.familyId
    if (requestedModel && requestedModel !== initModel && requestedFamily !== actualFamily) {
      conversation.modelMismatch = { requested: requestedModel, actual: initModel, detectedAt: Date.now() }
      ctx.log.info(
        `Model mismatch: requested=${requestedModel} actual=${initModel} conversation=${conversationId.slice(0, 8)}`,
      )
      const warningEntry: import('../../shared/protocol').TranscriptSystemEntry = {
        type: 'system',
        subtype: 'model_mismatch',
        content: `Model mismatch: requested ${requestedModel} but CC is using ${initModel}`,
        level: 'warning',
        timestamp: new Date().toISOString(),
      }
      ctx.conversations.addTranscriptEntries(conversationId, [warningEntry], false)
      ctx.conversations.broadcastToChannel('conversation:transcript', conversationId, {
        type: 'transcript_entries',
        conversationId,
        entries: [warningEntry],
        isInitial: false,
      })
      ctx.conversations.broadcastConversationUpdate(conversationId)
    }
  }

  const initPermMode = data.permissionMode as string | undefined
  if (initPermMode) {
    conversation.permissionMode = initPermMode
  }

  // Diff against the previous snapshot (if any) and emit one transcript entry
  // per meaningful change. Only on subsequent snapshots -- the first
  // conversation_info is the initial state captured already by launch_event init_received,
  // so we skip it (prev is empty object => all fields look "new" which is noise).
  const hadPrevious = Object.keys(prevSnapshot).length > 0
  if (hadPrevious) {
    const changes = diffConversationInfo(prevSnapshot, nextSnapshot)
    if (changes.length > 0) {
      ctx.conversations.addTranscriptEntries(conversationId, changes, false)
      ctx.conversations.broadcastToChannel('conversation:transcript', conversationId, {
        type: 'transcript_entries',
        conversationId,
        entries: changes,
        isInitial: false,
      })
      ctx.log.info(`conversation_info diff: ${changes.map(c => c.step).join(', ')} (${conversationId.slice(0, 8)})`)
    }
  }

  // Persist metadata so it survives broker restarts
  ctx.conversations.persistConversationById(conversationId)

  // Broadcast with canonical conversation ID (not whatever the agent host sent)
  if (conversation.project) {
    ctx.broadcastScoped({ ...data, type: 'conversation_info', conversationId }, conversation.project)
  }
  ctx.log.debug(
    `conversation_info: ${(data.tools as unknown[])?.length} tools, ${(data.skills as unknown[])?.length} skills, ${(data.agents as unknown[])?.length} agents`,
  )
}

// Headless stream deltas - forward raw API SSE events to dashboard subscribers
const streamDelta: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation?.project) {
    ctx.broadcastScoped({ type: 'stream_delta', conversationId, event: data.event }, conversation.project)
  }
}

// Rate limit event from headless backend - store on conversation and broadcast update
const rateLimitHandler: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) return
  conversation.rateLimit = {
    retryAfterMs: (data.retryAfterMs as number) || 5000,
    message: (data.message as string) || 'Rate limited',
    timestamp: Date.now(),
  }
  ctx.conversations.broadcastConversationUpdate(conversationId)
}

const MAX_COST_TIMELINE = 500

const turnCost: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const costUsd = data.costUsd as number
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation) {
    conversation.stats.totalCostUsd = costUsd
    if (!conversation.costTimeline) conversation.costTimeline = []
    conversation.costTimeline.push({ t: Date.now(), cost: costUsd })
    if (conversation.costTimeline.length > MAX_COST_TIMELINE) {
      conversation.costTimeline = conversation.costTimeline.slice(-MAX_COST_TIMELINE)
    }
    ctx.conversations.broadcastConversationUpdate(conversationId)

    // Record to persistent cost store (delta computed internally)
    const now = Date.now()
    ctx.store.costs.recordTurnFromCumulatives({
      timestamp: now,
      conversationId,
      projectUri: conversation.project,
      account: conversation.claudeAuth?.email || '',
      orgId: conversation.claudeAuth?.orgId || '',
      model: conversation.model || '',
      totalInputTokens: conversation.stats.totalInputTokens,
      totalOutputTokens: conversation.stats.totalOutputTokens,
      totalCacheRead: conversation.stats.totalCacheRead,
      totalCacheWrite: conversation.stats.totalCacheCreation,
      totalCostUsd: costUsd,
      exactCost: true,
    })

    // Broadcast live update for stats page
    ctx.broadcast({
      type: 'turn_recorded',
      conversationId,
      project: conversation.project,
      account: conversation.claudeAuth?.email || '',
      model: conversation.model || '',
      costUsd,
      inputTokens: conversation.stats.totalInputTokens,
      outputTokens: conversation.stats.totalOutputTokens,
      timestamp: now,
    })
  }
}

const conversationName: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const name = data.name as string
  const description = typeof data.description === 'string' ? data.description : undefined
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation && name) {
    if (data.userSet) {
      conversation.titleUserSet = true
    }
    if (conversation.titleUserSet && !data.userSet) {
      ctx.log.debug(`Ignoring auto conversation name "${name}" -- user-set title "${conversation.title}" preserved`)
      return
    }
    conversation.title = name
    if (description !== undefined) {
      conversation.description = description || undefined
    }
    ctx.conversations.broadcastConversationUpdate(conversationId)
    ctx.log.info(`Conversation name: "${name}" (${conversationId.slice(0, 8)})`)
  }
}

// Monitor lifecycle events - update conversation monitor state and broadcast
const monitorUpdate: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) return
  const monitor = data.monitor as Record<string, unknown>
  if (!monitor?.taskId) return

  const taskId = monitor.taskId as string
  const existing = conversation.monitors.findIndex(m => m.taskId === taskId)

  if (existing >= 0) {
    // Update existing monitor
    const prev = conversation.monitors[existing]
    conversation.monitors[existing] = {
      ...prev,
      status: (monitor.status as 'running' | 'completed' | 'timed_out' | 'failed') || prev.status,
      eventCount: (monitor.eventCount as number) ?? prev.eventCount,
      stoppedAt: monitor.status !== 'running' ? Date.now() : undefined,
    }
  } else {
    // Add new monitor
    conversation.monitors.push({
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
  if (conversation.monitors.length > 50) {
    conversation.monitors = conversation.monitors.slice(-50)
  }

  ctx.conversations.broadcastConversationUpdate(conversationId)
  ctx.log.debug(
    `monitor ${monitor.status}: ${taskId.toString().slice(0, 8)} "${(monitor.description as string)?.slice(0, 40)}"`,
  )
}

// Scheduled task fire - broadcast to dashboard subscribers
const scheduledTaskFire: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  if (!conversationId) return
  const conversation = ctx.conversations.getConversation(conversationId)
  if (!conversation) return
  // Broadcast as a distinct event for dashboard to handle
  if (conversation.project) {
    ctx.broadcastScoped(
      {
        type: 'scheduled_task_fire',
        conversationId,
        content: data.content,
        timestamp: data.timestamp || Date.now(),
      },
      conversation.project,
    )
  }
  ctx.log.debug(`scheduled_task_fire: "${(data.content as string)?.slice(0, 60)}"`)
}

// Store the final result text from headless conversations (used for ad-hoc task completion display)
const resultText: MessageHandler = (ctx, data) => {
  const conversationId = data.conversationId as string
  const text = data.text as string
  const conversation = ctx.conversations.getConversation(conversationId)
  if (conversation && text) {
    conversation.resultText = text
  }
}

export function registerTranscriptHandlers(): void {
  registerHandlers({
    conversation_name: conversationName,
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
    conversation_info: conversationInfo,
    result_text: resultText,
    monitor_update: monitorUpdate,
    scheduled_task_fire: scheduledTaskFire,
  })
}
