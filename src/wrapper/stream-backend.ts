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
  sessionId: string
  localServerPort: number
  concentratorUrl?: string
  concentratorSecret?: string
  cwd?: string
  env?: Record<string, string>
  onTranscriptEntries?: (entries: TranscriptEntry[], isInitial: boolean) => void
  onInit?: (init: StreamInitMessage) => void
  onResult?: (result: StreamResultMessage) => void
  onPermissionRequest?: (request: StreamPermissionRequest) => void
  onStreamEvent?: (event: Record<string, unknown>) => void
  onRateLimit?: (retryAfterMs: number, message: string) => void
  onTaskStarted?: (task: { taskId: string; toolUseId: string; taskType: string; description: string }) => void
  onSubagentEntry?: (toolUseId: string, entry: TranscriptEntry) => void
  onPlanModeChanged?: (planMode: boolean) => void
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
  sendInterrupt: () => void
  forwardStdin: () => void
  kill: (signal?: NodeJS.Signals) => void
}

/**
 * Spawn claude in stream-json mode (headless)
 */
export function spawnStreamClaude(options: StreamBackendOptions): StreamProcess {
  const {
    args,
    settingsPath,
    sessionId,
    localServerPort,
    concentratorUrl,
    concentratorSecret,
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
    onPlanModeChanged,
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
    '--include-partial-messages',
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
      RCLAUDE_SESSION_ID: sessionId,
      RCLAUDE_PORT: String(localServerPort),
      ...(concentratorUrl ? { RCLAUDE_CONCENTRATOR: concentratorUrl } : {}),
      ...(concentratorSecret ? { RCLAUDE_SECRET: concentratorSecret } : {}),
      CLAUDE_CODE_TASK_LIST_ID: sessionId,
      // No FORCE_COLOR, no TERM, no SSH_TTY - headless mode
    },
    onExit(_proc, exitCode) {
      debug(`Process exited with code ${exitCode}`)
      onExit?.(exitCode)
    },
  })

  // Diagnostic log - raw capture of everything from stdout/stderr for post-mortem analysis
  const diagDir = join(cwd || process.cwd(), '.rclaude', 'settings')
  const diagPath = join(diagDir, `headless-${sessionId}.ndjsonl`)
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

  // Replay buffer: accumulate replayed entries from --continue, flush as isInitial=true
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
            debug(`task_notification: task=${msg.task_id} status=${msg.status}`)
            // Route to subagent transcript if this task belongs to an agent
            const notifToolUseId = agentTaskToToolUse.get(msg.task_id as string)
            if (notifToolUseId && onSubagentEntry) {
              onSubagentEntry(notifToolUseId, systemEntry)
              routedToSubagent = true
            }
            break
          }
          case 'task_progress': {
            debug(`task_progress: task=${msg.task_id} tokens=${(msg.usage as Record<string, unknown>)?.total_tokens}`)
            // Route to subagent transcript if this task belongs to an agent
            const progressToolUseId = agentTaskToToolUse.get(msg.task_id as string)
            if (progressToolUseId && onSubagentEntry) {
              onSubagentEntry(progressToolUseId, systemEntry)
              routedToSubagent = true
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
            break
          case 'status': {
            const permMode = msg.permissionMode as string | undefined
            debug(`status: permissionMode=${permMode}`)
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
        const entry: TranscriptEntry = {
          type: 'assistant',
          timestamp: new Date().toISOString(),
          message: msg.message as TranscriptEntry extends { message?: infer M } ? M : never,
        } as TranscriptEntry
        if (parentToolUseId && onSubagentEntry) {
          onSubagentEntry(parentToolUseId, entry)
        } else if (!replayDone && msg.isReplay) {
          replayBuffer.push(entry)
        } else {
          if (!replayDone) flushReplayBuffer()
          onTranscriptEntries?.([entry], false)
        }
        break
      }

      case 'user': {
        const parentToolUseId = msg.parent_tool_use_id as string | null
        // Tool results echoed back, or replayed user messages
        const entry: TranscriptEntry = {
          type: 'user',
          timestamp: new Date().toISOString(),
          message: msg.message as TranscriptEntry extends { message?: infer M } ? M : never,
        } as TranscriptEntry
        // CC puts Edit diff data on tool_use_result (snake_case) - copy to toolUseResult (camelCase)
        if (msg.tool_use_result) {
          ;(entry as Record<string, unknown>).toolUseResult = msg.tool_use_result
        }
        if (parentToolUseId && onSubagentEntry) {
          onSubagentEntry(parentToolUseId, entry)
        } else if (!replayDone && msg.isReplay) {
          replayBuffer.push(entry)
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
  }
}
