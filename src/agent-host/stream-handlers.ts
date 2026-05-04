/**
 * Message handlers for the stream-json backend.
 * Each function handles one top-level message type from CC's NDJSON output.
 */

import type { TranscriptEntry } from '../shared/protocol'
import { debug as _debug } from './debug'
import type { StreamBackendOptions, StreamInitMessage, StreamResultMessage } from './stream-backend'
import { deriveMonitorOutputPath, type MonitorTracker } from './stream-monitors'
import { flushReplayBuffer, type ReplayBuffer } from './stream-replay'

const debug = (msg: string) => _debug(`[stream] ${msg}`)

export interface HandlerContext {
  monitors: MonitorTracker
  replay: ReplayBuffer
  callbacks: Pick<
    StreamBackendOptions,
    | 'onTranscriptEntries'
    | 'onInit'
    | 'onResult'
    | 'onPermissionRequest'
    | 'onStreamEvent'
    | 'onRateLimit'
    | 'onTaskStarted'
    | 'onSubagentEntry'
    | 'onMonitorUpdate'
    | 'onScheduledTaskFire'
    | 'onPlanModeChanged'
    | 'onApiStatus'
  >
}

function extractSystemFields(msg: Record<string, unknown>): Record<string, unknown> {
  const { type: _t, subtype: _s, session_id: _sid, ...rest } = msg
  return rest
}

export function handleMessage(hctx: HandlerContext, msg: Record<string, unknown>) {
  const type = msg.type as string

  switch (type) {
    case 'system':
      handleSystem(hctx, msg)
      break
    case 'assistant':
      handleAssistant(hctx, msg)
      break
    case 'user':
      handleUser(hctx, msg)
      break
    case 'control_request':
      handleControlRequest(hctx, msg)
      break
    case 'result':
      handleResult(hctx, msg)
      break
    case 'stream_event':
      handleStreamEvent(hctx, msg)
      break
    case 'rate_limit_event':
      handleRateLimitEvent(hctx, msg)
      break
    case 'queue-operation':
      handleQueueOperation(hctx, msg)
      break
    default:
      debug(`Unknown message type: ${type}`)
  }
}

function handleSystem(hctx: HandlerContext, msg: Record<string, unknown>) {
  const { replay, callbacks } = hctx
  const subtype = msg.subtype as string
  const ts = new Date().toISOString()

  if (subtype === 'init') {
    debug(`init: session=${(msg.session_id as string)?.slice(0, 8)} model=${msg.model}`)
    callbacks.onInit?.(msg as unknown as StreamInitMessage)
    return
  }

  if (subtype === 'task_started') {
    handleTaskStarted(hctx, msg)
    return
  }

  if (subtype === 'hook_started' || subtype === 'hook_response') return

  if (!replay.done) flushReplayBuffer(replay, callbacks.onTranscriptEntries)

  const systemEntry = {
    type: 'system' as const,
    subtype,
    timestamp: ts,
    ...extractSystemFields(msg),
  } as TranscriptEntry

  const sysParentToolUseId = msg.parent_tool_use_id as string | null
  if (sysParentToolUseId && callbacks.onSubagentEntry) {
    callbacks.onSubagentEntry(sysParentToolUseId, systemEntry)
    return
  }

  const routedToSubagent = handleSystemSubtype(hctx, subtype, msg, systemEntry)

  if (!routedToSubagent) {
    callbacks.onTranscriptEntries?.([systemEntry], false)
  }
}

function handleTaskStarted(hctx: HandlerContext, msg: Record<string, unknown>) {
  const { monitors, callbacks } = hctx
  const taskType = msg.task_type as string
  const taskId = msg.task_id as string
  const toolUseId = msg.tool_use_id as string
  const description = (msg.description as string) || ''
  debug(`task_started: ${taskType} id=${taskId?.slice(0, 8)} ${description.slice(0, 40)}`)

  if (taskType === 'local_agent' && taskId && toolUseId) {
    monitors.agentTaskToToolUse.set(taskId, toolUseId)
  } else if (taskId && toolUseId) {
    const cached = monitors.pendingMonitorInputs.get(toolUseId)
    const monitorInfo = {
      toolUseId,
      description: cached?.description || description,
      command: cached?.command,
      persistent: cached?.persistent,
      timeoutMs: cached?.timeoutMs,
      eventCount: 0,
    }
    monitors.monitorTasks.set(taskId, monitorInfo)
    monitors.pendingMonitorInputs.delete(toolUseId)
    debug(`monitor_started: ${taskId.slice(0, 8)} "${monitorInfo.description.slice(0, 40)}"`)
    callbacks.onMonitorUpdate?.({
      taskId,
      ...monitorInfo,
      status: 'running',
      outputPath: deriveMonitorOutputPath(monitorInfo.command, taskId),
    })
  }
  callbacks.onTaskStarted?.({ taskId, toolUseId, taskType, description })
}

