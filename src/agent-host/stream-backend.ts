/**
 * Stream-JSON Backend (headless mode)
 * Spawns claude --print with NDJSON I/O instead of PTY.
 * Parses structured output and converts to TranscriptEntry format.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import type { TranscriptEntry } from '../shared/protocol'
import { debug as _debug } from './debug'

// Console transcript output (RCLAUDE_SHOW_TRANSCRIPT=1)
const SHOW_PRETTY = !!process.env.RCLAUDE_SHOW_TRANSCRIPT_PRETTY
const SHOW_TRANSCRIPT = SHOW_PRETTY || !!process.env.RCLAUDE_SHOW_TRANSCRIPT

// ANSI color helpers
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  bgGray: '\x1b[100m',
}

// Colorize JSON keys and values for terminal output
function colorizeJson(json: string): string {
  return json
    .replace(/"([^"]+)":/g, `${C.cyan}$1${C.reset}:`) // keys in cyan, no quotes
    .replace(/: "([^"]*?)"/g, `: ${C.green}$1${C.reset}`) // string values in green, no quotes
    .replace(/: (\d+\.?\d*)/g, `: ${C.yellow}$1${C.reset}`) // numbers in yellow
    .replace(/: (true|false|null)/g, `: ${C.magenta}$1${C.reset}`) // literals in magenta
}

function transcriptLog(direction: '>>>' | '<<<', msg: Record<string, unknown>) {
  if (!SHOW_TRANSCRIPT) return
  const type = msg.type as string

  // Skip stream_event deltas (too noisy)
  if (type === 'stream_event') return

  const arrow = direction === '>>>' ? `${C.cyan}>>>${C.reset}` : `${C.green}<<<${C.reset}`

  if (SHOW_PRETTY) {
    // Pretty mode: indented JSON with colorized keys/values
    const json = JSON.stringify(msg, null, 2)
    process.stderr.write(`${arrow} ${colorizeJson(json)}\n`)
  } else {
    // Raw mode: compact NDJSON, no colors
    process.stderr.write(`${direction} ${JSON.stringify(msg)}\n`)
  }
}

const debug = (msg: string) => _debug(`[stream] ${msg}`)

export interface StreamBackendOptions {
  args: string[]
  settingsPath: string
  conversationId: string
  localServerPort: number
  brokerUrl?: string
  brokerSecret?: string
  cwd?: string
  env?: Record<string, string>
  includePartialMessages?: boolean
  onTranscriptEntries?: (entries: TranscriptEntry[], isInitial: boolean) => void
  onInit?: (init: StreamInitMessage) => void
  onResult?: (result: StreamResultMessage) => void
  onPermissionRequest?: (request: StreamPermissionRequest) => void
  onStreamEvent?: (event: Record<string, unknown>) => void
  onRateLimit?: (retryAfterMs: number, message: string) => void
  onTaskStarted?: (task: { taskId: string; toolUseId: string; taskType: string; description: string }) => void
  onSubagentEntry?: (toolUseId: string, entry: TranscriptEntry) => void
  onMonitorUpdate?: (monitor: {
    taskId: string
    toolUseId: string
    description: string
    command?: string
    persistent?: boolean
    timeoutMs?: number
    status: 'running' | 'completed' | 'timed_out' | 'failed'
    eventCount: number
    outputPath?: string // .output file path if derivable from command
  }) => void
  onScheduledTaskFire?: (content: string) => void
  onPlanModeChanged?: (planMode: boolean) => void
  onApiStatus?: (status: string) => void
  onJsonStreamLine?: (line: string) => void
  onExit?: (code: number | null) => void
}

export interface StreamInitMessage {
  session_id: string
  cwd: string
  model: string
  tools: Array<{ name: string; type?: string }>
  mcp_servers?: Array<{ name: string; status?: string }>
  claude_code_version?: string
  permissionMode?: string
  [key: string]: unknown
}

export interface StreamResultMessage {
  subtype: string
  total_cost_usd?: number
  duration_ms?: number
  duration_api_ms?: number
  num_turns?: number
  usage?: Record<string, unknown>
  [key: string]: unknown
}

export interface StreamPermissionRequest {
  requestId: string
  toolName: string
  toolInput: Record<string, unknown>
  [key: string]: unknown
}

export interface StreamProcess {
  proc: Subprocess
  sendUserMessage: (text: string, source?: string) => void
  sendPermissionResponse: (
    requestId: string,
    allow: boolean,
    updatedInput?: Record<string, unknown>,
    toolUseId?: string,
  ) => void
  sendSetModel: (model: string) => void
  sendSetPermissionMode: (mode: string) => void
  sendUpdateEnv: (variables: Record<string, string>) => void
  sendSetEffort: (level: string) => void
  sendInterrupt: () => void
  forwardStdin: () => void
  kill: (signal?: NodeJS.Signals) => void
  /** Close CC's stdin pipe (EOF) for graceful shutdown. CC will flush
   *  its transcript and exit naturally. Returns true if stdin was closed. */
  closeStdin: () => boolean
}

