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
  forwardStdin: () => void
  kill: (signal?: NodeJS.Signals) => void
  // PtyProcess-compatible stubs
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  redraw: () => void
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

    // PtyProcess-compatible stub: dashboard input as plain user message
    write(data: string) {
      const trimmed = data.trim()
      if (trimmed && !trimmed.startsWith('\x1b') && trimmed !== '\r' && trimmed !== '\n') {
        this.sendUserMessage(trimmed)
      }
    },

    resize() {
      // No-op in headless mode
    },

    redraw() {
      // No-op in headless mode
    },
  }
}