function handleSystemSubtype(
  hctx: HandlerContext,
  subtype: string,
  msg: Record<string, unknown>,
  systemEntry: TranscriptEntry,
): boolean {
  const { callbacks } = hctx
  let routedToSubagent = false

  switch (subtype) {
    case 'local_command_output':
      debug(`local_command_output: ${((msg.content as string) || '').slice(0, 80)}`)
      ;(systemEntry as Record<string, unknown>).subtype = 'local_command'
      break
    case 'api_retry':
      debug(
        `api_retry: attempt=${msg.attempt}/${msg.max_retries} delay=${msg.retry_delay_ms}ms status=${msg.error_status}`,
      )
      break
    case 'informational':
      debug(`informational: ${((msg.content as string) || '').slice(0, 80)}`)
      break
    case 'compact_boundary':
      debug('compact_boundary')
      break
    case 'session_state_changed':
      debug(`session_state_changed: ${msg.state}`)
      break
    case 'task_notification':
      routedToSubagent = handleTaskNotification(hctx, msg, systemEntry)
      break
    case 'task_progress':
      routedToSubagent = handleTaskProgress(hctx, msg, systemEntry)
      break
    case 'turn_duration':
      debug(`turn_duration: ${JSON.stringify(msg.duration_ms ?? msg)}`)
      break
    case 'memory_saved':
      debug('memory_saved')
      break
    case 'agents_killed':
      debug('agents_killed')
      break
    case 'permission_retry':
      debug(`permission_retry: ${msg.content}`)
      break
    case 'post_turn_summary':
      debug(`post_turn_summary: ${msg.status_category} "${(msg.title as string)?.slice(0, 40)}"`)
      break
    case 'scheduled_task_fire':
      debug(`scheduled_task_fire: ${msg.content}`)
      callbacks.onScheduledTaskFire?.((msg.content as string) || '')
      break
    case 'status':
      handleStatusSubtype(hctx, msg)
      break
    default:
      debug(`system/${subtype}: ${JSON.stringify(msg).slice(0, 120)}`)
      break
  }

  return routedToSubagent
}

function handleTaskNotification(
  hctx: HandlerContext,
  msg: Record<string, unknown>,
  systemEntry: TranscriptEntry,
): boolean {
  const { monitors, callbacks } = hctx
  const notifTaskId = msg.task_id as string
  const notifStatus = msg.status as string
  debug(`task_notification: task=${notifTaskId} status=${notifStatus}`)

  let routedToSubagent = false
  const notifToolUseId = monitors.agentTaskToToolUse.get(notifTaskId)
  if (notifToolUseId && callbacks.onSubagentEntry) {
    callbacks.onSubagentEntry(notifToolUseId, systemEntry)
    routedToSubagent = true
  }

  const notifMonitor = monitors.monitorTasks.get(notifTaskId)
  if (notifMonitor) {
    notifMonitor.eventCount++
    const terminalStatus =
      notifStatus === 'completed'
        ? 'completed'
        : notifStatus === 'failed'
          ? 'failed'
          : notifStatus === 'timed_out'
            ? 'timed_out'
            : null
    if (terminalStatus) {
      monitors.monitorTasks.delete(notifTaskId)
    }
    callbacks.onMonitorUpdate?.({
      taskId: notifTaskId,
      ...notifMonitor,
      status: (terminalStatus as 'completed' | 'failed' | 'timed_out') || 'running',
    })
  }
  return routedToSubagent
}

function handleTaskProgress(
  hctx: HandlerContext,
  msg: Record<string, unknown>,
  systemEntry: TranscriptEntry,
): boolean {
  const { monitors, callbacks } = hctx
  const progressTaskId = msg.task_id as string
  debug(`task_progress: task=${progressTaskId} tokens=${(msg.usage as Record<string, unknown>)?.total_tokens}`)

  let routedToSubagent = false
  const progressToolUseId = monitors.agentTaskToToolUse.get(progressTaskId)
  if (progressToolUseId && callbacks.onSubagentEntry) {
    callbacks.onSubagentEntry(progressToolUseId, systemEntry)
    routedToSubagent = true
  }

  const progressMonitor = monitors.monitorTasks.get(progressTaskId)
  if (progressMonitor) {
    progressMonitor.eventCount++
  }
  return routedToSubagent
}

