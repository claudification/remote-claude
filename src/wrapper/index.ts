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
import { structuredPatch as computeStructuredPatch } from 'diff'
import { isPathWithinCwd } from '../shared/path-guard'
import type { HookEvent, TaskInfo, TasksUpdate, TranscriptEntry, WrapperMessage } from '../shared/protocol'
import { DEFAULT_CONCENTRATOR_URL } from '../shared/protocol'
import { checkForUpdate, formatUpdateResult, formatVersion } from '../shared/update-check'
import { DEBUG, debug, setDebugStderr } from './debug'
import { FileEditor } from './file-editor'
import { resolveAskRequest, setLocalServerDebug, startLocalServer, stopLocalServer } from './local-server'
import {
  closeMcpChannel,
  initMcpChannel,
  isMcpChannelReady,
  keepaliveDialog,
  pushChannelMessage,
  resolveDialog,
  type SessionInfo,
  sendPermissionResponse,
  setClaudeCodeVersion,
  setDialogCwd,
} from './mcp-channel'
import { Osc52Parser } from './osc52-parser'
import { createRulesEngine } from './permission-rules'
import { getTerminalSize, type PtyProcess, setupTerminalPassthrough, spawnClaude } from './pty-spawn'
import { cleanupSettings, writeMergedSettings } from './settings-merge'
import { type StreamProcess, spawnStreamClaude } from './stream-backend'
import {
  createTaskNote,
  deleteTaskNote,
  getTaskNote,
  listTaskNotes,
  moveTaskNote,
  type TaskStatus,
  updateTaskNote,
} from './task-notes'
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

interface ClaudeAuthInfo {
  email?: string
  orgId?: string
  orgName?: string
  subscriptionType?: string
}

function detectClaudeAuth(): ClaudeAuthInfo | undefined {
  try {
    const proc = Bun.spawnSync(['claude', 'auth', 'status', '--json'], { timeout: 5000 })
    if (proc.exitCode !== 0) return undefined
    const data = JSON.parse(proc.stdout.toString().trim())
    if (!data.loggedIn) return undefined
    return {
      email: data.email || undefined,
      orgId: data.orgId || undefined,
      orgName: data.orgName || undefined,
      subscriptionType: data.subscriptionType || undefined,
    }
  } catch {
    return undefined
  }
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
  --headless             Use stream-json backend (default, no terminal, structured I/O)
  --no-headless / --pty  Use PTY backend (interactive terminal mode)
  --no-terminal          Disable remote terminal capability
  --no-channels          Disable MCP channel (channels are ON by default)
  --channels             Enable MCP channel (already default, for explicitness)
  --rclaude-version      Show rclaude build version
  --rclaude-check-update Check if a newer version is available on GitHub
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

/**
 * Ensure .claude/.rclaude/ directory exists in the given CWD with a .gitignore.
 * Returns the absolute path to the directory.
 */
function ensureRclaudeDir(cwd: string): string {
  const dir = join(cwd, '.claude', '.rclaude')
  mkdirSync(dir, { recursive: true })
  const gitignorePath = join(dir, '.gitignore')
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, '# Auto-generated by rclaude - ignore all temp files\n*\n!.gitignore\n')
  }
  return dir
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

// Claude CLI subcommands that should be passed through directly (no wrapper logic)
const CLAUDE_PASSTHROUGH_SUBCOMMANDS = new Set([
  'agents',
  'auth',
  'auto-mode',
  'doctor',
  'install',
  'mcp',
  'plugin',
  'plugins',
  'setup-token',
  'update',
  'upgrade',
])

