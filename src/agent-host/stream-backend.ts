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
import { type HandlerContext, handleMessage } from './stream-handlers'
import { createMonitorTracker } from './stream-monitors'
import { createReplayBuffer, flushReplayBuffer } from './stream-replay'

const SHOW_PRETTY = !!process.env.RCLAUDE_SHOW_TRANSCRIPT_PRETTY
const SHOW_TRANSCRIPT = SHOW_PRETTY || !!process.env.RCLAUDE_SHOW_TRANSCRIPT

const C = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
}

function colorizeJson(json: string): string {
  return json
    .replace(/"([^"]+)":/g, `${C.cyan}$1${C.reset}:`)
    .replace(/: "([^"]*?)"/g, `: ${C.green}$1${C.reset}`)
    .replace(/: (\d+\.?\d*)/g, `: ${C.yellow}$1${C.reset}`)
    .replace(/: (true|false|null)/g, `: ${C.magenta}$1${C.reset}`)
}

function transcriptLog(direction: '>>>' | '<<<', msg: Record<string, unknown>) {
  if (!SHOW_TRANSCRIPT) return
  const type = msg.type as string
  if (type === 'stream_event') return

  const arrow = direction === '>>>' ? `${C.cyan}>>>${C.reset}` : `${C.green}<<<${C.reset}`

  if (SHOW_PRETTY) {
    const json = JSON.stringify(msg, null, 2)
    process.stderr.write(`${arrow} ${colorizeJson(json)}\n`)
  } else {
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
    outputPath?: string
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
  closeStdin: () => boolean
}

export function spawnStreamClaude(options: StreamBackendOptions): StreamProcess {
  const { onJsonStreamLine } = options

  const proc = spawnProcess(options)
  const diagLog = initDiagLog(options.cwd, options.conversationId, proc.pid)

  const hctx: HandlerContext = {
    monitors: createMonitorTracker(),
    replay: createReplayBuffer(),
    callbacks: {
      onTranscriptEntries: options.onTranscriptEntries,
      onInit: options.onInit,
      onResult: options.onResult,
      onPermissionRequest: options.onPermissionRequest,
      onStreamEvent: options.onStreamEvent,
      onRateLimit: options.onRateLimit,
      onTaskStarted: options.onTaskStarted,
      onSubagentEntry: options.onSubagentEntry,
      onMonitorUpdate: options.onMonitorUpdate,
      onScheduledTaskFire: options.onScheduledTaskFire,
      onPlanModeChanged: options.onPlanModeChanged,
      onApiStatus: options.onApiStatus,
    },
  }

  function processLine(line: string) {
    if (!line.trim()) return
    diagLog('>>>', line)
    onJsonStreamLine?.(line)
    try {
      const msg = JSON.parse(line) as Record<string, unknown>
      transcriptLog('>>>', msg)
      handleMessage(hctx, msg)
    } catch (err) {
      debug(`Failed to parse NDJSON line: ${err}`)
      diagLog('ERR', `parse: ${err}`)
    }
  }

  readStream(proc.stdout, processLine, hctx)
  readStderr(proc.stderr, diagLog)

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

  return buildStreamProcess(proc, writeStdin, options)
}

function spawnProcess(options: StreamBackendOptions) {
  const { args, settingsPath, conversationId, localServerPort, brokerUrl, brokerSecret, cwd, env, onExit } = options

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

  return Bun.spawn(['claude', ...claudeArgs], {
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
    },
    onExit(_proc, exitCode) {
      debug(`Process exited with code ${exitCode}`)
      onExit?.(exitCode)
    },
  })
}

function initDiagLog(cwd: string | undefined, conversationId: string, pid: number): (prefix: string, line: string) => void {
  const diagDir = join(cwd || process.cwd(), '.rclaude', 'settings')
  const diagPath = join(diagDir, `headless-${conversationId}.ndjsonl`)
  try {
    mkdirSync(diagDir, { recursive: true })
    writeFileSync(diagPath, `# headless stream log - ${new Date().toISOString()}\n# pid=${pid}\n`)
    debug(`Diagnostic log: ${diagPath}`)
  } catch {
    debug('Failed to create diagnostic log')
  }

  return function diagLog(prefix: string, line: string) {
    try {
      appendFileSync(diagPath, `${prefix} ${line}\n`)
    } catch {
      // ignore write errors
    }
  }
}

async function readStream(
  stdout: ReadableStream<Uint8Array> | null,
  processLine: (line: string) => void,
  hctx: HandlerContext,
) {
  if (!stdout) return
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  let lineBuf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      lineBuf += chunk
      const lines = lineBuf.split('\n')
      lineBuf = lines.pop() || ''
      for (const line of lines) {
        processLine(line)
      }
    }
    if (lineBuf.trim()) processLine(lineBuf)
    if (!hctx.replay.done) flushReplayBuffer(hctx.replay, hctx.callbacks.onTranscriptEntries)
  } catch (err) {
    debug(`Stream read error: ${err}`)
  }
}

async function readStderr(stderr: ReadableStream<Uint8Array> | null, diagLog: (prefix: string, line: string) => void) {
  if (!stderr) return
  const reader = stderr.getReader()
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

function buildStreamProcess(
  proc: Subprocess<'pipe', 'pipe', 'pipe'>,
  writeStdin: (json: Record<string, unknown>) => void,
  options: StreamBackendOptions,
): StreamProcess {
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
      options.onTranscriptEntries?.(
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

    sendUpdateEnv(variables: Record<string, string>) {
      const keys = Object.keys(variables)
      if (keys.length === 0) return
      debug(`Updating env: ${keys.join(', ')}`)
      writeStdin({ type: 'update_environment_variables', variables })
    },

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
