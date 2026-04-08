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

function transcriptLog(direction: '>>>' | '<<<', msg: Record<string, unknown>) {
  if (!SHOW_TRANSCRIPT) return
  const type = msg.type as string
  const subtype = (msg.subtype as string) || ''

  if (SHOW_PRETTY) {
    // Pretty mode: human-readable colored output
    const arrow = direction === '>>>' ? `${C.cyan}>>>${C.reset}` : `${C.green}<<<${C.reset}`
    switch (type) {
      case 'user': {
        const content = (msg.message as Record<string, unknown>)?.content
        const text = typeof content === 'string' ? content : JSON.stringify(content)
        const label = direction === '<<<' ? `${C.green}${C.bold}YOU${C.reset}` : `${C.green}USER${C.reset}`
        process.stderr.write(`${arrow} ${label} ${C.dim}${text.slice(0, 200)}${C.reset}\n`)
        break
      }
      case 'assistant': {
        const m = msg.message as Record<string, unknown>
        const content = m?.content as Array<Record<string, unknown>> | undefined
        if (!content) break
        for (const block of content) {
          if (block.type === 'text') {
            process.stderr.write(
              `${arrow} ${C.blue}${C.bold}ASSISTANT${C.reset} ${(block.text as string).slice(0, 200)}\n`,
            )
          } else if (block.type === 'tool_use') {
            process.stderr.write(
              `${arrow} ${C.yellow}TOOL${C.reset} ${C.bold}${block.name}${C.reset} ${C.dim}${JSON.stringify(block.input).slice(0, 120)}${C.reset}\n`,
            )
          } else if (block.type === 'thinking') {
            process.stderr.write(
              `${arrow} ${C.magenta}THINK${C.reset} ${C.dim}${(block.thinking as string).slice(0, 100)}...${C.reset}\n`,
            )
          }
        }
        break
      }
      case 'system': {
        if (subtype === 'init') {
          process.stderr.write(
            `${arrow} ${C.cyan}INIT${C.reset} model=${C.bold}${msg.model}${C.reset} tools=${(msg.tools as unknown[])?.length}\n`,
          )
        } else if (subtype === 'task_started') {
          process.stderr.write(
            `${arrow} ${C.yellow}TASK${C.reset} ${msg.task_type} ${C.dim}${msg.description}${C.reset}\n`,
          )
        } else if (subtype === 'task_notification') {
          process.stderr.write(`${arrow} ${C.yellow}TASK${C.reset} ${C.dim}${msg.status}${C.reset}\n`)
        } else {
          process.stderr.write(`${arrow} ${C.gray}SYS:${subtype}${C.reset}\n`)
        }
        break
      }
      case 'result': {
        const cost = msg.total_cost_usd as number
        process.stderr.write(
          `${arrow} ${C.bold}RESULT${C.reset} ${subtype} ${C.dim}cost=$${cost?.toFixed(4)} turns=${msg.num_turns}${C.reset}\n`,
        )
        break
      }
      case 'stream_event':
        break // skip deltas in pretty mode
      case 'rate_limit_event': {
        const info = msg.rate_limit_info as Record<string, unknown>
        process.stderr.write(`${arrow} ${C.red}RATE${C.reset} ${C.dim}${info?.status}${C.reset}\n`)
        break
      }
      default:
        process.stderr.write(`${arrow} ${C.gray}${type}:${subtype}${C.reset}\n`)
    }
  } else {
    // Raw mode: plain NDJSON to stderr, no colors
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
  onTaskStarted?: (task: { taskId: string; toolUseId: string; taskType: string; description: string }) => void
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
  sendPermissionResponse: (requestId: string, allow: boolean, updatedInput?: Record<string, unknown>) => void
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
    onTaskStarted,
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
  const diagDir = join(cwd || process.cwd(), '.claude', '.rclaude')
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
        if (subtype === 'init') {
          debug(`init: session=${(msg.session_id as string)?.slice(0, 8)} model=${msg.model}`)
          onInit?.(msg as unknown as StreamInitMessage)
        } else if (subtype === 'task_started') {
          const taskType = msg.task_type as string
          const taskId = msg.task_id as string
          const toolUseId = msg.tool_use_id as string
          const description = (msg.description as string) || ''
          debug(`task_started: ${taskType} id=${taskId?.slice(0, 8)} ${description.slice(0, 40)}`)
          onTaskStarted?.({ taskId, toolUseId, taskType, description })
        }
        // Hook events (hook_started, hook_response) are informational - hooks still fire via HTTP
        break
      }

      case 'assistant': {
        const entry: TranscriptEntry = {
          type: 'assistant',
          timestamp: new Date().toISOString(),
          message: msg.message as TranscriptEntry extends { message?: infer M } ? M : never,
        } as TranscriptEntry
        onTranscriptEntries?.([entry], false)
        break
      }

      case 'user': {
        // Tool results echoed back, or replayed user messages
        const entry: TranscriptEntry = {
          type: 'user',
          timestamp: new Date().toISOString(),
          message: msg.message as TranscriptEntry extends { message?: infer M } ? M : never,
        } as TranscriptEntry
        onTranscriptEntries?.([entry], false)
        break
      }

      case 'control_request': {
        const request = msg.request as Record<string, unknown> | undefined
        if (!request) break
        const subtype = request.subtype as string
        if (subtype === 'can_use_tool') {
          const toolUse = request.tool_use as Record<string, unknown> | undefined
          debug(`Permission request: ${toolUse?.name || 'unknown'} (${request.request_id})`)
          onPermissionRequest?.({
            requestId: request.request_id as string,
            toolName: (toolUse?.name as string) || '',
            toolInput: (toolUse?.input as Record<string, unknown>) || {},
            ...request,
          })
        }
        break
      }

      case 'result': {
        debug(`Result: ${msg.subtype} cost=$${msg.total_cost_usd} turns=${msg.num_turns}`)
        onResult?.(msg as unknown as StreamResultMessage)
        break
      }

      case 'stream_event': {
        // Raw API SSE deltas - token-by-token streaming
        onStreamEvent?.(msg)
        break
      }

      case 'rate_limit_event': {
        // Informational - ignore for now
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

    sendPermissionResponse(requestId: string, allow: boolean, updatedInput?: Record<string, unknown>) {
      debug(`Permission response: ${requestId} -> ${allow ? 'allow' : 'deny'}`)
      writeStdin({
        type: 'control_response',
        response: {
          request_id: requestId,
          subtype: 'can_use_tool',
          response: allow
            ? { behavior: 'allow', updatedInput: updatedInput || {} }
            : { behavior: 'deny', message: 'Denied by user' },
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