/**
 * Spawn claude in stream-json mode (headless)
 */
export function spawnStreamClaude(options: StreamBackendOptions): StreamProcess {
  const {
    args,
    settingsPath,
    conversationId,
    localServerPort,
    brokerUrl,
    brokerSecret,
    cwd,
    env,
    onTranscriptEntries,
    onInit,
    onResult,
    onPermissionRequest,
    onStreamEvent,
    onRateLimit,
    onTaskStarted,
    onSubagentEntry,
    onMonitorUpdate,
    onScheduledTaskFire,
    onPlanModeChanged,
    onApiStatus,
    onJsonStreamLine,
    onExit,
  } = options

  // Build args: inject --print, stream-json, settings, then user args
  // Filter out any existing --print/--output-format/--input-format from user args
  const filteredArgs = args.filter(
    (a, i, arr) =>
      a !== '--print' &&
      a !== '-p' &&
      !(a === '--output-format' || (i > 0 && arr[i - 1] === '--output-format')) &&
      !(a === '--input-format' || (i > 0 && arr[i - 1] === '--input-format')),
  )

  const claudeArgs = [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    ...(options.includePartialMessages !== false ? ['--include-partial-messages'] : []),
    '--replay-user-messages',
    '--permission-prompt-tool',
    'stdio',
    '--settings',
    settingsPath,
    ...filteredArgs,
  ]

  debug(`Spawning: claude ${claudeArgs.join(' ')}`)

  const proc = Bun.spawn(['claude', ...claudeArgs], {
    cwd: cwd || process.cwd(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ...env,
      RCLAUDE_SESSION_ID: conversationId,
      RCLAUDE_PORT: String(localServerPort),
      ...(brokerUrl ? { RCLAUDE_BROKER: brokerUrl } : {}),
      ...(brokerSecret ? { RCLAUDE_SECRET: brokerSecret } : {}),
      CLAUDE_CODE_TASK_LIST_ID: conversationId,
      // No FORCE_COLOR, no TERM, no SSH_TTY - headless mode
    },
    onExit(_proc, exitCode) {
      debug(`Process exited with code ${exitCode}`)
      onExit?.(exitCode)
    },
  })

  // Diagnostic log - raw capture of everything from stdout/stderr for post-mortem analysis
  const diagDir = join(cwd || process.cwd(), '.rclaude', 'settings')
  const diagPath = join(diagDir, `headless-${conversationId}.ndjsonl`)
  try {
    mkdirSync(diagDir, { recursive: true })
    writeFileSync(diagPath, `# headless stream log - ${new Date().toISOString()}\n# pid=${proc.pid}\n`)
    debug(`Diagnostic log: ${diagPath}`)
  } catch {
    debug('Failed to create diagnostic log')
  }

  function diagLog(prefix: string, line: string) {
    try {
      appendFileSync(diagPath, `${prefix} ${line}\n`)
    } catch {
      // ignore write errors
    }
  }

  // Track agent task IDs so we can route task_progress/task_notification to subagent transcript
  // Maps taskId -> toolUseId (reverse of what onTaskStarted builds externally)
  const agentTaskToToolUse = new Map<string, string>()

  // Track monitor tasks (non-agent background tasks like Monitor tool)
  // Maps taskId -> { toolUseId, description, command?, persistent?, timeoutMs?, eventCount }
  const monitorTasks = new Map<
    string,
    {
      toolUseId: string
      description: string
      command?: string
      persistent?: boolean
      timeoutMs?: number
      eventCount: number
    }
  >()

  // Cache Monitor tool_use inputs from assistant messages for correlation with task_started
  // Maps toolUseId -> { command, persistent, timeoutMs, description }
  const pendingMonitorInputs = new Map<
    string,
    { command?: string; persistent?: boolean; timeoutMs?: number; description?: string }
  >()

  /**
   * Derive the monitor's .output file path from its command.
   * Monitor commands often tail another task's .output file in the same tasks dir.
   * Example: "tail -f /tmp/claude-501/-Users-.../tasks/berphqd4r.output | grep ..."
   * -> tasks dir: /tmp/claude-501/-Users-.../tasks/
   * -> monitor output: /tmp/claude-501/-Users-.../tasks/{monitorTaskId}.output
   */
  function deriveMonitorOutputPath(command: string | undefined, monitorTaskId: string): string | undefined {
    if (!command) return undefined
    const match = command.match(/(\S+\/tasks\/)[\w-]+\.output/)
    if (match) return `${match[1]}${monitorTaskId}.output`
    return undefined
  }

  // Replay buffer: accumulate replayed entries from --resume, flush as isInitial=true
  const MAX_INITIAL_ENTRIES = 500
  const METADATA_TYPES = new Set(['summary', 'custom-title', 'agent-name', 'pr-link'])
  let replayBuffer: TranscriptEntry[] = []
  let replayDone = false

  function flushReplayBuffer() {
    if (replayDone) return
    replayDone = true
    if (replayBuffer.length === 0) return

    debug(`Flushing replay buffer: ${replayBuffer.length} entries (isInitial=true)`)
    let entries = replayBuffer
    if (entries.length > MAX_INITIAL_ENTRIES) {
      // Same tail cap as transcript-watcher: keep last 500 + metadata from earlier
      const tail = entries.slice(-MAX_INITIAL_ENTRIES)
      const tailSet = new Set(tail)
      const metadata = entries.filter(
        e => METADATA_TYPES.has((e as Record<string, unknown>).type as string) && !tailSet.has(e),
      )
      entries = [...metadata, ...tail]
    }
    onTranscriptEntries?.(entries, true)
    replayBuffer = []
  }

  /** Strip transport-only fields, keep everything CC sent */
  function extractSystemFields(msg: Record<string, unknown>): Record<string, unknown> {
    const { type: _t, subtype: _s, session_id: _sid, ...rest } = msg
    return rest
  }

  // Line buffer for NDJSON parsing
  let lineBuf = ''

  function processLine(line: string) {
    if (!line.trim()) return
    diagLog('>>>', line)
    onJsonStreamLine?.(line)
    try {
      const msg = JSON.parse(line) as Record<string, unknown>
      transcriptLog('>>>', msg)
      handleMessage(msg)
    } catch (err) {
      debug(`Failed to parse NDJSON line: ${err}`)
      diagLog('ERR', `parse: ${err}`)
    }
  }

  function handleMessage(msg: Record<string, unknown>) {
    const type = msg.type as string

    switch (type) {
      case 'system': {
        const subtype = msg.subtype as string
        const ts = new Date().toISOString()

        if (subtype === 'init') {
          debug(`init: session=${(msg.session_id as string)?.slice(0, 8)} model=${msg.model}`)
          onInit?.(msg as unknown as StreamInitMessage)
          break
        }

        if (subtype === 'task_started') {
          const taskType = msg.task_type as string
          const taskId = msg.task_id as string
          const toolUseId = msg.tool_use_id as string
          const description = (msg.description as string) || ''
          debug(`task_started: ${taskType} id=${taskId?.slice(0, 8)} ${description.slice(0, 40)}`)
          // Track agent tasks so task_progress/task_notification can be routed to subagent
          if (taskType === 'local_agent' && taskId && toolUseId) {
            agentTaskToToolUse.set(taskId, toolUseId)
          } else if (taskId && toolUseId) {
            // Track non-agent tasks (monitors, background processes)
            // Correlate with cached Monitor tool inputs if available
            const cached = pendingMonitorInputs.get(toolUseId)
            const monitorInfo = {
              toolUseId,
              description: cached?.description || description,
              command: cached?.command,
              persistent: cached?.persistent,
              timeoutMs: cached?.timeoutMs,
              eventCount: 0,
            }
            monitorTasks.set(taskId, monitorInfo)
            pendingMonitorInputs.delete(toolUseId)
            debug(`monitor_started: ${taskId.slice(0, 8)} "${monitorInfo.description.slice(0, 40)}"`)
            onMonitorUpdate?.({
              taskId,
              ...monitorInfo,
              status: 'running',
              outputPath: deriveMonitorOutputPath(monitorInfo.command, taskId),
            })
          }
          onTaskStarted?.({ taskId, toolUseId, taskType, description })
          break
        }

        // Hook events are informational -- hooks still fire via HTTP
        if (subtype === 'hook_started' || subtype === 'hook_response') break

        // Everything below produces a transcript entry for the dashboard
        if (!replayDone) flushReplayBuffer()

        // Build a system transcript entry preserving all fields from CC
        const systemEntry = {
          type: 'system' as const,
          subtype,
          timestamp: ts,
          ...extractSystemFields(msg),
        } as TranscriptEntry

        // Route subagent system messages to subagent transcript
        const sysParentToolUseId = msg.parent_tool_use_id as string | null
        if (sysParentToolUseId && onSubagentEntry) {
          onSubagentEntry(sysParentToolUseId, systemEntry)
          break
        }

        let routedToSubagent = false
        switch (subtype) {
          case 'local_command_output':
            debug(`local_command_output: ${((msg.content as string) || '').slice(0, 80)}`)
            // Remap to 'local_command' subtype (matches JSONL transcript format)
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
          case 'task_notification': {
            const notifTaskId = msg.task_id as string
            const notifStatus = msg.status as string
            debug(`task_notification: task=${notifTaskId} status=${notifStatus}`)
            // Route to subagent transcript if this task belongs to an agent
            const notifToolUseId = agentTaskToToolUse.get(notifTaskId)
            if (notifToolUseId && onSubagentEntry) {
              onSubagentEntry(notifToolUseId, systemEntry)
              routedToSubagent = true
            }
            // Track monitor task events and completion
            const notifMonitor = monitorTasks.get(notifTaskId)
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
                monitorTasks.delete(notifTaskId)
              }
              onMonitorUpdate?.({
                taskId: notifTaskId,
                ...notifMonitor,
                status: (terminalStatus as 'completed' | 'failed' | 'timed_out') || 'running',
              })
            }
            break
          }
          case 'task_progress': {
            const progressTaskId = msg.task_id as string
            debug(
              `task_progress: task=${progressTaskId} tokens=${(msg.usage as Record<string, unknown>)?.total_tokens}`,
            )
            // Route to subagent transcript if this task belongs to an agent
            const progressToolUseId = agentTaskToToolUse.get(progressTaskId)
            if (progressToolUseId && onSubagentEntry) {
              onSubagentEntry(progressToolUseId, systemEntry)
              routedToSubagent = true
            }
            // Increment monitor event count (progress counts as activity)
            const progressMonitor = monitorTasks.get(progressTaskId)
            if (progressMonitor) {
              progressMonitor.eventCount++
            }
            break
          }
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
            onScheduledTaskFire?.((msg.content as string) || '')
            break
          case 'status': {
            const apiStatus = msg.status as string | undefined
            const permMode = msg.permissionMode as string | undefined
            debug(`status: ${apiStatus || 'unknown'} permissionMode=${permMode}`)
            if (apiStatus) onApiStatus?.(apiStatus)
            if (permMode && onPlanModeChanged) {
              onPlanModeChanged(permMode === 'plan')
            }
            break
          }
          default:
            debug(`system/${subtype}: ${JSON.stringify(msg).slice(0, 120)}`)
            break
        }

        if (!routedToSubagent) {
          onTranscriptEntries?.([systemEntry], false)
        }
        break
      }

      case 'assistant': {
        const parentToolUseId = msg.parent_tool_use_id as string | null
        // Cache Monitor tool_use inputs for correlation with task_started
        const assistantMsg = msg.message as { content?: Array<Record<string, unknown>> } | undefined
        if (assistantMsg?.content) {
          for (const block of assistantMsg.content) {
            if (block.type === 'tool_use' && block.name === 'Monitor' && block.id) {
              const inp = block.input as Record<string, unknown> | undefined
              if (inp) {
                pendingMonitorInputs.set(block.id as string, {
                  command: inp.command as string | undefined,
                  persistent: inp.persistent as boolean | undefined,
                  timeoutMs: (inp.timeout_ms as number | undefined) ?? (inp.timeoutMs as number | undefined),
                  description: inp.description as string | undefined,
                })
              }
            }
          }
        }
        const entry = {
          type: 'assistant' as const,
          timestamp: (msg.timestamp as string) || new Date().toISOString(),
          message: msg.message,
          ...(msg.uuid ? { uuid: msg.uuid as string } : {}),
        } as TranscriptEntry
        if (parentToolUseId && onSubagentEntry) {
          onSubagentEntry(parentToolUseId, entry)
        } else if (msg.isReplay) {
          // Replayed assistant entry. Buffer during the initial --resume replay
          // phase (flushed as isInitial=true). After replayDone, CC still emits
          // isReplay:true echoes (e.g. when mirroring a stdin write back, or
          // at internal context boundaries) -- those are duplicates of entries
          // already in the live transcript, so skip them.
          if (!replayDone) replayBuffer.push(entry)
        } else {
          if (!replayDone) flushReplayBuffer()
          onTranscriptEntries?.([entry], false)
        }
        break
      }

      case 'user': {
        const parentToolUseId = msg.parent_tool_use_id as string | null
        // Extract Monitor taskId from tool_result content (CC doesn't emit task_started for monitors)
        // Format: "Monitor started (task bax7qc9od, timeout 20000ms)..."
        const userMsg = msg.message as { content?: string | Array<Record<string, unknown>> } | undefined
        if (userMsg?.content && Array.isArray(userMsg.content)) {
          for (const block of userMsg.content) {
            if (block.type === 'tool_result' && typeof block.content === 'string') {
              const toolUseId = block.tool_use_id as string
              const monitorMatch = (block.content as string).match(/^Monitor started \(task (\w+), timeout (\d+)ms\)/)
              if (monitorMatch && toolUseId) {
                const taskId = monitorMatch[1]
                const cached = pendingMonitorInputs.get(toolUseId)
                monitorTasks.set(taskId, {
                  toolUseId,
                  description: cached?.description || '',
                  command: cached?.command,
                  persistent: cached?.persistent,
                  timeoutMs: cached?.timeoutMs ?? Number.parseInt(monitorMatch[2], 10),
                  eventCount: 0,
                })
                pendingMonitorInputs.delete(toolUseId)
                debug(
                  `monitor_started (from result): ${taskId.slice(0, 8)} "${cached?.description?.slice(0, 40) || ''}"`,
                )
                onMonitorUpdate?.({
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
          }
        }
        // Detect monitor events from <task-notification> XML in user content
        const userContent =
          typeof userMsg?.content === 'string'
            ? userMsg.content
            : Array.isArray(userMsg?.content)
              ? userMsg.content
                  .filter((b): b is { text: string } => typeof (b as Record<string, unknown>).text === 'string')
                  .map(b => b.text)
                  .join('')
              : ''
        if (userContent.includes('<task-notification>')) {
          const taskIdMatch = userContent.match(/<task-id>(\w+)<\/task-id>/)
          const eventMatch = userContent.match(/<event>([\s\S]*?)<\/event>/)
          if (taskIdMatch) {
            const notifTaskId = taskIdMatch[1]
            const monitor = monitorTasks.get(notifTaskId)
            if (monitor) {
              monitor.eventCount++
              const isTimeout = eventMatch?.[1]?.includes('timed out')
              if (isTimeout) {
                monitorTasks.delete(notifTaskId)
                onMonitorUpdate?.({ taskId: notifTaskId, ...monitor, status: 'timed_out' })
                debug(`monitor_timed_out: ${notifTaskId.slice(0, 8)}`)
              } else {
                onMonitorUpdate?.({ taskId: notifTaskId, ...monitor, status: 'running' })
              }
            }
          }
        }
        // Tool results echoed back, or replayed user messages
        const entry = {
          type: 'user' as const,
          timestamp: (msg.timestamp as string) || new Date().toISOString(),
          message: msg.message,
          ...(msg.uuid ? { uuid: msg.uuid as string } : {}),
        } as TranscriptEntry
        // CC puts Edit diff data on tool_use_result (snake_case) - copy to toolUseResult (camelCase)
        if (msg.tool_use_result) {
          ;(entry as Record<string, unknown>).toolUseResult = msg.tool_use_result
        }
        if (parentToolUseId && onSubagentEntry) {
          onSubagentEntry(parentToolUseId, entry)
        } else if (msg.isReplay) {
          // Replayed user message. Buffer during the initial --resume replay
          // phase (flushed as isInitial=true). After replayDone, CC still emits
          // isReplay:true echoes of the user's stdin input; those are
          // duplicates of the live optimistic entry the dashboard already
          // rendered, so skip them. (Tool results arrive as type=user WITHOUT
          // isReplay and fall through to the live branch below.)
          if (!replayDone) replayBuffer.push(entry)
        } else {
          if (!replayDone) flushReplayBuffer()
          onTranscriptEntries?.([entry], false)
        }
        break
      }

      case 'control_request': {
        const request = msg.request as Record<string, unknown> | undefined
        if (!request) break
        const subtype = request.subtype as string
        if (subtype === 'can_use_tool') {
          // CC sends tool_name/input at top level of request, NOT nested under tool_use
          const toolName = (request.tool_name as string) || ''
          const toolInput = (request.input as Record<string, unknown>) || {}
          const requestId = (msg.request_id as string) || (request.request_id as string) || ''
          debug(`Permission request: ${toolName} (${requestId}) reason=${request.decision_reason || ''}`)
          onPermissionRequest?.({
            requestId,
            toolName,
            toolInput,
            ...request,
          })
        }
        break
      }

      case 'result': {
        if (!replayDone) flushReplayBuffer()
        debug(`Result: ${msg.subtype} cost=$${msg.total_cost_usd} turns=${msg.num_turns}`)
        onResult?.(msg as unknown as StreamResultMessage)
        break
      }

      case 'stream_event': {
        // First stream_event = live API activity, replay is definitely over
        if (!replayDone) flushReplayBuffer()
        // Raw API SSE deltas - token-by-token streaming
        // Send the inner event (content_block_delta, message_stop, etc.), not the CC wrapper
        onStreamEvent?.((msg.event as Record<string, unknown>) || msg)
        break
      }

      case 'rate_limit_event': {
        const retryMs = (msg.retry_after_ms as number) || 5000
        const rateLimitMsg = (msg.message as string) || `Rate limited. Retrying in ${Math.ceil(retryMs / 1000)}s.`
        debug(`Rate limit: ${rateLimitMsg} (retry in ${retryMs}ms)`)
        onRateLimit?.(retryMs, rateLimitMsg)
        break
      }

      case 'queue-operation': {
        if (!replayDone) flushReplayBuffer()
        const entry = {
          type: 'queue-operation' as const,
          timestamp: (msg.timestamp as string) || new Date().toISOString(),
          operation: msg.operation as string,
          ...(msg.content ? { content: msg.content as string } : {}),
        } as TranscriptEntry
        debug(`queue-operation: ${msg.operation}${msg.content ? ` "${(msg.content as string).slice(0, 40)}"` : ''}`)
        onTranscriptEntries?.([entry], false)
        break
      }

      default:
        debug(`Unknown message type: ${type}`)
    }
  }

  // Read stdout as NDJSON stream
  async function readStream() {
    if (!proc.stdout) return
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        lineBuf += chunk
        const lines = lineBuf.split('\n')
        // Keep last (potentially incomplete) line in buffer
        lineBuf = lines.pop() || ''
        for (const line of lines) {
          processLine(line)
        }
      }
      // Process any remaining data
      if (lineBuf.trim()) processLine(lineBuf)
      // Flush replay buffer if stream ends during replay phase (revived but no new prompt)
      if (!replayDone) flushReplayBuffer()
    } catch (err) {
      debug(`Stream read error: ${err}`)
    }
  }

  // Read stderr for diagnostics
  async function readStderr() {
    if (!proc.stderr) return
    const reader = proc.stderr.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        if (text.trim()) {
          debug(`stderr: ${text.trim()}`)
          diagLog('ERR', text.trim())
        }
      }
    } catch {
      // ignore
    }
  }

  readStream()
  readStderr()

  function writeStdin(json: Record<string, unknown>) {
    if (!proc.stdin) {
      debug('stdin not available')
      return
    }
    const line = JSON.stringify(json)
    diagLog('<<<', line)
    transcriptLog('<<<', json)
    proc.stdin.write(`${line}\n`)
    proc.stdin.flush()
  }

  return {
    proc,

    sendUserMessage(text: string, source?: string) {
      const content = source
        ? `<conduit source="${source}" ts="${new Date().toISOString()}">\n${text}\n</conduit>`
        : text
      debug(`Sending user message${source ? ` (${source})` : ''}: ${text.slice(0, 80)}...`)
      writeStdin({
        type: 'user',
        session_id: '',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      })
      // Emit user entry to the broker immediately. CC echoes stdin back
      // on stdout with isReplay:true, but we intentionally drop those
      // echoes (line ~637) to avoid duplicates in the dashboard. Without
      // this direct emit, headless sessions lose user messages on refresh
      // because the JSONL transcript watcher is disabled for headless.
      onTranscriptEntries?.(
        [{ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content } }],
        false,
      )
    },

    sendPermissionResponse(
      requestId: string,
      allow: boolean,
      updatedInput?: Record<string, unknown>,
      toolUseId?: string,
    ) {
      debug(`Permission response: ${requestId} -> ${allow ? 'allow' : 'deny'}`)
      writeStdin({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: allow
            ? { behavior: 'allow', updatedInput: updatedInput || {}, ...(toolUseId && { toolUseID: toolUseId }) }
            : { behavior: 'deny', message: 'Denied by user', ...(toolUseId && { toolUseID: toolUseId }) },
        },
      })
    },

    sendSetModel(model: string) {
      debug(`Setting model: ${model}`)
      writeStdin({
        type: 'control_request',
        request: { subtype: 'set_model', model },
      })
    },

    sendSetPermissionMode(mode: string) {
      debug(`Setting permission mode: ${mode}`)
      writeStdin({
        type: 'control_request',
        request: { subtype: 'set_permission_mode', mode },
      })
    },

    /**
     * Mutate env vars on the running CC process. CC's `update_environment_variables`
     * handler literally does `process.env[K] = V` inside its own process, so any
     * env var read lazily per-request (not cached at startup) takes effect on the
     * next turn without a respawn. Verified against Claude Code 2.1.114 binary.
     */
    sendUpdateEnv(variables: Record<string, string>) {
      const keys = Object.keys(variables)
      if (keys.length === 0) return
      debug(`Updating env: ${keys.join(', ')}`)
      writeStdin({ type: 'update_environment_variables', variables })
    },

    /**
     * Change effort level at runtime. Works by mutating CLAUDE_CODE_EFFORT_LEVEL
     * on the CC process - CC reads it lazily via `process.env.CLAUDE_CODE_EFFORT_LEVEL`
     * inside the effort resolver and the value flows onto the next request as
     * `output_config.effort` on the Anthropic API call. Accepts the five levels
     * plus `auto` / `unset` to fall back to the model default.
     */
    sendSetEffort(level: string) {
      debug(`Setting effort: ${level}`)
      writeStdin({
        type: 'update_environment_variables',
        variables: { CLAUDE_CODE_EFFORT_LEVEL: level },
      })
    },

    sendInterrupt() {
      debug('Sending interrupt')
      writeStdin({
        type: 'control_request',
        request: { subtype: 'interrupt' },
      })
    },

    forwardStdin() {
      // Forward parent process stdin to claude's stdin (for piped NDJSON input)
      if (!process.stdin.isTTY) {
        debug('Forwarding parent stdin to claude stdin')
        process.stdin.on('data', (chunk: Buffer) => {
          if (proc.stdin) {
            proc.stdin.write(chunk.toString())
            proc.stdin.flush()
          }
        })
        process.stdin.on('end', () => {
          debug('Parent stdin closed')
          // Don't close claude's stdin - dashboard may still send messages
        })
      }
    },

    kill(signal: NodeJS.Signals = 'SIGTERM') {
      proc.kill(signal)
    },

    closeStdin() {
      try {
        const stdin = proc.stdin
        if (stdin && typeof stdin !== 'number') {
          stdin.end()
          debug('[stream] CC stdin closed (EOF sent)')
          return true
        }
      } catch (e) {
        debug(`[stream] Failed to close stdin: ${e}`)
      }
      return false
    },
  }
}