async function main() {
  // Parse our specific args, pass the rest to claude
  const args = process.argv.slice(2)

  // Detect Claude CLI subcommands and pass them through directly — these are
  // management commands that don't need the rclaude wrapper (concentrator, MCP,
  // system prompt, PTY, etc.). Passing them through the wrapper causes spurious
  // errors like "unknown option '--append-system-prompt-file'".
  const firstNonFlag = args.find(a => !a.startsWith('-'))
  if (firstNonFlag && CLAUDE_PASSTHROUGH_SUBCOMMANDS.has(firstNonFlag)) {
    debug(`Passthrough subcommand detected: ${firstNonFlag} — exec'ing claude directly`)
    const proc = Bun.spawnSync(['claude', ...args], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    process.exit(proc.exitCode ?? 1)
  }

  let concentratorUrl = process.env.RCLAUDE_CONCENTRATOR || DEFAULT_CONCENTRATOR_URL
  let concentratorSecret = process.env.RCLAUDE_SECRET
  let noConcentrator = false
  let noTerminal = false
  let headless = process.env.RCLAUDE_HEADLESS === '1' // opt-in until input routing is solid
  let channelEnabled = process.env.RCLAUDE_CHANNELS !== '0'
  const claudeArgs: string[] = []

  debug(`Concentrator URL: ${concentratorUrl} (source: ${process.env.RCLAUDE_CONCENTRATOR ? 'env' : 'default'})`)
  debug(`Concentrator secret: ${concentratorSecret ? 'set' : 'NOT SET'}`)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--rclaude-help') {
      printHelp()
      process.exit(0)
    } else if (arg === '--rclaude-version') {
      console.log(formatVersion(detectClaudeVersion()))
      process.exit(0)
    } else if (arg === '--rclaude-check-update') {
      const result = await checkForUpdate()
      console.log(formatUpdateResult(result, detectClaudeVersion()))
      process.exit(0)
    } else if (arg === '--concentrator') {
      concentratorUrl = args[++i] || DEFAULT_CONCENTRATOR_URL
    } else if (arg === '--rclaude-secret') {
      concentratorSecret = args[++i]
    } else if (arg === '--no-concentrator') {
      noConcentrator = true
    } else if (arg === '--no-terminal') {
      noTerminal = true
    } else if (arg === '--headless') {
      headless = true
    } else if (arg === '--no-headless' || arg === '--pty') {
      headless = false
    } else if (arg === '--channels') {
      channelEnabled = true
    } else if (arg === '--no-channels') {
      channelEnabled = false
    } else {
      claudeArgs.push(arg)
    }
  }

  // Headless mode implications
  if (headless) {
    noTerminal = true
    channelEnabled = false
    setDebugStderr(true) // no PTY to corrupt, stderr is safe
  }

  // Check if concentrator is reachable (unless --no-concentrator)
  if (!noConcentrator && !(await isConcentratorReady(concentratorUrl))) {
    debug('Concentrator not reachable - running without it')
    noConcentrator = true
  }
  debug(`Concentrator: ${noConcentrator ? 'DISABLED' : 'ENABLED'} (url: ${concentratorUrl})`)

  // Non-blocking update check at startup — fire and forget
  checkForUpdate()
    .then(result => {
      if (!result.upToDate && !result.error) {
        const behind = result.behindBy ? `${result.behindBy} commit(s)` : 'commits'
        console.error(`\x1b[33m⚠ rclaude update available (${behind} behind) — git pull && bun run build:client\x1b[0m`)
      }
    })
    .catch(() => {}) // silently ignore network errors on startup

  // Unique wrapper identity - use pre-assigned ID from revive flow if available
  const internalId = process.env.RCLAUDE_WRAPPER_ID || randomUUID()
  const cwd = process.cwd()
  const rclaudeDir = ensureRclaudeDir(cwd)
  const permissionRules = createRulesEngine(cwd)

  // Will be set when we receive SessionStart from Claude
  let claudeSessionId: string | null = null
  let wsClient: WsClient | null = null
  let ptyProcess: PtyProcess | null = null
  let streamProc: StreamProcess | null = null
  let clearRequested = false
  let terminalAttached = false
  let fileEditor: FileEditor | null = null
  let savedTerminalSize: { cols: number; rows: number } | null = null
  let taskWatcher: ChokidarWatcher | null = null
  let lastTasksJson = ''
  let transcriptWatcher: TranscriptWatcher | null = null
  let parentTranscriptPath: string | null = null // stored to derive subagent transcript paths
  const subagentWatchers = new Map<string, TranscriptWatcher>()
  const MAX_SUBAGENT_WATCHERS = 50
  const bgTaskOutputWatchers = new Map<string, { stop: () => void }>()
  const MAX_BG_TASK_WATCHERS = 50

  // Detect Claude Code version and auth info early - needed for settings merge and concentrator
  const claudeVersion = detectClaudeVersion()
  setClaudeCodeVersion(claudeVersion)
  setDialogCwd(cwd)
  const claudeAuth = detectClaudeAuth()

  // Queue events until we have the real session ID (capped to prevent unbounded growth)
  const MAX_EVENT_QUEUE = 200
  const eventQueue: HookEvent[] = []

  // Diagnostic log - sends structured debug entries to concentrator (capped)
  const MAX_DIAG_BUFFER = 500
  const diagBuffer: Array<{ t: number; type: string; msg: string; args?: unknown }> = []
  let diagFlushTimer: ReturnType<typeof setTimeout> | null = null

  function flushDiag() {
    diagFlushTimer = null
    if (diagBuffer.length === 0) return
    if (!wsClient?.isConnected() || !claudeSessionId) return
    const entries = diagBuffer.splice(0)
    wsClient.send({ type: 'diag', sessionId: claudeSessionId, entries } as unknown as WrapperMessage)
  }

  function diag(type: string, msg: string, args?: unknown) {
    debug(`[diag] ${type}: ${msg}${args ? ` ${JSON.stringify(args)}` : ''}`)
    if (diagBuffer.length >= MAX_DIAG_BUFFER) {
      // Drop oldest entries when buffer is full (concentrator unreachable)
      diagBuffer.splice(0, Math.floor(MAX_DIAG_BUFFER / 4))
      debug(`[diag] Buffer full, dropped ${Math.floor(MAX_DIAG_BUFFER / 4)} oldest entries`)
    }
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
          const raw = readFileSync(join(tasksDir as string, file), 'utf-8')
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

  /**
   * Watch .claude/.rclaude/tasks/ for note changes (created by dashboard, Claude, or manually).
   * Debounces and sends task_notes_changed to concentrator so dashboard can refresh.
   */
  let taskNotesWatcher: ChokidarWatcher | null = null
  let taskNotesDebounce: ReturnType<typeof setTimeout> | null = null
  const TASK_NOTES_PATTERN = /\.claude\/\.rclaude\/tasks\/(open|in-progress|done|archived)\/.+\.md$/

  function startTaskNotesWatching() {
    if (taskNotesWatcher) return
    const tasksDir = join(cwd, '.claude', '.rclaude', 'tasks')
    taskNotesWatcher = chokidarWatch(join(tasksDir, '**', '*.md'), {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      depth: 2,
    })

    function onTaskNoteChange(path: string) {
      if (!TASK_NOTES_PATTERN.test(path)) return
      if (taskNotesDebounce) clearTimeout(taskNotesDebounce)
      taskNotesDebounce = setTimeout(() => {
        taskNotesDebounce = null
        if (!wsClient?.isConnected() || !claudeSessionId) return
        const notes = listTaskNotes(cwd)
        wsClient.send({
          type: 'task_notes_changed',
          sessionId: claudeSessionId,
          notes,
        } as unknown as WrapperMessage)
        debug(`Task notes changed: ${notes.length} notes`)
      }, 300)
    }

    taskNotesWatcher.on('add', onTaskNoteChange)
    taskNotesWatcher.on('change', onTaskNoteChange)
    taskNotesWatcher.on('unlink', onTaskNoteChange)
    debug('Task notes watcher started')
  }

  function connectToConcentrator(sessionId: string) {
    if (noConcentrator || wsClient) return

    // Build capabilities list
    const capabilities = [
      ...(!noTerminal ? ['terminal' as const] : []),
      ...(channelEnabled ? ['channel' as const] : []),
      ...(headless ? ['headless' as const] : []),
    ]

    wsClient = createWsClient({
      concentratorUrl,
      concentratorSecret,
      sessionId,
      wrapperId: internalId,
      cwd,
      args: claudeArgs,
      claudeVersion,
      claudeAuth,
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
        // Start polling task files + watching task notes
        startTaskWatching()
        startTaskNotesWatching()
      },
      onDisconnected() {
        debug('Disconnected from concentrator')
      },
      onError(error) {
        debug(`Concentrator error: ${error.message}`)
      },
      onInput(input, crDelay) {
        // Headless mode: typed methods, no PTY handler
        if (headless) {
          if (!streamProc || !input) return
          const trimmed = input.trimEnd()
          // Intercept headless-specific commands
          if (trimmed === '/exit' || trimmed === '/quit' || trimmed === ':q' || trimmed === ':q!') {
            streamProc.kill()
          } else if (trimmed === '/clear') {
            // Kill CC process and respawn fresh (no --continue/--resume)
            diag('headless', 'Clear requested - killing CC and respawning fresh')
            streamProc.kill()
            // Don't exit -- respawn handled in onExit when clearRequested is set
            clearRequested = true
          } else if (trimmed.startsWith('/model ')) {
            const model = trimmed.slice(7).trim()
            if (model) streamProc.sendSetModel(model)
          } else {
            streamProc.sendUserMessage(input)
          }
          return
        }

        if (!ptyProcess) return

        // Slash commands (/compact, /clear, /model, etc.) must go via PTY -
        // they're processed by Claude Code's CLI input layer, not the model.
        // Channel messages bypass the CLI and go straight to model context.
        const isSlashCommand = input.trimStart().startsWith('/')

        // Channel mode: push through MCP instead of PTY injection
        if (channelEnabled && isMcpChannelReady() && !isSlashCommand) {
          pushChannelMessage(input)
            .then(sent => {
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
            .catch(err => {
              debug(`pushChannelMessage error: ${err instanceof Error ? err.message : err}`)
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
      onAck() {
        // Concentrator has processed our meta message and registered the socket.
        // This is the correct signal to resend state (not an arbitrary timeout).
        if (transcriptWatcher) {
          debug('Ack received, re-sending transcript')
          transcriptWatcher.resend().catch(err => debug(`Resend failed: ${err}`))
        }
        lastTasksJson = ''
        readAndSendTasks()
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
          retryTranscriptWatcher(parentTranscriptPath).catch(err => {
            debug(`retryTranscriptWatcher error: ${err instanceof Error ? err.message : err}`)
          })
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
        pendingSendResult?.(result as { ok: boolean; error?: string; conversationId?: string })
      },
      onChannelReviveResult(result) {
        pendingReviveResult?.(result)
      },
      onChannelRestartResult(result) {
        pendingRestartResult?.(result)
      },
      onChannelSpawnResult(result) {
        pendingSpawnResult?.(result)
      },
      onChannelConfigureResult(result) {
        pendingConfigureResult?.(result)
      },
      onChannelDeliver(delivery) {
        if (headless && streamProc) {
          // Headless mode: deliver inter-session messages via stdin as <channel> tags (no conduit wrapper)
          const attrs = [
            `sender="session"`,
            `from_session="${delivery.fromSession}"`,
            `from_project="${delivery.fromProject}"`,
            `intent="${delivery.intent}"`,
            ...(delivery.conversationId ? [`conversation_id="${delivery.conversationId}"`] : []),
          ].join(' ')
          const wrapped = `<channel ${attrs}>\n${delivery.message}\n</channel>`
          streamProc.sendUserMessage(wrapped)
          diag('headless', `Channel from ${delivery.fromProject}: ${delivery.message.slice(0, 60)}`)
        } else if (channelEnabled && isMcpChannelReady()) {
          const meta: Record<string, string> = {
            sender: 'session',
            from_session: delivery.fromSession,
            from_project: delivery.fromProject,
            intent: delivery.intent,
          }
          if (delivery.conversationId) meta.conversation_id = delivery.conversationId
          if (delivery.context) meta.context = delivery.context
          pushChannelMessage(delivery.message, meta).catch(err => {
            debug(`pushChannelMessage (deliver) error: ${err instanceof Error ? err.message : err}`)
          })
          diag('channel', `Received from ${delivery.fromProject}: ${delivery.message.slice(0, 60)}`)
        }
      },
      onChannelLinkRequest() {
        // Link requests are handled by the dashboard UI, not by Claude
      },
      onPermissionResponse(requestId: string, behavior: 'allow' | 'deny', toolUseId?: string) {
        if (headless && streamProc) {
          // Headless: respond via control_response on stdin
          streamProc.sendPermissionResponse(requestId, behavior === 'allow', undefined, toolUseId)
          diag('headless', `Permission response: ${requestId} -> ${behavior}`)
        } else if (channelEnabled && isMcpChannelReady()) {
          // PTY + channel: respond via MCP channel
          sendPermissionResponse(requestId, behavior).catch(err => {
            debug(`sendPermissionResponse error: ${err instanceof Error ? err.message : err}`)
          })
          diag('channel', `Permission response: ${requestId} -> ${behavior}`)
        }
      },
      onAskAnswer(toolUseId, answers, annotations, skip) {
        // Headless: resolve via control_response to CC's can_use_tool request
        const pending = pendingAskRequests.get(toolUseId)
        if (pending && headless && streamProc) {
          pendingAskRequests.delete(toolUseId)
          if (skip || !answers) {
            streamProc.sendPermissionResponse(pending.requestId, false, undefined, toolUseId)
            diag('headless', `AskUserQuestion skipped: ${toolUseId.slice(0, 12)}`)
          } else {
            streamProc.sendPermissionResponse(
              pending.requestId,
              true,
              { questions: pending.questions, answers, ...(annotations && { annotations }) },
              toolUseId,
            )
            diag('headless', `AskUserQuestion answered: ${toolUseId.slice(0, 12)}`)
          }
          return
        }
        // PTY+channel: resolve via MCP channel local server
        const resolved = resolveAskRequest(toolUseId, answers, annotations, skip)
        diag(
          'ask',
          resolved ? `Answer resolved: ${toolUseId.slice(0, 12)}` : `No pending request: ${toolUseId.slice(0, 12)}`,
        )
      },
      onDialogResult(dialogId, result) {
        const resolved = resolveDialog(dialogId, result)
        diag(
          'dialog',
          resolved
            ? `Result resolved: ${dialogId.slice(0, 8)} action=${result._action}`
            : `No pending dialog: ${dialogId.slice(0, 8)}`,
        )
      },
      onDialogKeepalive(dialogId) {
        keepaliveDialog(dialogId)
      },
      onRendezvousResult(message: Record<string, unknown>) {
        const msgType = message.type as string
        const sessionId = message.sessionId as string | undefined
        const cwd = message.cwd as string | undefined
        const error = message.error as string | undefined
        const isReady = msgType === 'spawn_ready' || msgType === 'revive_ready' || msgType === 'restart_ready'
        const action = msgType.startsWith('spawn') ? 'spawn' : msgType.startsWith('restart') ? 'restart' : 'revive'

        if (isReady) {
          diag('rendezvous', `${action} ready: session=${sessionId?.slice(0, 8)} cwd=${cwd}`)
        } else {
          diag('rendezvous', `${action} timeout: ${error || 'unknown'}`)
        }

        // Resolve pending spawn/revive promise if one exists
        const pending = pendingRendezvous.get(message.wrapperId as string)
        if (pending) {
          pendingRendezvous.delete(message.wrapperId as string)
          if (isReady) {
            pending.resolve(message)
          } else {
            pending.reject(error || `${action} timed out`)
          }
        }

        // Also push to channel so Claude sees the result
        if (channelEnabled && isMcpChannelReady()) {
          const text = isReady
            ? `Session ${action === 'spawn' ? 'spawned' : 'revived'}: ${cwd?.split('/').pop() || sessionId?.slice(0, 8)} (${sessionId?.slice(0, 8)})`
            : `Session ${action} timed out: ${error || 'no response within 2 minutes'}`
          pushChannelMessage(text, {
            sender: 'system',
            [`${action}_result`]: isReady ? 'ready' : 'timeout',
            ...(sessionId ? { target_session: sessionId } : {}),
          }).catch(() => {})
        }
      },
      onPermissionRule(toolName: string, behavior: 'allow' | 'deny') {
        if (behavior === 'allow') {
          permissionRules.addSessionRule(toolName)
          diag('channel', `Auto-approve rule added: ${toolName}`)
        } else {
          permissionRules.removeSessionRule(toolName)
          diag('channel', `Auto-approve rule removed: ${toolName}`)
        }
      },
      onQuitSession() {
        diag('session', 'Quit requested from dashboard - sending SIGTERM')
        if (headless && streamProc) streamProc.kill()
        else if (ptyProcess) ptyProcess.kill('SIGTERM')
      },
      onInterrupt() {
        if (headless && streamProc) {
          diag('session', 'Interrupt requested from dashboard')
          streamProc.sendInterrupt()
        } else if (ptyProcess) {
          diag('session', 'Interrupt requested from dashboard - sending Ctrl+C to PTY')
          ptyProcess.write('\x03')
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
      wsClient?.send({ type: responseType, requestId, sessionId, ...data } as unknown as WrapperMessage)
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
          wsClient?.send({ type: 'file_changed', sessionId, ...event } as unknown as WrapperMessage)
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
      case 'task_notes_list':
        try {
          const notes = listTaskNotes(cwd, msg.status as TaskStatus | undefined)
          respond('task_notes_list_response', { notes })
        } catch (err) {
          respondError('task_notes_list_response', err)
        }
        break
      case 'task_notes_create':
        try {
          const note = createTaskNote(cwd, {
            title: msg.title as string | undefined,
            body: msg.body as string,
            priority: msg.priority as 'low' | 'medium' | 'high' | undefined,
            tags: msg.tags as string[] | undefined,
            refs: msg.refs as string[] | undefined,
          })
          respond('task_notes_create_response', { note })
        } catch (err) {
          respondError('task_notes_create_response', err)
        }
        break
      case 'task_notes_move':
        try {
          const ok = moveTaskNote(cwd, msg.slug as string, msg.from as TaskStatus, msg.to as TaskStatus)
          respond('task_notes_move_response', { ok })
        } catch (err) {
          respondError('task_notes_move_response', err)
        }
        break
      case 'task_notes_delete':
        try {
          const ok = deleteTaskNote(cwd, msg.status as TaskStatus, msg.slug as string)
          respond('task_notes_delete_response', { ok })
        } catch (err) {
          respondError('task_notes_delete_response', err)
        }
        break
      case 'task_notes_read':
        try {
          const note = getTaskNote(cwd, msg.status as TaskStatus, msg.slug as string)
          respond('task_notes_read_response', { note })
        } catch (err) {
          respondError('task_notes_read_response', err)
        }
        break
      case 'task_notes_update':
        try {
          const note = updateTaskNote(cwd, msg.status as TaskStatus, msg.slug as string, {
            title: msg.title as string | undefined,
            body: msg.body as string | undefined,
            priority: msg.priority as 'low' | 'medium' | 'high' | undefined,
            tags: msg.tags as string[] | undefined,
            refs: msg.refs as string[] | undefined,
          })
          respond('task_notes_update_response', { note })
        } catch (err) {
          respondError('task_notes_update_response', err)
        }
        break
    }
    debug(`File editor: ${type}${msg.path ? ` path=${msg.path}` : ''}`)
  }

  const TRANSCRIPT_CHUNK_SIZE = 50 // entries per chunk (was 200 — smaller to avoid oversized WS frames)

  // Cache Edit tool inputs by tool_use_id for diff computation when the result arrives
  const pendingEditInputs = new Map<string, { oldString: string; newString: string }>()
  // Map Agent tool_use_id -> agent task_id for routing subagent stdout entries
  const agentToolUseMap = new Map<string, string>()
  // Pending AskUserQuestion requests from can_use_tool -- keyed by toolUseId
  const pendingAskRequests = new Map<string, { requestId: string; questions: unknown[] }>()

  // Augment entries with structuredPatch for Edit diffs.
  // Two paths: (1) JSONL entries already have toolUseResult.oldString/newString -> compute directly
  // (2) Stream entries: assistant has tool_use.input, user has tool_result -> cache input, apply on result
  function augmentEditPatches(entries: TranscriptEntry[]): TranscriptEntry[] {
    for (const entry of entries) {
      const e = entry as Record<string, unknown>

      // Path 1: toolUseResult with oldString/newString -- recompute structuredPatch with
      // proper file line numbers using originalFile when available
      const tur = e.toolUseResult as Record<string, unknown> | undefined
      if (tur?.oldString && tur?.newString) {
        try {
          const oldStr = tur.oldString as string
          const newStr = tur.newString as string
          const originalFile = tur.originalFile as string | undefined
          if (originalFile) {
            // Diff the full file: original vs original-with-edit-applied
            const modifiedFile = originalFile.replace(oldStr, newStr)
            const patch = computeStructuredPatch('file', 'file', originalFile, modifiedFile, '', '', { context: 3 })
            if (patch.hunks.length > 0) tur.structuredPatch = patch.hunks
          } else if (!tur.structuredPatch) {
            // No original file -- fall back to snippet diff (oldStart: 1)
            const patch = computeStructuredPatch('file', 'file', oldStr, newStr, '', '', { context: 3 })
            if (patch.hunks.length > 0) tur.structuredPatch = patch.hunks
          }
        } catch {}
        continue
      }

      // Path 2a: assistant entry with Edit tool_use -> cache old_string/new_string
      const msg = (e as { message?: { content?: unknown[] } }).message
      if (entry.type === 'assistant' && Array.isArray(msg?.content)) {
        for (const block of msg.content as Record<string, unknown>[]) {
          if (block.type === 'tool_use' && block.name === 'Edit' && block.id) {
            const input = block.input as Record<string, unknown> | undefined
            if (input?.old_string && input?.new_string) {
              pendingEditInputs.set(block.id as string, {
                oldString: input.old_string as string,
                newString: input.new_string as string,
              })
            }
          }
        }
      }

      // Path 2b: user entry with tool_result -> look up cached input, compute patch
      if (entry.type === 'user' && Array.isArray(msg?.content)) {
        for (const block of msg.content as Record<string, unknown>[]) {
          if (block.type === 'tool_result' && block.tool_use_id && !block.is_error) {
            const cached = pendingEditInputs.get(block.tool_use_id as string)
            if (cached) {
              pendingEditInputs.delete(block.tool_use_id as string)
              try {
                const patch = computeStructuredPatch('file', 'file', cached.oldString, cached.newString, '', '', {
                  context: 3,
                })
                if (patch.hunks.length > 0) {
                  // Attach to toolUseResult (create if missing)
                  if (!e.toolUseResult) e.toolUseResult = {}
                  ;(e.toolUseResult as Record<string, unknown>).structuredPatch = patch.hunks
                }
              } catch {}
            }
          }
        }
      }
    }
    return entries
  }

  function sendTranscriptEntriesChunked(entries: TranscriptEntry[], isInitial: boolean, agentId?: string) {
    if (!claudeSessionId || !wsClient?.isConnected()) {
      debug(`Cannot send ${entries.length} entries: sessionId=${!!claudeSessionId} ws=${wsClient?.isConnected()}`)
      return
    }
    // Augment Edit tool results with structuredPatch for diff rendering
    const augmented = augmentEditPatches(entries)
    const send = (chunk: TranscriptEntry[], initial: boolean) =>
      agentId
        ? wsClient?.sendSubagentTranscript(agentId, chunk, initial)
        : wsClient?.sendTranscriptEntries(chunk, initial)

    // Split into fixed-size chunks to avoid oversized WS frames
    for (let i = 0; i < augmented.length; i += TRANSCRIPT_CHUNK_SIZE) {
      const chunk = augmented.slice(i, i + TRANSCRIPT_CHUNK_SIZE)
      send(chunk, isInitial && i === 0)
    }
  }

  // Watch a background task .output file and stream chunks to concentrator
  function startBgTaskOutputWatcher(taskId: string, outputPath: string) {
    if (bgTaskOutputWatchers.has(taskId)) return

    // Evict oldest bg task watcher if at capacity
    if (bgTaskOutputWatchers.size >= MAX_BG_TASK_WATCHERS) {
      const oldest = bgTaskOutputWatchers.keys().next().value
      if (oldest) {
        debug(`BG task watcher limit (${MAX_BG_TASK_WATCHERS}) reached, evicting: ${oldest}`)
        bgTaskOutputWatchers.get(oldest)?.stop()
      }
    }

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
            wsClient?.sendBgTaskOutput(taskId, text, false)
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
    const content = (entry as Record<string, unknown>).message
      ? ((entry as Record<string, unknown>).message as Record<string, unknown>)?.content
      : undefined
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .filter((c: unknown) => typeof c === 'string' || (c as Record<string, unknown>)?.type === 'text')
      .map((c: unknown) => (typeof c === 'string' ? c : (c as Record<string, string>).text))
      .join('')
  }

  // Scan transcript entries for background task IDs and start output watchers
  function scanForBgTasks(entries: TranscriptEntry[]) {
    for (const entry of entries) {
      const tur = (entry as Record<string, unknown>).toolUseResult as Record<string, unknown> | undefined
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
      let match: RegExpExecArray | null = re.exec(text)
      while (match !== null) {
        const watcher = bgTaskOutputWatchers.get(match[1])
        if (watcher) {
          diag('bgout', `Task completed, stopping watcher`, { taskId: match[1] })
          watcher.stop()
        }
        match = re.exec(text)
      }
    }
  }

  function startTranscriptWatcher(transcriptPath: string) {
    if (headless) {
      debug('Skipping transcript watcher in headless mode (data comes from stdout stream)')
      return
    }
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
    // Subagent transcripts are separate files even in headless mode -
    // agent output does NOT appear inline in the parent stdout stream
    if (subagentWatchers.has(agentId)) return

    // Evict oldest live watchers if at capacity (prevents unbounded growth if SubagentStop never fires)
    if (subagentWatchers.size >= MAX_SUBAGENT_WATCHERS) {
      const oldest = subagentWatchers.keys().next().value
      if (oldest) {
        debug(`Subagent watcher limit (${MAX_SUBAGENT_WATCHERS}) reached, evicting: ${oldest.slice(0, 7)}`)
        const evicted = subagentWatchers.get(oldest)
        evicted?.stop()
        subagentWatchers.delete(oldest)
      }
    }

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
  const osc52Parser = new Osc52Parser()
  diag('channel', `MCP enabled (channel input: ${channelEnabled})`)
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
        // Use ArrayBuffer instead of BunFile as fetch body to avoid Bun SIGTRAP crash
        const bytes = await file.arrayBuffer()
        const contentType = file.type || 'application/octet-stream'
        const res = await fetch(`${httpUrl}/api/files`, {
          method: 'POST',
          headers: {
            'Content-Type': contentType,
            'X-Session-Id': claudeSessionId || internalId,
            ...(concentratorSecret ? { Authorization: `Bearer ${concentratorSecret}` } : {}),
          },
          body: bytes,
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
    async onListSessions(status, showMetadata) {
      if (!wsClient?.isConnected()) return []
      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve([]), 5000)
        pendingListSessions = sessions => {
          clearTimeout(timeout)
          pendingListSessions = null
          resolve(sessions)
        }
        wsClient?.send({
          type: 'channel_list_sessions',
          status,
          show_metadata: showMetadata,
        } as unknown as WrapperMessage)
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
        wsClient?.send({
          type: 'channel_send',
          fromSession: claudeSessionId || internalId,
          toSession: to,
          intent,
          message,
          context,
          conversationId,
        } as unknown as WrapperMessage)
      })
    },
    onPermissionRequest(data) {
      // Check auto-approve rules before forwarding to dashboard
      if (permissionRules.shouldAutoApprove(data.toolName, data.inputPreview)) {
        if (headless && streamProc) {
          streamProc.sendPermissionResponse(data.requestId, true)
        } else {
          sendPermissionResponse(data.requestId, 'allow').catch(err => {
            debug(`sendPermissionResponse (auto) error: ${err instanceof Error ? err.message : err}`)
          })
        }
        diag(headless ? 'headless' : 'channel', `Permission auto-approved: ${data.requestId} ${data.toolName}`)
        // Notify dashboard for visibility (not for approval)
        if (wsClient?.isConnected()) {
          wsClient.send({
            type: 'permission_auto_approved',
            sessionId: claudeSessionId || internalId,
            requestId: data.requestId,
            toolName: data.toolName,
            description: data.description,
          } as unknown as WrapperMessage)
        }
        return
      }

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
    onDialogShow(dialogId, layout) {
      diag('dialog', `Show: "${layout.title}" (${dialogId.slice(0, 8)})`)
      if (wsClient?.isConnected()) {
        wsClient.send({
          type: 'dialog_show',
          sessionId: claudeSessionId || internalId,
          dialogId,
          layout,
        } as unknown as WrapperMessage)
      }
    },
    onDialogDismiss(dialogId) {
      diag('dialog', `Dismiss: ${dialogId.slice(0, 8)}`)
      if (wsClient?.isConnected()) {
        wsClient.send({
          type: 'dialog_dismiss',
          sessionId: claudeSessionId || internalId,
          dialogId,
        } as unknown as WrapperMessage)
      }
    },
    onDeliverMessage(content, meta) {
      if (headless && streamProc) {
        // Headless: deliver as <channel> tag on stdin
        const attrs = Object.entries(meta)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ')
        const wrapped = `<channel ${attrs}>\n${content}\n</channel>`
        streamProc.sendUserMessage(wrapped)
        diag('headless', `Delivered message: ${meta.sender} ${content.slice(0, 60)}`)
      } else {
        // PTY+channel: deliver as MCP channel notification
        pushChannelMessage(content, meta)
        diag('channel', `Delivered message: ${meta.sender} ${content.slice(0, 60)}`)
      }
    },
    onDisconnect() {
      diag('channel', 'Channel disconnected')
    },
    onTogglePlanMode() {
      if (headless) {
        diag('channel', 'toggle_plan_mode: not supported in headless mode')
      } else {
        diag('channel', 'toggle_plan_mode: injecting /plan via PTY')
        if (ptyProcess) ptyProcess.write('/plan\r')
      }
    },
    async onReviveSession(sessionId) {
      if (!wsClient?.isConnected()) return { ok: false, error: 'Not connected to concentrator' }
      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 10000)
        pendingReviveResult = result => {
          clearTimeout(timeout)
          pendingReviveResult = null
          resolve(result)
        }
        wsClient?.send({
          type: 'channel_revive',
          sessionId,
        } as unknown as WrapperMessage)
      })
    },
    async onSpawnSession({ cwd, mode, resumeId, mkdir, headless: spawnHeadless }) {
      if (!wsClient?.isConnected()) return { ok: false, error: 'Not connected to concentrator' }

      // Step 1: Send spawn request via WS, get immediate ack with wrapperId
      const spawnResult = await new Promise<{ ok: boolean; error?: string; wrapperId?: string }>(resolve => {
        const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 15000)
        pendingSpawnResult = result => {
          clearTimeout(timeout)
          pendingSpawnResult = null
          resolve(result)
        }
        wsClient?.send({
          type: 'channel_spawn',
          cwd,
          mode,
          resumeId,
          mkdir,
          headless: spawnHeadless,
        } as unknown as WrapperMessage)
      })

      if (!spawnResult.ok) return spawnResult
      diag('channel', `spawn_session: ${cwd} mode=${mode || 'default'} wrapperId=${spawnResult.wrapperId?.slice(0, 8)}`)

      // Step 2: Await rendezvous (concentrator sends spawn_ready/spawn_timeout when session connects)
      if (spawnResult.wrapperId) {
        try {
          const wid = spawnResult.wrapperId
          const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => {
              pendingRendezvous.delete(wid)
              reject(new Error('Rendezvous timeout (45s)'))
            }, 45_000)
            pendingRendezvous.set(wid, {
              resolve: msg => {
                clearTimeout(timer)
                resolve(msg)
              },
              reject: (e: string) => {
                clearTimeout(timer)
                reject(new Error(e))
              },
            })
          })
          const session = result.session as Record<string, unknown> | undefined
          diag('channel', `spawn_session: rendezvous resolved session=${(result.sessionId as string)?.slice(0, 8)}`)
          return { ok: true, wrapperId: spawnResult.wrapperId, session }
        } catch (err) {
          diag('channel', `spawn_session: rendezvous failed: ${err instanceof Error ? err.message : err}`)
          return { ok: true, wrapperId: spawnResult.wrapperId, timedOut: true }
        }
      }

      return { ok: true, wrapperId: spawnResult.wrapperId }
    },
    async onRestartSession(sessionId) {
      if (!wsClient?.isConnected()) return { ok: false, error: 'Not connected to concentrator' }
      return new Promise(resolve => {
        const timeout = setTimeout(
          () => resolve({ ok: false, error: 'Timeout waiting for restart confirmation' }),
          10000,
        )
        pendingRestartResult = result => {
          clearTimeout(timeout)
          pendingRestartResult = null
          resolve(result)
        }
        wsClient?.send({
          type: 'channel_restart',
          sessionId,
        } as unknown as WrapperMessage)
      })
    },
    async onQuitSession(sessionId) {
      if (!wsClient?.isConnected()) return { ok: false, error: 'Not connected to concentrator' }
      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout waiting for quit confirmation' }), 10000)
        // Send quit request via WS - concentrator routes to target wrapper
        wsClient?.send({
          type: 'quit_remote_session',
          targetSession: sessionId,
          fromSession: claudeSessionId || internalId,
        } as unknown as WrapperMessage)
        // For now, assume success since the concentrator doesn't ack quit
        clearTimeout(timeout)
        resolve({ ok: true })
      })
    },
    async onConfigureSession({ sessionId, label, icon, color, description, keyterms }) {
      if (!wsClient?.isConnected()) return { ok: false, error: 'Not connected to concentrator' }
      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 10000)
        pendingConfigureResult = result => {
          clearTimeout(timeout)
          pendingConfigureResult = null
          resolve(result)
        }
        wsClient?.send({
          type: 'channel_configure',
          sessionId,
          label,
          icon,
          color,
          description,
          keyterms,
        } as unknown as WrapperMessage)
      })
    },
  })

  // Pending callbacks for inter-session request/response
  let pendingListSessions: ((sessions: SessionInfo[]) => void) | null = null
  let pendingSendResult: ((result: { ok: boolean; error?: string; conversationId?: string }) => void) | null = null
  let pendingReviveResult: ((result: { ok: boolean; error?: string; name?: string }) => void) | null = null
  let pendingRestartResult:
    | ((result: { ok: boolean; error?: string; name?: string; selfRestart?: boolean; alreadyEnded?: boolean }) => void)
    | null = null
  let pendingSpawnResult: ((result: { ok: boolean; error?: string; wrapperId?: string }) => void) | null = null
  let pendingConfigureResult: ((result: { ok: boolean; error?: string }) => void) | null = null
  const pendingRendezvous = new Map<
    string,
    { resolve: (msg: Record<string, unknown>) => void; reject: (error: string) => void }
  >()

  // Wire debug logging into local server
  setLocalServerDebug(debug)

  // Start local HTTP server for hook callbacks + MCP endpoint (always enabled)
  const { server: localServer, port: localServerPort } = await startLocalServer({
    sessionId: internalId,
    mcpEnabled: true,
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
            startTaskNotesWatching()
          }

          // Start/restart transcript watcher if path is available and session changed
          if (data.transcript_path && typeof data.transcript_path === 'string') {
            const transcriptPath = data.transcript_path
            parentTranscriptPath = transcriptPath
            // Start watcher if transcript file exists, or retry until it does
            // Brand new projects can take 60-90s before Claude creates the JSONL file.
            // Use exponential backoff: 500ms, 1s, 2s, 4s... capped at 10s, ~2.5 min total
            async function tryStartTranscriptWatcher(path: string) {
              if (headless) return // no transcript file watching in headless mode
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
            tryStartTranscriptWatcher(transcriptPath).catch(err => {
              debug(`tryStartTranscriptWatcher error: ${err instanceof Error ? err.message : err}`)
            })
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
        debug(`Hook: ${event.hookEvent} -> forwarded (sid=${claudeSessionId.slice(0, 8)})`)
      } else {
        if (eventQueue.length >= MAX_EVENT_QUEUE) {
          const dropped = eventQueue.shift()
          debug(`Event queue full (${MAX_EVENT_QUEUE}), dropping oldest: ${dropped?.hookEvent}`)
        }
        eventQueue.push(event)
        debug(
          `Hook: ${event.hookEvent} -> QUEUED (claudeSessionId=${claudeSessionId?.slice(0, 8) || 'null'} ws=${wsClient?.isConnected() || false} queue=${eventQueue.length})`,
        )
      }
    },
    onNotify(message: string, title?: string) {
      const sessionId = claudeSessionId || internalId
      debug(`Notify: ${title ? `[${title}] ` : ''}${message}`)
      if (wsClient?.isConnected()) {
        wsClient.send({ type: 'notify', sessionId, message, title })
      }
    },
    onAskQuestion(request) {
      debug(`AskUserQuestion: ${request.questions.length} questions, toolUseId=${request.toolUseId.slice(0, 12)}`)
      if (wsClient?.isConnected()) {
        wsClient.send({ ...request, sessionId: claudeSessionId || internalId })
      }
    },
    hasDashboardSubscribers() {
      return wsClient?.isConnected() ?? false
    },
  })

  // Generate merged settings with hook injection (version-aware to avoid invalid keys)
  const settingsPath = await writeMergedSettings(internalId, localServerPort, claudeVersion, rclaudeDir)

  // Set terminal title to last 2 path segments (shows in tmux)
  setTerminalTitle(cwd)

  // Write system prompt additions for rclaude-specific behavior
  const promptFile = join(rclaudeDir, `prompt-${internalId}.txt`)
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
      '',
      '# MCP Tools (rclaude)',
      '',
      '**Available MCP tools (rclaude server):**',
      "- `mcp__rclaude__notify` - Send a push notification to the user's devices (phone, browser)",
      '- `mcp__rclaude__share_file` - Upload a local file and get a public URL for the dashboard user',
      '',
      'Prefer the MCP `notify` tool over the curl endpoint when the channel is active.',
      'Use `share_file` to share screenshots, images, build artifacts, or any file the user needs to see.',
      '# Task Notes (rclaude)',
      '',
      'Use `mcp__rclaude__tasks` to list project tasks from the kanban board.',
      'Tasks are markdown files in `.claude/.rclaude/tasks/{status}/` with YAML frontmatter.',
      'Status folders: `open/`, `in-progress/`, `done/`, `archived/`.',
      'To change status: `mcp__rclaude__set_task_status` with id (filename without .md) and target status.',
      'To edit: read and write the .md file directly (update frontmatter + body).',
      'Frontmatter: title, priority (high/medium/low), tags [...], refs [...], created (ISO).',
      'Changes are auto-pushed to the dashboard kanban board via file watcher.',
      '',
      ...(channelEnabled
        ? [
            '',
            '# MCP Channel (rclaude)',
            '',
            'This session has an active MCP channel connection to the rclaude remote dashboard.',
            'Messages from the dashboard arrive as `<channel source="rclaude">` -- treat them as regular user input.',
            'The user may be on their phone or another device, not at the terminal.',
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
            '',
            '**IMPORTANT: When you receive a `<channel sender="session">` message and want to reply,',
            'ALWAYS use `mcp__rclaude__send_message` -- NEVER the built-in `SendMessage` tool.**',
            'The built-in `SendMessage` writes to a local file inbox that is invisible to the user',
            'and the dashboard. `mcp__rclaude__send_message` routes through the concentrator where',
            'the user can see, approve, and track all inter-session messages. This applies to ALL',
            'inter-session replies, regardless of how the original message arrived.',
          ]
        : []),
      // Headless conduit messaging
      ...(headless
        ? [
            '',
            '# Headless Mode',
            '',
            'This session is running in **headless mode** (no terminal, structured I/O).',
            'User messages arrive as plain text.',
            'Inter-session messages from other Claude Code sessions arrive wrapped in `<channel>` tags:',
            '',
            '```',
            '<channel sender="session" from_project="other-project" intent="request" conversation_id="conv_xyz">',
            'Message from another session',
            '</channel>',
            '```',
            '',
            'Treat these as requests from other AI sessions. Include conversation_id when replying.',
          ]
        : []),
    ].join('\n'),
  )
  claudeArgs.push('--append-system-prompt', readFileSync(promptFile, 'utf-8'))

  // Spawn claude with PTY
  // Convert WS URL to HTTP for tools/scripts that need to call the concentrator REST API
  const concentratorHttpUrl = noConcentrator ? undefined : wsToHttpUrl(concentratorUrl)

  // Always inject MCP config (tools: notify, share_file, list_sessions, send_message, toggle_plan_mode)
  // Channel input (--dangerously-load-development-channels) only when channels enabled
  const mcpConfigPath = join(rclaudeDir, `mcp-${internalId}.json`)
  await Bun.write(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: { rclaude: { type: 'http', url: `http://localhost:${localServerPort}/mcp` } },
    }),
  )
  const finalClaudeArgs = [
    '--mcp-config',
    mcpConfigPath,
    ...(channelEnabled ? ['--dangerously-load-development-channels', 'server:rclaude'] : []),
    ...claudeArgs,
  ]

  let cleanupTerminal = () => {}

  if (headless) {
    // --- HEADLESS MODE: stream-json backend ---
    debug('Starting in HEADLESS mode (stream-json)')
    diag('headless', 'Stream-JSON backend active')

    const headlessSpawnOptions: Parameters<typeof spawnStreamClaude>[0] = {
      args: finalClaudeArgs,
      settingsPath,
      sessionId: internalId,
      localServerPort,
      concentratorUrl: concentratorHttpUrl,
      concentratorSecret,
      onTranscriptEntries(entries, isInitial) {
        sendTranscriptEntriesChunked(entries, isInitial)
      },
      onInit(init) {
        debug(`[headless] init: session=${init.session_id?.slice(0, 8)} model=${init.model}`)
        if (init.session_id && !claudeSessionId) {
          claudeSessionId = init.session_id
          diag('headless', `CC session ID from init: ${init.session_id.slice(0, 8)}`)
        }
        // Derive transcript path from init if not yet set by SessionStart hook
        if (init.session_id && !parentTranscriptPath) {
          const cwdSlug = cwd.replace(/\//g, '-').replace(/^-/, '')
          parentTranscriptPath = join(
            process.env.HOME || '',
            '.claude',
            'projects',
            cwdSlug,
            `${init.session_id}.jsonl`,
          )
          debug(`[headless] Derived transcript path: ${parentTranscriptPath}`)
        }
        // Forward full init metadata to concentrator for dashboard autocomplete
        if (wsClient?.isConnected()) {
          wsClient.send({
            type: 'session_info',
            sessionId: claudeSessionId || internalId,
            tools:
              (init.tools as Array<{ name: string } | string>)?.map(t => (typeof t === 'string' ? t : t.name)) || [],
            slashCommands: (init.slash_commands as string[]) || [],
            skills: (init.skills as string[]) || [],
            agents: (init.agents as string[]) || [],
            mcpServers: (init.mcp_servers as Array<{ name: string; status?: string }>) || [],
            plugins: (init.plugins as Array<{ name: string; source?: string }>) || [],
            model: (init.model as string) || '',
            permissionMode: (init.permissionMode as string) || '',
            claudeCodeVersion: (init.claude_code_version as string) || '',
            fastModeState: (init.fast_mode_state as string) || '',
          } as WrapperMessage)
          diag(
            'headless',
            `Sent session_info: ${(init.tools as unknown[])?.length || 0} tools, ${(init.skills as unknown[])?.length || 0} skills, ${(init.agents as unknown[])?.length || 0} agents`,
          )
        }
      },
      onResult(result) {
        diag('headless', `Result: ${result.subtype} cost=$${result.total_cost_usd} turns=${result.num_turns}`)
      },
      onStreamEvent(event) {
        // Forward raw API SSE deltas to concentrator for real-time streaming
        if (wsClient?.isConnected()) {
          wsClient.sendStreamDelta(event)
        }
      },
      onRateLimit(retryAfterMs, message) {
        if (wsClient?.isConnected()) {
          wsClient.sendRateLimit(retryAfterMs, message)
        }
      },
      onTaskStarted(task) {
        if (task.taskType === 'local_agent' && task.taskId) {
          // Map toolUseId -> taskId for routing subagent entries from stdout
          agentToolUseMap.set(task.toolUseId, task.taskId)
          if (parentTranscriptPath) {
            // Also start file watcher for subagent JSONL (backup path)
            const sessionDir = parentTranscriptPath.replace(/\.jsonl$/, '')
            const agentTranscriptPath = join(sessionDir, 'subagents', `agent-${task.taskId}.jsonl`)
            debug(`[headless] Agent started: ${task.taskId.slice(0, 8)} -> ${agentTranscriptPath}`)
            startSubagentWatcher(task.taskId, agentTranscriptPath, true)
          }
        }
      },
      onSubagentEntry(toolUseId, entry) {
        const agentId = agentToolUseMap.get(toolUseId)
        if (agentId) {
          sendTranscriptEntriesChunked([entry], false, agentId)
        }
      },
      onPermissionRequest(request) {
        const inputStr = JSON.stringify(request.toolInput)
        const toolUseId = request.tool_use_id as string | undefined

        // AskUserQuestion: route to dashboard ask_question UI, respond with answers
        if (request.toolName === 'AskUserQuestion' && toolUseId) {
          const questions = (request.toolInput?.questions as unknown[]) || []
          pendingAskRequests.set(toolUseId, { requestId: request.requestId, questions })
          if (wsClient?.isConnected()) {
            wsClient.send({
              type: 'ask_question',
              sessionId: claudeSessionId || internalId,
              toolUseId,
              questions,
            } as unknown as WrapperMessage)
          }
          diag('headless', `AskUserQuestion: ${toolUseId.slice(0, 12)} ${questions.length}q`)
          return
        }

        // Check auto-approve rules (rclaude.json + session rules) before forwarding to dashboard
        if (permissionRules.shouldAutoApprove(request.toolName, inputStr.slice(0, 200))) {
          streamProc?.sendPermissionResponse(request.requestId, true, undefined, toolUseId)
          diag('headless', `Permission auto-approved: ${request.requestId} ${request.toolName}`)
          if (wsClient?.isConnected()) {
            wsClient.send({
              type: 'permission_auto_approved',
              sessionId: claudeSessionId || internalId,
              requestId: request.requestId,
              toolName: request.toolName,
              description: (request.decision_reason as string) || `${request.toolName}: ${inputStr.slice(0, 100)}`,
            } as unknown as WrapperMessage)
          }
          return
        }

        // Forward to concentrator for dashboard handling
        if (wsClient?.isConnected()) {
          wsClient.send({
            type: 'permission_request',
            sessionId: claudeSessionId || internalId,
            toolName: request.toolName,
            description: (request.decision_reason as string) || `${request.toolName}: ${inputStr.slice(0, 100)}`,
            inputPreview: inputStr.slice(0, 200),
            requestId: request.requestId,
            toolUseId,
          })
          diag('headless', `Permission request: ${request.toolName} (${request.requestId.slice(0, 8)})`)
        }
      },
      onExit(code) {
        if (clearRequested) {
          // /clear: respawn CC fresh (strip --continue/--resume/--session-id)
          clearRequested = false
          const freshArgs = finalClaudeArgs.filter(
            (a, i, arr) =>
              a !== '--continue' &&
              a !== '--resume' &&
              !(i > 0 && arr[i - 1] === '--resume') &&
              a !== '--session-id' &&
              !(i > 0 && arr[i - 1] === '--session-id'),
          )
          const oldSessionId = claudeSessionId
          claudeSessionId = ''
          parentTranscriptPath = ''
          pendingEditInputs.clear()
          agentToolUseMap.clear()
          pendingAskRequests.clear()
          diag('headless', `Respawning CC fresh after /clear (old: ${oldSessionId?.slice(0, 8) || 'none'})`)
          if (oldSessionId && wsClient?.isConnected()) {
            wsClient.sendSessionClear(randomUUID(), cwd)
          }
          respawnHeadless(freshArgs)
          return
        }
        if (claudeSessionId) {
          wsClient?.sendSessionEnd(code === 0 ? 'normal' : `exit_code_${code}`)
        }
        cleanup()
        process.exit(code ?? 0)
      },
    }

    // Respawn helper for /clear -- reuses all callbacks (they reference outer scope)
    function respawnHeadless(args: string[]) {
      streamProc = spawnStreamClaude({ ...headlessSpawnOptions, args })
      streamProc.forwardStdin()
    }

    streamProc = spawnStreamClaude(headlessSpawnOptions)
    streamProc.forwardStdin()
  } else {
    // --- PTY MODE: existing behavior ---
    ptyProcess = spawnClaude({
      args: finalClaudeArgs,
      settingsPath,
      sessionId: internalId,
      localServerPort,
      concentratorUrl: concentratorHttpUrl,
      concentratorSecret,
      onData(data) {
        // Auto-confirm dev channel warning prompt (fires once on startup)
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

        // Scan for OSC 52 clipboard sequences and forward captures to concentrator
        const cleaned = osc52Parser.write(data, capture => {
          if (wsClient?.isConnected()) {
            const sessionId = claudeSessionId || internalId
            wsClient.send({
              type: 'clipboard_capture',
              sessionId,
              contentType: capture.contentType,
              text: capture.text,
              base64: capture.contentType === 'image' ? capture.base64 : undefined,
              mimeType: capture.mimeType,
              timestamp: Date.now(),
            })
            diag(
              'clipboard',
              `${capture.contentType}${capture.mimeType ? ` (${capture.mimeType})` : ''} ${capture.text ? `${capture.text.length} chars` : `${capture.base64.length} b64 bytes`}`,
            )
          }
        })

        // Forward PTY output to remote terminal viewer when attached (OSC 52 stripped)
        if (terminalAttached && claudeSessionId && wsClient?.isConnected()) {
          wsClient.sendTerminalData(cleaned)
        }
      },
      onExit(code) {
        if (claudeSessionId) {
          wsClient?.sendSessionEnd(code === 0 ? 'normal' : `exit_code_${code}`)
        }
        cleanup()
        process.exit(code ?? 0)
      },
    })

    // Setup terminal passthrough (PTY mode only)
    cleanupTerminal = setupTerminalPassthrough(ptyProcess as PtyProcess)
  }

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
    // Clear diag buffer and timer
    if (diagFlushTimer) {
      clearTimeout(diagFlushTimer)
      diagFlushTimer = null
    }
    diagBuffer.length = 0
    eventQueue.length = 0
    cleanupSettings(internalId, rclaudeDir).catch(() => {})
    closeMcpChannel().catch(() => {})
    if (mcpConfigPath)
      try {
        unlinkSync(mcpConfigPath)
      } catch {}
    try {
      unlinkSync(promptFile)
    } catch {}
  }

  // Handle unexpected exits
  process.on('exit', cleanup)
  process.on('uncaughtException', error => {
    const msg = `[FATAL] Uncaught exception: ${error instanceof Error ? error.stack || error.message : error}`
    debug(msg)
    // Always write crash to file for post-mortem (debug() may be silent)
    try {
      require('node:fs').appendFileSync('/tmp/rclaude-crash.log', `${new Date().toISOString()} ${msg}\n`)
    } catch {
      /* ignore */
    }
    // DO NOT process.exit() - keep running. The wrapper must never crash.
  })
  process.on('unhandledRejection', reason => {
    const msg = `[FATAL] Unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : reason}`
    debug(msg)
    try {
      require('node:fs').appendFileSync('/tmp/rclaude-crash.log', `${new Date().toISOString()} ${msg}\n`)
    } catch {
      /* ignore */
    }
    // DO NOT process.exit() - keep running.
  })
}

main().catch(error => {
  debug(`Fatal bootstrap error: ${error instanceof Error ? error.stack || error.message : error}`)
  process.exit(1)
})