function handleStatusSubtype(hctx: HandlerContext, msg: Record<string, unknown>) {
  const { callbacks } = hctx
  const apiStatus = msg.status as string | undefined
  const permMode = msg.permissionMode as string | undefined
  debug(`status: ${apiStatus || 'unknown'} permissionMode=${permMode}`)
  if (apiStatus) callbacks.onApiStatus?.(apiStatus)
  if (permMode && callbacks.onPlanModeChanged) {
    callbacks.onPlanModeChanged(permMode === 'plan')
  }
}

function handleAssistant(hctx: HandlerContext, msg: Record<string, unknown>) {
  const { monitors, replay, callbacks } = hctx
  const parentToolUseId = msg.parent_tool_use_id as string | null

  cacheMonitorInputs(monitors, msg)

  const entry = {
    type: 'assistant' as const,
    timestamp: (msg.timestamp as string) || new Date().toISOString(),
    message: msg.message,
    ...(msg.uuid ? { uuid: msg.uuid as string } : {}),
  } as TranscriptEntry

  if (parentToolUseId && callbacks.onSubagentEntry) {
    callbacks.onSubagentEntry(parentToolUseId, entry)
  } else if (msg.isReplay) {
    if (!replay.done) replay.entries.push(entry)
  } else {
    if (!replay.done) flushReplayBuffer(replay, callbacks.onTranscriptEntries)
    callbacks.onTranscriptEntries?.([entry], false)
  }
}

function cacheMonitorInputs(monitors: MonitorTracker, msg: Record<string, unknown>) {
  const assistantMsg = msg.message as { content?: Array<Record<string, unknown>> } | undefined
  if (!assistantMsg?.content) return

  for (const block of assistantMsg.content) {
    if (block.type === 'tool_use' && block.name === 'Monitor' && block.id) {
      const inp = block.input as Record<string, unknown> | undefined
      if (inp) {
        monitors.pendingMonitorInputs.set(block.id as string, {
          command: inp.command as string | undefined,
          persistent: inp.persistent as boolean | undefined,
          timeoutMs: (inp.timeout_ms as number | undefined) ?? (inp.timeoutMs as number | undefined),
          description: inp.description as string | undefined,
        })
      }
    }
  }
}

function handleUser(hctx: HandlerContext, msg: Record<string, unknown>) {
  const { monitors, replay, callbacks } = hctx
  const parentToolUseId = msg.parent_tool_use_id as string | null

  extractMonitorFromToolResult(monitors, callbacks, msg)
  detectMonitorNotifications(monitors, callbacks, msg)

  const entry = {
    type: 'user' as const,
    timestamp: (msg.timestamp as string) || new Date().toISOString(),
    message: msg.message,
    ...(msg.uuid ? { uuid: msg.uuid as string } : {}),
  } as TranscriptEntry

  if (msg.tool_use_result) {
    ;(entry as Record<string, unknown>).toolUseResult = msg.tool_use_result
  }

  if (parentToolUseId && callbacks.onSubagentEntry) {
    callbacks.onSubagentEntry(parentToolUseId, entry)
  } else if (msg.isReplay) {
    if (!replay.done) replay.entries.push(entry)
  } else {
    if (!replay.done) flushReplayBuffer(replay, callbacks.onTranscriptEntries)
    callbacks.onTranscriptEntries?.([entry], false)
  }
}

function extractMonitorFromToolResult(
  monitors: MonitorTracker,
  callbacks: HandlerContext['callbacks'],
  msg: Record<string, unknown>,
) {
  const userMsg = msg.message as { content?: string | Array<Record<string, unknown>> } | undefined
  if (!userMsg?.content || !Array.isArray(userMsg.content)) return

  for (const block of userMsg.content) {
    if (block.type !== 'tool_result' || typeof block.content !== 'string') continue

    const toolUseId = block.tool_use_id as string
    const monitorMatch = (block.content as string).match(/^Monitor started \(task (\w+), timeout (\d+)ms\)/)
    if (!monitorMatch || !toolUseId) continue

    const taskId = monitorMatch[1]
    const cached = monitors.pendingMonitorInputs.get(toolUseId)
    monitors.monitorTasks.set(taskId, {
      toolUseId,
      description: cached?.description || '',
      command: cached?.command,
      persistent: cached?.persistent,
      timeoutMs: cached?.timeoutMs ?? Number.parseInt(monitorMatch[2], 10),
      eventCount: 0,
    })
    monitors.pendingMonitorInputs.delete(toolUseId)
    debug(`monitor_started (from result): ${taskId.slice(0, 8)} "${cached?.description?.slice(0, 40) || ''}"`)
    callbacks.onMonitorUpdate?.({
      taskId,
      toolUseId,
      description: cached?.description || '',
      command: cached?.command,
      persistent: cached?.persistent,
      timeoutMs: cached?.timeoutMs ?? Number.parseInt(monitorMatch[2], 10),
      status: 'running',
      eventCount: 0,
      outputPath: deriveMonitorOutputPath(cached?.command, taskId),
    })
  }
}

