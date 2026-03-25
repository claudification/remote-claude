#!/usr/bin/env bun
/**
 * rclaude - Claude Code Session Wrapper
 * Wraps claude CLI with hook injection and concentrator forwarding
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { type FSWatcher as ChokidarWatcher, watch as chokidarWatch } from 'chokidar'
import { isPathWithinCwd } from '../shared/path-guard'
import type { HookEvent, TaskInfo, TasksUpdate, TranscriptEntry } from '../shared/protocol'
import { DEFAULT_CONCENTRATOR_URL } from '../shared/protocol'
import { DEBUG, debug } from './debug'
import { FileEditor } from './file-editor'
import { startLocalServer, stopLocalServer } from './local-server'
import {
  closeMcpChannel,
  initMcpChannel,
  isMcpChannelReady,
  pushChannelMessage,
  sendPermissionResponse,
} from './mcp-channel'
import { getTerminalSize, type PtyProcess, setupTerminalPassthrough, spawnClaude } from './pty-spawn'
import { cleanupSettings, writeMergedSettings } from './settings-merge'
import { createTranscriptWatcher, type TranscriptWatcher } from './transcript-watcher'
import { createWsClient, type WsClient } from './ws-client'

/**
 * Detect Claude Code version by resolving the `claude` symlink.
 * Path layout: ~/.local/share/claude/versions/X.Y.Z
 * Falls back to `claude --version` if symlink doesn't match.
 */
function detectClaudeVersion(): string | undefined {
  try {
    const claudePath = Bun.which('claude')
    if (!claudePath) return undefined

    const resolved = realpathSync(claudePath)
    const version = basename(resolved)
    // Version segment looks like X.Y.Z (semver-ish)
    if (/^\d+\.\d+\.\d+/.test(version)) {
      debug(`Claude version from symlink: ${version}`)
      return version
    }

    // Fallback: run claude --version
    const proc = Bun.spawnSync(['claude', '--version'], { timeout: 5000 })
    const output = proc.stdout.toString().trim()
    const match = output.match(/^(\d+\.\d+\.\d+)/)
    if (match) {
      debug(`Claude version from --version: ${match[1]}`)
      return match[1]
    }
  } catch (err) {
    debug(`Failed to detect Claude version: ${err instanceof Error ? err.message : err}`)
  }
  return undefined
}

function wsToHttpUrl(url: string): string {
  return url.replace('ws://', 'http://').replace('wss://', 'https://')
}

/**
 * Check if concentrator is running
 */
async function isConcentratorReady(url: string): Promise<boolean> {
  try {
    const httpUrl = wsToHttpUrl(url)
    const healthUrl = `${httpUrl}/health`
    debug(`Health check: ${healthUrl}`)
    const start = Date.now()
    const resp = await fetch(healthUrl, {
      signal: AbortSignal.timeout(3000),
    })
    debug(`Health check: ${resp.status} in ${Date.now() - start}ms`)
    return resp.ok
  } catch (err) {
    debug(`Health check failed: ${err instanceof Error ? err.message : err}`)
    return false
  }
}

/**
 * Set terminal title via OSC 2 escape sequence (shows in tmux window name)
 * Uses last 2 path segments, max 20 chars, right segment takes priority
 */
function setTerminalTitle(cwd: string) {
  const segments = cwd.split('/').filter(Boolean)
  const last2 = segments.slice(-2)
  let title = last2.join('/')

  if (title.length > 20) {
    // Right segment is most significant - keep it, truncate left
    const right = last2[last2.length - 1]
    if (right.length >= 20) {
      title = right.slice(0, 20)
    } else if (last2.length > 1) {
      const budget = 20 - right.length - 1 // -1 for the slash
      title = budget > 0 ? `${last2[0].slice(0, budget)}/${right}` : right
    }
  }

  // Strip control characters to prevent terminal escape injection
  title = title.replace(/[\x00-\x1f\x7f]/g, '')
  if (!title) return

  process.title = title
  process.stdout.write(`\x1b]2;${title}\x07`)

  // Direct tmux rename (automatic-rename overrides OSC 2 on macOS)
  if (process.env.TMUX) {
    try {
      Bun.spawnSync(['tmux', 'rename-window', title])
      Bun.spawnSync(['tmux', 'set-option', '-w', 'automatic-rename', 'off'])
    } catch {}
  }
}

function printHelp() {
  console.log(`
rclaude - Claude Code Session Wrapper

Wraps the claude CLI with hook injection and session forwarding to a concentrator server.

USAGE:
  rclaude [OPTIONS] [CLAUDE_ARGS...]

OPTIONS:
  --concentrator <url>   Concentrator WebSocket URL (default: ${DEFAULT_CONCENTRATOR_URL})
  --rclaude-secret <s>   Shared secret for concentrator auth (or RCLAUDE_SECRET env)
  --no-concentrator      Run without forwarding to concentrator
  --no-terminal          Disable remote terminal capability
  --no-channels          Disable MCP channel (channels are ON by default)
  --channels             Enable MCP channel (already default, for explicitness)
  --rclaude-help         Show this help message

ENVIRONMENT:
  RCLAUDE_SECRET         Shared secret for concentrator auth
  RCLAUDE_CONCENTRATOR   Concentrator WebSocket URL
  RCLAUDE_CHANNELS=0     Disable MCP channel (enabled by default)
  RCLAUDE_DEBUG=1        Enable debug logging to /tmp/rclaude-debug.log

All other arguments are passed through to claude.

EXAMPLES:
  rclaude                           # Start interactive session
  rclaude --resume                  # Resume previous session
  rclaude -p "build X"              # Non-interactive prompt
  rclaude --help                    # Show claude's help
  rclaude --no-concentrator         # Run without concentrator
  rclaude --concentrator ws://myserver:9999
`)
}

function extToMediaType(ext: string): string {
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    avif: 'image/avif',
  }
  return map[ext] || 'application/octet-stream'
}