function detectMonitorNotifications(
  monitors: MonitorTracker,
  callbacks: HandlerContext['callbacks'],
  msg: Record<string, unknown>,
) {
  const userMsg = msg.message as { content?: string | Array<Record<string, unknown>> } | undefined
  const userContent =
    typeof userMsg?.content === 'string'
      ? userMsg.content
      : Array.isArray(userMsg?.content)
        ? userMsg.content
            .filter((b): b is { text: string } => typeof (b as Record<string, unknown>).text === 'string')
            .map((b) => b.text)
            .join('')
        : ''

  if (!userContent.includes('<task-notification>')) return

  const taskIdMatch = userContent.match(/<task-id>(\w+)<\/task-id>/)
  const eventMatch = userContent.match(/<event>([\s\S]*?)<\/event>/)
  if (!taskIdMatch) return

  const notifTaskId = taskIdMatch[1]
  const monitor = monitors.monitorTasks.get(notifTaskId)
  if (!monitor) return

  monitor.eventCount++
  const isTimeout = eventMatch?.[1]?.includes('timed out')
  if (isTimeout) {
    monitors.monitorTasks.delete(notifTaskId)
    callbacks.onMonitorUpdate?.({ taskId: notifTaskId, ...monitor, status: 'timed_out' })
    debug(`monitor_timed_out: ${notifTaskId.slice(0, 8)}`)
  } else {
    callbacks.onMonitorUpdate?.({ taskId: notifTaskId, ...monitor, status: 'running' })
  }
}

function handleControlRequest(hctx: HandlerContext, msg: Record<string, unknown>) {
  const request = msg.request as Record<string, unknown> | undefined
  if (!request) return

  const subtype = request.subtype as string
  if (subtype !== 'can_use_tool') return

  const toolName = (request.tool_name as string) || ''
  const toolInput = (request.input as Record<string, unknown>) || {}
  const requestId = (msg.request_id as string) || (request.request_id as string) || ''
  debug(`Permission request: ${toolName} (${requestId}) reason=${request.decision_reason || ''}`)
  hctx.callbacks.onPermissionRequest?.({
    requestId,
    toolName,
    toolInput,
    ...request,
  })
}

function handleResult(hctx: HandlerContext, msg: Record<string, unknown>) {
  if (!hctx.replay.done) flushReplayBuffer(hctx.replay, hctx.callbacks.onTranscriptEntries)
  debug(`Result: ${msg.subtype} cost=$${msg.total_cost_usd} turns=${msg.num_turns}`)
  hctx.callbacks.onResult?.(msg as unknown as StreamResultMessage)
}

function handleStreamEvent(hctx: HandlerContext, msg: Record<string, unknown>) {
  if (!hctx.replay.done) flushReplayBuffer(hctx.replay, hctx.callbacks.onTranscriptEntries)
  hctx.callbacks.onStreamEvent?.((msg.event as Record<string, unknown>) || msg)
}

function handleRateLimitEvent(hctx: HandlerContext, msg: Record<string, unknown>) {
  const retryMs = (msg.retry_after_ms as number) || 5000
  const rateLimitMsg = (msg.message as string) || `Rate limited. Retrying in ${Math.ceil(retryMs / 1000)}s.`
  debug(`Rate limit: ${rateLimitMsg} (retry in ${retryMs}ms)`)
  hctx.callbacks.onRateLimit?.(retryMs, rateLimitMsg)
}

function handleQueueOperation(hctx: HandlerContext, msg: Record<string, unknown>) {
  if (!hctx.replay.done) flushReplayBuffer(hctx.replay, hctx.callbacks.onTranscriptEntries)
  const entry = {
    type: 'queue-operation' as const,
    timestamp: (msg.timestamp as string) || new Date().toISOString(),
    operation: msg.operation as string,
    ...(msg.content ? { content: msg.content as string } : {}),
  } as TranscriptEntry
  debug(`queue-operation: ${msg.operation}${msg.content ? ` "${(msg.content as string).slice(0, 40)}"` : ''}`)
  hctx.callbacks.onTranscriptEntries?.([entry], false)
}