async function main() {
  // Parse our specific args, pass the rest to claude
  const args = process.argv.slice(2)

  let concentratorUrl = process.env.RCLAUDE_CONCENTRATOR || DEFAULT_CONCENTRATOR_URL
  let concentratorSecret = process.env.RCLAUDE_SECRET
  let noConcentrator = false
  let noTerminal = false
  let channelEnabled = process.env.RCLAUDE_CHANNELS !== '0'
  const claudeArgs: string[] = []

  debug(`Concentrator URL: ${concentratorUrl} (source: ${process.env.RCLAUDE_CONCENTRATOR ? 'env' : 'default'})`)
  debug(`Concentrator secret: ${concentratorSecret ? 'set' : 'NOT SET'}`)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--rclaude-help') {
      printHelp()
      process.exit(0)
    } else if (arg === '--concentrator') {
      concentratorUrl = args[++i] || DEFAULT_CONCENTRATOR_URL
    } else if (arg === '--rclaude-secret') {
      concentratorSecret = args[++i]
    } else if (arg === '--no-concentrator') {
      noConcentrator = true
    } else if (arg === '--no-terminal') {
      noTerminal = true
    } else if (arg === '--channels') {
      channelEnabled = true
    } else if (arg === '--no-channels') {
      channelEnabled = false
    } else {
      claudeArgs.push(arg)
    }
  }

  // Check if concentrator is reachable (unless --no-concentrator)
  if (!noConcentrator && !(await isConcentratorReady(concentratorUrl))) {
    debug('Concentrator not reachable - running without it')
    noConcentrator = true
  }
  debug(`Concentrator: ${noConcentrator ? 'DISABLED' : 'ENABLED'} (url: ${concentratorUrl})`)

  // Unique wrapper identity - use pre-assigned ID from revive flow if available
  const internalId = process.env.RCLAUDE_WRAPPER_ID || randomUUID()
  const cwd = process.cwd()

  // Will be set when we receive SessionStart from Claude
  let claudeSessionId: string | null = null
  let wsClient: WsClient | null = null
  let ptyProcess: PtyProcess | null = null
  let terminalAttached = false
  let fileEditor: FileEditor | null = null
  let savedTerminalSize: { cols: number; rows: number } | null = null
  let taskWatcher: ChokidarWatcher | null = null
  let lastTasksJson = ''
  let transcriptWatcher: TranscriptWatcher | null = null
  let parentTranscriptPath: string | null = null // stored to derive subagent transcript paths
  const subagentWatchers = new Map<string, TranscriptWatcher>()
  const bgTaskOutputWatchers = new Map<string, { stop: () => void }>()

  // Detect Claude Code version early - needed for settings merge and concentrator
  const claudeVersion = detectClaudeVersion()

  // Queue events until we have the real session ID
  const eventQueue: HookEvent[] = []

  // Diagnostic log - sends structured debug entries to concentrator
  const diagBuffer: Array<{ t: number; type: string; msg: string; args?: unknown }> = []
  let diagFlushTimer: ReturnType<typeof setTimeout> | null = null

  function flushDiag() {
    diagFlushTimer = null
    if (diagBuffer.length === 0) return
    if (!wsClient?.isConnected() || !claudeSessionId) return
    const entries = diagBuffer.splice(0)
    wsClient.send({ type: 'diag', sessionId: claudeSessionId, entries } as any)
  }

  function diag(type: string, msg: string, args?: unknown) {
    debug(`[diag] ${type}: ${msg}${args ? ` ${JSON.stringify(args)}` : ''}`)
    diagBuffer.push({ t: Date.now(), type, msg, args })
    if (!diagFlushTimer) {
      diagFlushTimer = setTimeout(flushDiag, 500)
    }
  }

  /**
   * Read and send current task state.
   * Called by chokidar watcher on changes and on reconnect.
   */
  let taskCandidateDirs: string[] = []

  function readAndSendTasks() {
    if (!wsClient?.isConnected() || !claudeSessionId) {
      debug(
        `readAndSendTasks: skipped (connected=${wsClient?.isConnected()}, sessionId=${claudeSessionId?.slice(0, 8)})`,
      )
      return
    }
    try {
      // Read tasks from ALL candidate dirs - pick the one with actual .json files
      let tasksDir: string | null = null
      for (const dir of taskCandidateDirs) {
        if (!existsSync(dir)) continue
        const jsonFiles = readdirSync(dir).filter(f => f.endsWith('.json'))
        if (jsonFiles.length > 0) {
          tasksDir = dir
          break
        }
      }

      const files = tasksDir
        ? readdirSync(tasksDir)
            .filter(f => f.endsWith('.json'))
            .sort()
        : []

      const tasks: TaskInfo[] = []
      for (const file of files) {
        try {
          const raw = readFileSync(join(tasksDir!, file), 'utf-8')
          const task = JSON.parse(raw)
          tasks.push({
            id: String(task.id || ''),
            subject: String(task.subject || ''),
            description: task.description ? String(task.description) : undefined,
            status: task.status || 'pending',
            blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : undefined,
            blocks: Array.isArray(task.blocks) ? task.blocks.map(String) : undefined,
            owner: task.owner ? String(task.owner) : undefined,
            updatedAt: task.updatedAt || Date.now(),
          })
        } catch {
          // Skip malformed task files
        }
      }

      const json = JSON.stringify(tasks)
      if (json !== lastTasksJson) {
        lastTasksJson = json
        const msg: TasksUpdate = { type: 'tasks_update', sessionId: claudeSessionId, tasks }
        wsClient?.send(msg)
        debug(`Tasks updated: ${tasks.length} tasks (dir: ${tasksDir?.split('/').pop()?.slice(0, 8)})`)
        diag('tasks', `Sent ${tasks.length} tasks`, { dir: tasksDir?.split('/').pop() })
      }
    } catch (err) {
      debug(`readAndSendTasks error: ${err}`)
      diag('tasks', `Read error: ${err}`, { dirs: taskCandidateDirs.map(d => d.split('/').pop()) })
    }
  }

  /**
   * Watch ~/.claude/tasks/ for task state changes using chokidar
   */
  function startTaskWatching() {
    if (taskWatcher) return
    const tasksBase = join(homedir(), '.claude', 'tasks')
    // Watch both Claude's session ID dir and our internal ID dir (they may differ)
    const candidates = new Set<string>()
    if (claudeSessionId) candidates.add(join(tasksBase, claudeSessionId))
    candidates.add(join(tasksBase, internalId))
    taskCandidateDirs = Array.from(candidates)

    const watchPaths = taskCandidateDirs.map(d => join(d, '*.json'))
    debug(`Task watcher dirs: ${taskCandidateDirs.map(d => d.split('/').pop()).join(', ')}`)
    taskWatcher = chokidarWatch(watchPaths, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    })
    taskWatcher.on('add', readAndSendTasks)
    taskWatcher.on('change', readAndSendTasks)
    taskWatcher.on('unlink', readAndSendTasks)
    // Also poll periodically in case chokidar misses events (e.g. dir created after watcher)
    const pollInterval = setInterval(() => readAndSendTasks(), 5000)
    taskWatcher.on('close', () => clearInterval(pollInterval))
    diag('watch', 'Task watcher started', { dirs: taskCandidateDirs.map(d => d.split('/').pop()), watchPaths })
  }

  function connectToConcentrator(sessionId: string) {
    if (noConcentrator || wsClient) return

    // Build capabilities list
    const capabilities = [
      ...(!noTerminal ? ['terminal' as const] : []),
      ...(channelEnabled ? ['channel' as const] : []),
    ]

    wsClient = createWsClient({
      concentratorUrl,
      concentratorSecret,
      sessionId,
      wrapperId: internalId,
      cwd,
      args: claudeArgs,
      claudeVersion,
      capabilities,
      onConnected() {
        diag('ws', 'Connected to concentrator', { sessionId })
        // Flush buffered diag entries
        flushDiag()
        // Flush queued events
        for (const event of eventQueue) {
          wsClient?.sendHookEvent({ ...event, sessionId })
        }
        eventQueue.length = 0
        // Start polling task files
        startTaskWatching()
        // Re-send transcript on reconnect (concentrator may have restarted)
        if (transcriptWatcher) {
          debug('Re-sending transcript on reconnect')
          transcriptWatcher.resend().catch(err => debug(`Resend failed: ${err}`))
        }
        // Re-send tasks immediately
        lastTasksJson = ''
        readAndSendTasks()
      },
      onDisconnected() {
        debug('Disconnected from concentrator')
      },
      onError(error) {
        debug(`Concentrator error: ${error.message}`)
      },
      onInput(input, crDelay) {
        if (!ptyProcess) return

        // Slash commands (/compact, /clear, /model, etc.) must go via PTY -
        // they're processed by Claude Code's CLI input layer, not the model.
        // Channel messages bypass the CLI and go straight to model context.
        const isSlashCommand = input.trimStart().startsWith('/')

        // Channel mode: push through MCP instead of PTY injection
        if (channelEnabled && isMcpChannelReady() && !isSlashCommand) {
          pushChannelMessage(input).then(sent => {
            if (sent) {
              diag('channel', `Input via MCP (${input.length} chars)`)
            } else {
              diag('channel', 'MCP push failed, falling back to PTY')
              if (ptyProcess) {
                const trimmed = input.replace(/[\r\n]+$/, '')
                ptyProcess.write(trimmed)
                setTimeout(() => ptyProcess?.write('\r'), 150)
              }
            }
          })
          return
        }

        const trimmed = input.replace(/[\r\n]+$/, '')
        const lines = trimmed.split('\n')

        // Default delays (used when no crDelay from dashboard)
        const singleCrDelay = crDelay ?? 150
        const singlePreDelay = crDelay != null ? Math.max(50, crDelay / 2) : 100
        const multiSettleBase = crDelay ?? 250

        if (lines.length === 1) {
          // Single line: write + Enter
          ptyProcess.write(trimmed)
          setTimeout(() => {
            ptyProcess?.write('\r')
            setTimeout(() => ptyProcess?.write('\r'), singleCrDelay)
          }, singlePreDelay)
        } else {
          // Multiline: chunk line-by-line inside bracketed paste, then submit
          // Delays scale with input size so large pastes don't outrun the PTY
          const perLineDelay = Math.min(50, Math.max(20, lines.length > 50 ? 50 : 20))
          ptyProcess.write('\x1b[200~')
          lines.forEach((line, i) => {
            setTimeout(() => {
              if (!ptyProcess) return
              ptyProcess.write(i > 0 ? `\n${line}` : line)
              if (i === lines.length - 1) {
                // End bracketed paste, then wait for PTY to process before sending Enter
                const settleDelay = crDelay != null ? crDelay : Math.min(500, Math.max(100, lines.length * 2))
                setTimeout(() => {
                  ptyProcess?.write('\x1b[201~')
                  setTimeout(() => {
                    ptyProcess?.write('\r')
                    setTimeout(() => ptyProcess?.write('\r'), multiSettleBase)
                  }, settleDelay)
                }, 50)
              }
            }, i * perLineDelay)
          })
        }
        debug(
          `Sent to PTY: ${lines.length} lines, ${trimmed.length} chars${crDelay != null ? ` (crDelay=${crDelay}ms)` : ''}`,
        )
      },
      onTerminalInput(data) {
        // Raw keystrokes from browser terminal - write directly to PTY
        if (ptyProcess) {
          ptyProcess.write(data)
        }
      },
      onTerminalAttach(cols, rows) {
        terminalAttached = true
        // Save local terminal size before remote viewer takes over
        savedTerminalSize = getTerminalSize()
        debug(
          `Terminal attached (${cols}x${rows}), saved local size (${savedTerminalSize.cols}x${savedTerminalSize.rows})`,
        )
        if (ptyProcess) {
          // Resize triggers SIGWINCH internally, which repaints most apps.
          // Double-tap: resize to 1 col smaller first, then to actual size.
          // This guarantees a size change even if browser matches current PTY size,
          // forcing a full repaint from Claude Code / Ink / vim / etc.
          ptyProcess.resize(Math.max(1, cols - 1), rows)
          setTimeout(() => {
            ptyProcess?.resize(cols, rows)
            // Extra SIGWINCH as fallback for apps that ignore resize
            setTimeout(() => ptyProcess?.redraw(), 100)
          }, 50)
        }
      },
      onTerminalDetach() {
        terminalAttached = false
        // Restore local terminal size
        if (savedTerminalSize && ptyProcess) {
          ptyProcess.resize(savedTerminalSize.cols, savedTerminalSize.rows)
          debug(`Terminal detached, restored to ${savedTerminalSize.cols}x${savedTerminalSize.rows}`)
          savedTerminalSize = null
        } else {
          debug('Terminal detached')
        }
      },
      onTerminalResize(cols, rows) {
        if (ptyProcess) {
          ptyProcess.resize(cols, rows)
        }
        debug(`Terminal resized to ${cols}x${rows}`)
      },
      onFileRequest(requestId, path) {
        // Read file from local filesystem and respond
        readFile(path)
          .then(buf => {
            const ext = path.split('.').pop()?.toLowerCase() || ''
            const mediaType = extToMediaType(ext)
            wsClient?.sendFileResponse(requestId, buf.toString('base64'), mediaType)
            debug(`File response: ${path} (${buf.length} bytes)`)
          })
          .catch(err => {
            wsClient?.sendFileResponse(requestId, undefined, undefined, String(err))
            debug(`File request failed: ${path} - ${err}`)
          })
      },
      onFileEditorMessage(msg) {
        handleFileEditorMessage(msg)
      },
      onTranscriptKick() {
        // Concentrator detected we have events but no transcript - retry the watcher
        if (!transcriptWatcher && parentTranscriptPath) {
          debug(`Transcript kick received - retrying watcher for: ${parentTranscriptPath}`)
          diag('info', 'Transcript kick - retrying watcher', { path: parentTranscriptPath })
          // Re-run the same retry logic with a fresh 15min timeout
          async function retryTranscriptWatcher(path: string) {
            let delay = 500
            const maxDelay = 10_000
            const maxTotal = 900_000
            let elapsed = 0
            while (elapsed < maxTotal) {
              if (existsSync(path)) {
                debug(`Transcript file found after kick: ${path}`)
                startTranscriptWatcher(path)
                return
              }
              await new Promise(r => setTimeout(r, delay))
              elapsed += delay
              delay = Math.min(delay * 2, maxDelay)
            }
            diag('error', 'Transcript file still not found after kick', { path })
          }
          retryTranscriptWatcher(parentTranscriptPath)
        } else if (transcriptWatcher) {
          debug('Transcript kick received but watcher already running')
        } else {
          debug('Transcript kick received but no transcript path known')
        }
      },
      onChannelSessionsList(sessions) {
        pendingListSessions?.(sessions)
      },
      onChannelSendResult(result) {
        pendingSendResult?.(result)
      },
      onChannelDeliver(delivery) {
        if (channelEnabled && isMcpChannelReady()) {
          const meta: Record<string, string> = {
            sender: 'session',
            from_session: delivery.fromSession,
            from_project: delivery.fromProject,
            intent: delivery.intent,
          }
          if (delivery.conversationId) meta.conversation_id = delivery.conversationId
          if (delivery.context) meta.context = delivery.context
          pushChannelMessage(delivery.message, meta)
          diag('channel', `Received from ${delivery.fromProject}: ${delivery.message.slice(0, 60)}`)
        }
      },
      onChannelLinkRequest() {
        // Link requests are handled by the dashboard UI, not by Claude
      },
      onPermissionResponse(requestId: string, behavior: 'allow' | 'deny') {
        if (channelEnabled && isMcpChannelReady()) {
          sendPermissionResponse(requestId, behavior)
          diag('channel', `Permission response: ${requestId} -> ${behavior}`)
        }
      },
    })
  }

  function ensureFileEditor(): FileEditor {
    if (!fileEditor) {
      fileEditor = new FileEditor(cwd, claudeSessionId || internalId)
    }
    return fileEditor
  }

  function handleFileEditorMessage(msg: Record<string, unknown>) {
    const type = msg.type as string
    const requestId = msg.requestId as string | undefined
    const sessionId = msg.sessionId as string | undefined
    const editor = ensureFileEditor()

    function respond(responseType: string, data: Record<string, unknown>) {
      wsClient?.send({ type: responseType, requestId, sessionId, ...data } as any)
    }

    function respondError(responseType: string, err: unknown) {
      respond(responseType, { error: String(err) })
    }

    // Path traversal guard: reject paths outside the session CWD
    if (msg.path && !isPathWithinCwd(msg.path as string, cwd)) {
      const errorType = type.replace('_request', '_response').replace('_save', '_save_response')
      respond(errorType, { error: `Path outside session directory: ${msg.path}` })
      return
    }

    switch (type) {
      case 'file_list_request':
        editor
          .listFiles()
          .then(files => respond('file_list_response', { files }))
          .catch(err => respondError('file_list_response', err))
        break
      case 'file_content_request':
        editor
          .readFile(msg.path as string)
          .then(result => respond('file_content_response', { content: result.content, version: result.version }))
          .catch(err => respondError('file_content_response', err))
        break
      case 'file_save':
        editor
          .saveFile({
            path: msg.path as string,
            content: msg.content as string,
            diff: (msg.diff as string) || '',
            baseVersion: (msg.baseVersion as number) || 0,
          })
          .then(result => respond('file_save_response', { ...result }))
          .catch(err => respondError('file_save_response', err))
        break
      case 'file_watch':
        editor.watchFile(msg.path as string, event => {
          wsClient?.send({ type: 'file_changed', sessionId, ...event } as any)
        })
        break
      case 'file_unwatch':
        editor.unwatchFile(msg.path as string)
        break
      case 'file_history_request':
        try {
          const versions = editor.getHistory(msg.path as string)
          respond('file_history_response', { versions })
        } catch (err) {
          respondError('file_history_response', err)
        }
        break
      case 'file_restore':
        editor
          .restoreVersion(msg.path as string, msg.version as number)
          .then(async result => {
            const read = await editor.readFile(msg.path as string)
            respond('file_restore_response', { version: result.version, content: read.content })
          })
          .catch(err => respondError('file_restore_response', err))
        break
      case 'quick_note_append':
        editor
          .appendNote(msg.text as string)
          .then(result => respond('quick_note_response', { version: result.version }))
          .catch(err => respondError('quick_note_response', err))
        break
    }
    debug(`File editor: ${type}${msg.path ? ` path=${msg.path}` : ''}`)
  }

  const TRANSCRIPT_CHUNK_SIZE = 200

  function sendTranscriptEntriesChunked(entries: TranscriptEntry[], isInitial: boolean, agentId?: string) {
    if (!claudeSessionId || !wsClient?.isConnected()) {
      debug(`Cannot send ${entries.length} entries: sessionId=${!!claudeSessionId} ws=${wsClient?.isConnected()}`)
      return
    }
    const send = (chunk: TranscriptEntry[], initial: boolean) =>
      agentId
        ? wsClient!.sendSubagentTranscript(agentId, chunk, initial)
        : wsClient!.sendTranscriptEntries(chunk, initial)

    if (entries.length <= TRANSCRIPT_CHUNK_SIZE) {
      send(entries, isInitial)
      return
    }
    for (let i = 0; i < entries.length; i += TRANSCRIPT_CHUNK_SIZE) {
      send(entries.slice(i, i + TRANSCRIPT_CHUNK_SIZE), isInitial && i === 0)
    }
  }

  // Watch a background task .output file and stream chunks to concentrator
  function startBgTaskOutputWatcher(taskId: string, outputPath: string) {
    if (bgTaskOutputWatchers.has(taskId)) return
    diag('bgout', `Watching output for bg task ${taskId}`, { taskId, outputPath })

    let offset = 0
    let totalBytes = 0
    let stopped = false
    let retries = 0
    const MAX_RETRIES = 20 // 20 x 500ms = 10s max wait for file to appear

    async function readChunk() {
      if (stopped || !wsClient?.isConnected()) return
      try {
        const file = Bun.file(outputPath)
        const size = file.size
        if (size > offset) {
          const slice = file.slice(offset, size)
          const text = await slice.text()
          offset = size
          totalBytes += text.length
          if (text) {
            wsClient!.sendBgTaskOutput(taskId, text, false)
          }
        }
      } catch {
        // File might not exist yet
        if (retries++ < MAX_RETRIES) return // will retry on next poll
        diag('bgout', `Gave up waiting for output file`, { taskId, retries: MAX_RETRIES })
        stopWatcher()
      }
    }

    // Poll every 500ms - simple and reliable for output files
    const interval = setInterval(readChunk, 500)

    function stopWatcher() {
      if (stopped) return
      stopped = true
      clearInterval(interval)
      bgTaskOutputWatchers.delete(taskId)
      // Do a final read to catch any remaining output
      readChunk().then(() => {
        if (wsClient?.isConnected()) {
          wsClient.sendBgTaskOutput(taskId, '', true)
        }
        diag('bgout', `Watcher stopped`, { taskId, totalBytes })
      })
    }

    bgTaskOutputWatchers.set(taskId, { stop: stopWatcher })
  }

  function extractEntryText(entry: TranscriptEntry): string {
    const content = (entry as any).message?.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .filter((c: any) => typeof c === 'string' || c?.type === 'text')
      .map((c: any) => (typeof c === 'string' ? c : c.text))
      .join('')
  }

  // Scan transcript entries for background task IDs and start output watchers
  function scanForBgTasks(entries: TranscriptEntry[]) {
    for (const entry of entries) {
      const tur = (entry as any).toolUseResult
      if (!tur?.backgroundTaskId) continue
      const taskId = tur.backgroundTaskId as string
      if (bgTaskOutputWatchers.has(taskId)) continue

      const text = extractEntryText(entry)
      const pathMatch = text.match(/Output is being written to: (\S+\.output)/)
      if (pathMatch) {
        startBgTaskOutputWatcher(taskId, pathMatch[1])
      } else {
        debug(`[bgout] Found backgroundTaskId ${taskId} but no output path in content`)
      }
    }

    // Also check for task completions to stop watchers
    for (const entry of entries) {
      const text = extractEntryText(entry)
      if (!text.includes('<task-notification>')) continue
      const re = /<task-id>([^<]+)<\/task-id>/g
      let match: RegExpExecArray | null
      while ((match = re.exec(text)) !== null) {
        const watcher = bgTaskOutputWatchers.get(match[1])
        if (watcher) {
          diag('bgout', `Task completed, stopping watcher`, { taskId: match[1] })
          watcher.stop()
        }
      }
    }
  }

  function startTranscriptWatcher(transcriptPath: string) {
    if (transcriptWatcher) {
      debug(`Transcript watcher already running, skipping`)
      return
    }

    transcriptWatcher = createTranscriptWatcher({
      debug: DEBUG ? (msg: string) => debug(`[tw] ${msg}`) : undefined,
      onEntries(entries, isInitial) {
        sendTranscriptEntriesChunked(entries, isInitial)
        // Scan for background tasks to watch their output files
        scanForBgTasks(entries)
      },
      onNewFile(filename) {
        diag('watch', 'New transcript file detected', { filename })
      },
      onError(err) {
        debug(`Transcript watcher error: ${err.message}`)
      },
    })

    transcriptWatcher
      .start(transcriptPath)
      .then(() => {
        diag('watch', 'Transcript watcher started', transcriptPath)
      })
      .catch(err => {
        diag('error', 'Transcript watcher failed to start', { path: transcriptPath, error: String(err) })
      })
  }

  function startSubagentWatcher(agentId: string, transcriptPath: string, live: boolean) {
    if (subagentWatchers.has(agentId)) return

    const watcher = createTranscriptWatcher({
      debug: DEBUG ? (msg: string) => debug(`[tw:${agentId.slice(0, 7)}] ${msg}`) : undefined,
      onEntries(entries, isInitial) {
        if (claudeSessionId && wsClient?.isConnected()) {
          sendTranscriptEntriesChunked(entries, isInitial, agentId)
          debug(`Sent ${entries.length} subagent transcript entries for ${agentId.slice(0, 7)} (live=${live})`)
        }
      },
      onError(err) {
        debug(`Subagent watcher error (${agentId.slice(0, 7)}): ${err.message}`)
      },
    })

    subagentWatchers.set(agentId, watcher)
    watcher
      .start(transcriptPath)
      .then(() => {
        if (!live) {
          // Non-live (SubagentStop): file is complete, read once and close
          watcher.stop()
          subagentWatchers.delete(agentId)
          debug(`Subagent transcript read complete, watcher closed: ${agentId.slice(0, 7)}`)
        }
        // Live mode: keep watching via chokidar for new entries
      })
      .catch(err => {
        debug(`Failed to start subagent watcher: ${err}`)
      })
    debug(`${live ? 'Live watching' : 'Reading'} subagent transcript: ${agentId.slice(0, 7)}`)
  }

  function stopSubagentWatcher(agentId: string) {
    const watcher = subagentWatchers.get(agentId)
    if (watcher) {
      watcher.stop()
      subagentWatchers.delete(agentId)
      debug(`Stopped live subagent watcher: ${agentId.slice(0, 7)}`)
    }
  }

  let devChannelConfirmed = false

  // Initialize MCP channel if enabled
  if (channelEnabled) {
    diag('channel', 'Channel mode enabled')
    initMcpChannel({
      onNotify(message, title) {
        diag('channel', `Notify: ${title ? `[${title}] ` : ''}${message.slice(0, 80)}`)
        if (wsClient?.isConnected()) {
          wsClient.send({ type: 'notify', sessionId: claudeSessionId || internalId, message, title })
        }
      },
      async onShareFile(filePath) {
        // Upload file to concentrator blob store, get public URL back
        // SECURITY: restrict to files within the session CWD
        if (!isPathWithinCwd(filePath, cwd)) {
          debug(`[channel] share_file: path outside CWD: ${filePath}`)
          return null
        }
        const httpUrl = noConcentrator ? null : wsToHttpUrl(concentratorUrl)
        if (!httpUrl) return null
        try {
          const file = Bun.file(filePath)
          if (!(await file.exists())) {
            debug(`[channel] share_file: file not found: ${filePath}`)
            return null
          }
          const res = await fetch(`${httpUrl}/api/files`, {
            method: 'POST',
            headers: {
              'Content-Type': file.type || 'application/octet-stream',
              ...(concentratorSecret ? { Authorization: `Bearer ${concentratorSecret}` } : {}),
            },
            body: file,
          })
          if (!res.ok) {
            debug(`[channel] share_file: upload failed: ${res.status}`)
            return null
          }
          const data = (await res.json()) as { url?: string }
          diag('channel', `Shared: ${filePath} -> ${data.url}`)
          return data.url || null
        } catch (err) {
          debug(`[channel] share_file error: ${err instanceof Error ? err.message : err}`)
          return null
        }
      },
      async onListSessions(status) {
        if (!wsClient?.isConnected()) return []
        return new Promise(resolve => {
          const timeout = setTimeout(() => resolve([]), 5000)
          pendingListSessions = sessions => {
            clearTimeout(timeout)
            pendingListSessions = null
            resolve(sessions)
          }
          wsClient!.send({ type: 'channel_list_sessions', status } as any)
        })
      },
      async onSendMessage(to, intent, message, context, conversationId) {
        if (!wsClient?.isConnected()) return { ok: false, error: 'Not connected' }
        return new Promise(resolve => {
          const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 10000)
          pendingSendResult = result => {
            clearTimeout(timeout)
            pendingSendResult = null
            resolve(result)
          }
          wsClient!.send({
            type: 'channel_send',
            fromSession: claudeSessionId || internalId,
            toSession: to,
            intent,
            message,
            context,
            conversationId,
          } as any)
        })
      },
      onPermissionRequest(data) {
        diag('channel', `Permission request: ${data.requestId} ${data.toolName}`)
        if (wsClient?.isConnected()) {
          wsClient.send({
            type: 'permission_request',
            sessionId: claudeSessionId || internalId,
            requestId: data.requestId,
            toolName: data.toolName,
            description: data.description,
            inputPreview: data.inputPreview,
          })
        }
      },
      onDisconnect() {
        diag('channel', 'Channel disconnected')
      },
    })
  }

  // Pending callbacks for inter-session request/response
  let pendingListSessions: ((sessions: any[]) => void) | null = null
  let pendingSendResult: ((result: any) => void) | null = null

  // Start local HTTP server for hook callbacks (+ MCP endpoint when channels enabled)
  const { server: localServer, port: localServerPort } = await startLocalServer({
    sessionId: internalId,
    channelEnabled,
    onHookEvent(event: HookEvent) {
      // Extract Claude's real session ID from SessionStart
      if (event.hookEvent === 'SessionStart' && event.data) {
        const data = event.data as Record<string, unknown>
        debug(
          `SessionStart data keys: ${Object.keys(data).join(', ')} | source=${data.source} | session_id=${String(data.session_id).slice(0, 8)}`,
        )
        if (data.session_id && typeof data.session_id === 'string') {
          const newSessionId = data.session_id
          const sessionChanged = claudeSessionId !== newSessionId
          const prevSessionId = claudeSessionId
          claudeSessionId = newSessionId
          diag('session', sessionChanged ? 'Session ID changed' : 'Session ID confirmed', {
            sessionId: claudeSessionId,
            prev: sessionChanged ? prevSessionId : undefined,
            internalId,
          })

          // Connect (or re-key) to concentrator with the correct session ID
          if (!wsClient) {
            connectToConcentrator(claudeSessionId)
          } else if (sessionChanged) {
            // Session ID changed (e.g. /clear, /resume) - re-key on same connection
            debug(`Session ID changed, sending session_clear to concentrator`)
            const newModel = typeof data.model === 'string' ? data.model : undefined
            wsClient.sendSessionClear(claudeSessionId, cwd, newModel)

            // Clean up all subagent watchers from old session
            for (const [agentId, watcher] of subagentWatchers) {
              debug(`Stopping orphaned subagent watcher: ${agentId.slice(0, 7)}`)
              watcher.stop()
            }
            subagentWatchers.clear()

            // Reset task watcher for new session directory
            lastTasksJson = ''
            if (taskWatcher) {
              taskWatcher.close()
              taskWatcher = null
            }
            startTaskWatching()
          }

          // Start/restart transcript watcher if path is available and session changed
          if (data.transcript_path && typeof data.transcript_path === 'string') {
            const transcriptPath = data.transcript_path
            parentTranscriptPath = transcriptPath
            // Start watcher if transcript file exists, or retry until it does
            // Brand new projects can take 60-90s before Claude creates the JSONL file.
            // Use exponential backoff: 500ms, 1s, 2s, 4s... capped at 10s, ~2.5 min total
            async function tryStartTranscriptWatcher(path: string) {
              let delay = 500
              const maxDelay = 10_000
              const maxTotal = 900_000 // 15 minutes total (slow-starting sessions can take 6+ min)
              let elapsed = 0
              let attempt = 0
              while (elapsed < maxTotal) {
                if (existsSync(path)) {
                  if (sessionChanged || !transcriptWatcher) {
                    if (transcriptWatcher) {
                      debug(`Stopping old transcript watcher (session changed)`)
                      transcriptWatcher.stop()
                      transcriptWatcher = null
                    }
                    debug(`Starting transcript watcher: ${path}`)
                    startTranscriptWatcher(path)
                  } else {
                    debug(`Transcript watcher already running for correct session`)
                  }
                  return
                }
                attempt++
                debug(
                  `Transcript file not found (attempt ${attempt}, ${(elapsed / 1000).toFixed(1)}s elapsed), retrying in ${delay}ms: ${path}`,
                )
                await new Promise(r => setTimeout(r, delay))
                elapsed += delay
                delay = Math.min(delay * 2, maxDelay)
              }
              diag('error', 'Transcript file never appeared', {
                path,
                elapsed: `${(elapsed / 1000).toFixed(0)}s`,
                attempts: attempt,
              })
            }
            tryStartTranscriptWatcher(transcriptPath)
          } else {
            debug(`WARNING: No transcript_path in SessionStart data!`)
          }
        }
      }

      // Start live watching subagent transcripts at SubagentStart
      if (event.hookEvent === 'SubagentStart' && event.data) {
        const data = event.data as Record<string, unknown>
        const agentId = String(data.agent_id || '')
        if (agentId && parentTranscriptPath) {
          // Derive subagent transcript path: {sessionDir}/subagents/agent-{agentId}.jsonl
          const sessionDir = parentTranscriptPath.replace(/\.jsonl$/, '')
          const agentTranscriptPath = join(sessionDir, 'subagents', `agent-${agentId}.jsonl`)
          if (existsSync(agentTranscriptPath)) {
            startSubagentWatcher(agentId, agentTranscriptPath, true)
          } else {
            debug(`SubagentStart: transcript file not yet created: ${agentTranscriptPath}`)
            // Retry after a short delay (file may be created slightly after hook fires)
            setTimeout(() => {
              if (existsSync(agentTranscriptPath) && !subagentWatchers.has(agentId)) {
                startSubagentWatcher(agentId, agentTranscriptPath, true)
              }
            }, 500)
          }
        }
      }

      // Stop live watcher and do final read at SubagentStop
      if (event.hookEvent === 'SubagentStop' && event.data) {
        const data = event.data as Record<string, unknown>
        const agentId = String(data.agent_id || '')
        const transcriptPath = typeof data.agent_transcript_path === 'string' ? data.agent_transcript_path : undefined
        debug(`SubagentStop: agent=${agentId.slice(0, 7)} transcript=${transcriptPath || 'NONE'}`)
        // Stop live watcher first
        stopSubagentWatcher(agentId)
        // Then do a final read of the complete transcript
        if (agentId && transcriptPath) {
          startSubagentWatcher(agentId, transcriptPath, false)
        }
      }

      // Forward to concentrator, or queue until session ID + WS are ready
      if (claudeSessionId && wsClient?.isConnected()) {
        wsClient.sendHookEvent({ ...event, sessionId: claudeSessionId })
      } else {
        eventQueue.push(event)
      }

      debug(`Hook: ${event.hookEvent}`)
    },
    onNotify(message: string, title?: string) {
      const sessionId = claudeSessionId || internalId
      debug(`Notify: ${title ? `[${title}] ` : ''}${message}`)
      if (wsClient?.isConnected()) {
        wsClient.send({ type: 'notify', sessionId, message, title })
      }
    },
  })

  // Generate merged settings with hook injection
  // Generate merged settings with hook injection (version-aware to avoid invalid keys)
  const settingsPath = await writeMergedSettings(internalId, localServerPort, claudeVersion)

  // Set terminal title to last 2 path segments (shows in tmux)
  setTerminalTitle(cwd)

  // Write system prompt additions for rclaude-specific behavior
  const promptDir = join(homedir(), '.rclaude', 'prompts')
  mkdirSync(promptDir, { recursive: true })
  const promptFile = join(promptDir, `${internalId}.txt`)
  writeFileSync(
    promptFile,
    [
      '# Attached Files (rclaude)',
      '',
      'When the user sends a message containing markdown image or file links like `![filename](https://...)` or `[filename](https://...)`,',
      'these are files attached via the remote dashboard. Handle them based on file type:',
      '',
      '- **Images** (.png, .jpg, .jpeg, .gif, .webp, .svg): Download with `curl -sL "<url>" -o /tmp/<filename>`, then use the Read tool to view the downloaded file.',
      '- **Text/code files** (.txt, .md, .json, .csv, .xml, .yaml, .yml, .toml, .ts, .js, .py, etc.): Use `curl -sL "<url>"` to fetch and read the content directly.',
      '- **PDFs** (.pdf): Download with `curl -sL "<url>" -o /tmp/<filename>`, then use the Read tool with the pages parameter.',
      '',
      'Always download and process these files - do not just acknowledge the links. The user expects you to see and work with the file contents.',
      '',
      '# Notifications (rclaude)',
      '',
      "You can send push notifications to the user's devices (phone, browser) via the rclaude notification endpoint.",
      'Use this when the user asks to be notified, or when a long-running task completes and the user might not be watching.',
      '',
      '```bash',
      `curl -s -X POST http://127.0.0.1:${localServerPort}/notify -H "Content-Type: application/json" -d '{"message": "Your task is done!", "title": "Optional title"}'`,
      '```',
      '',
      '- `message` (required): The notification body text',
      '- `title` (optional): Notification title (defaults to project name)',
      '',
      "This sends a real push notification to the user's phone/browser AND shows a toast in the dashboard.",
      ...(channelEnabled
        ? [
            '',
            '# MCP Channel (rclaude)',
            '',
            'This session has an active MCP channel connection to the rclaude remote dashboard.',
            'Messages from the dashboard arrive as `<channel source="rclaude">` -- treat them as regular user input.',
            'The user may be on their phone or another device, not at the terminal.',
            '',
            '**Available MCP tools (rclaude server):**',
            "- `mcp__rclaude__notify` - Send a push notification to the user's devices (phone, browser)",
            '- `mcp__rclaude__share_file` - Upload a local file and get a public URL for the dashboard user',
            '',
            '',
            'Prefer the MCP `notify` tool over the curl endpoint when the channel is active.',
            'Use `share_file` to share screenshots, images, build artifacts, or any file the user needs to see.',
            '',
            '# Inter-Session Communication (rclaude)',
            '',
            'You can communicate with other active Claude Code sessions that have channels enabled:',
            '- `mcp__rclaude__list_sessions` - discover live sessions (only shows channel-capable sessions)',
            '- `mcp__rclaude__send_message` - send a message to another session (first contact requires user approval via dashboard)',
            '',
            'Messages from other sessions arrive as `<channel sender="session">`. They include:',
            '- `from_session` / `from_project`: who sent it',
            '- `intent`: request (they need something), response (answering you), notify (FYI), progress (status update)',
            '- `conversation_id`: include this in replies to maintain thread context',
            '',
            'Session linking is managed by the user via the dashboard -- you cannot approve or block sessions.',
            'Always include conversation_id when replying to maintain context threading.',
          ]
        : []),
    ].join('\n'),
  )
  claudeArgs.push('--append-system-prompt-file', promptFile)

  // Spawn claude with PTY
  // Convert WS URL to HTTP for tools/scripts that need to call the concentrator REST API
  const concentratorHttpUrl = noConcentrator ? undefined : wsToHttpUrl(concentratorUrl)

  // Add --channels + --mcp-config for MCP channel support
  const finalClaudeArgs = channelEnabled
    ? [
        '--dangerously-load-development-channels',
        'server:rclaude',
        '--mcp-config',
        JSON.stringify({ mcpServers: { rclaude: { type: 'http', url: `http://localhost:${localServerPort}/mcp` } } }),
        ...claudeArgs,
      ]
    : claudeArgs

  ptyProcess = spawnClaude({
    args: finalClaudeArgs,
    settingsPath,
    sessionId: internalId,
    localServerPort,
    concentratorUrl: concentratorHttpUrl,
    concentratorSecret,
    onData(data) {
      // Auto-confirm dev channel warning prompt (fires once on startup)
      // CC uses Ink/React TUI -- the warning text is painted via cursor positioning,
      // not as sequential text. But "Entertoconfirm" appears in the raw stream
      // (ANSI-stripped, no spaces due to Ink rendering). Detect that + confirm.
      if (channelEnabled && !devChannelConfirmed) {
        const plain = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b[=>?][0-9]*[a-zA-Z]/g, '')
        if (plain.includes('Entertoconfirm')) {
          devChannelConfirmed = true
          setTimeout(() => {
            debug('[channel] Sending Enter to confirm dev channel warning')
            ptyProcess?.write('\r')
          }, 300)
          diag('channel', 'Auto-confirmed dev channel warning')
        }
      }

      // Forward PTY output to remote terminal viewer when attached
      if (terminalAttached && claudeSessionId && wsClient?.isConnected()) {
        wsClient.sendTerminalData(data)
      }
    },
    onExit(code) {
      // Send session end to concentrator
      if (claudeSessionId) {
        wsClient?.sendSessionEnd(code === 0 ? 'normal' : `exit_code_${code}`)
      }

      // Cleanup
      cleanup()

      process.exit(code ?? 0)
    },
  })

  // Setup terminal passthrough
  const cleanupTerminal = setupTerminalPassthrough(ptyProcess)

  // Cleanup function
  function cleanup() {
    if (taskWatcher) taskWatcher.close()
    transcriptWatcher?.stop()
    for (const watcher of subagentWatchers.values()) watcher.stop()
    subagentWatchers.clear()
    for (const watcher of bgTaskOutputWatchers.values()) watcher.stop()
    bgTaskOutputWatchers.clear()
    fileEditor?.destroy()
    cleanupTerminal()
    stopLocalServer(localServer)
    wsClient?.close()
    cleanupSettings(internalId).catch(() => {})
    if (channelEnabled) {
      closeMcpChannel().catch(() => {})
    }
    try {
      unlinkSync(promptFile)
    } catch {}
  }

  // Handle unexpected exits
  process.on('exit', cleanup)
  process.on('uncaughtException', error => {
    debug(`Uncaught exception: ${error instanceof Error ? error.stack || error.message : error}`)
    cleanup()
    process.exit(1)
  })
}

main().catch(error => {
  debug(`Fatal error: ${error instanceof Error ? error.stack || error.message : error}`)
  process.exit(1)
})
