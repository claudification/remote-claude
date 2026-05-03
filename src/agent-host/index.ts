#!/usr/bin/env bun
/**
 * rclaude - Claude Code Session Wrapper
 * Wraps claude CLI with hook injection and broker forwarding
 */

import { checkBunVersion } from '../shared/bun-version'

checkBunVersion()

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { watch as chokidarWatch } from 'chokidar'
import { generateFunnyName } from '../shared/funny-names'
import { isPathWithinCwd } from '../shared/path-guard'
import { cwdToProjectUri } from '../shared/project-uri'
import type { AgentHostMessage, HookEvent, TaskInfo, TasksUpdate, TranscriptEntry } from '../shared/protocol'
import { DEFAULT_BROKER_URL } from '../shared/protocol'
import { TASK_STATUS_PATTERN } from '../shared/task-statuses'
import { checkForUpdate, formatUpdateResult, formatVersion } from '../shared/update-check'
import type { AgentHostContext } from './agent-host-context'
import { debug, setDebugStderr } from './debug'
import { handleFileEditorMessage } from './file-editor-handler'
import { buildHeadlessSpawnOptions, sendAdHocPrompt } from './headless-lifecycle'
import { processHookEvent } from './hook-processor'
import { beginLaunch, emitLaunchEvent, filterRelevantEnv, replayLaunchEvents } from './launch-events'
import { resolveAskRequest, setLocalServerDebug, startLocalServer, stopLocalServer } from './local-server'
import {
  type ConversationInfo,
  closeMcpChannel,
  initMcpChannel,
  isMcpChannelReady,
  keepaliveDialog,
  pushChannelMessage,
  resolveDialog,
  sendPermissionResponse,
  setClaudeCodeVersion,
  setDialogCwd,
} from './mcp-channel'
import { Osc52Parser } from './osc52-parser'
import { clearInteraction, replayInteractions, sendInteraction } from './pending-interactions'
import { createRulesEngine } from './permission-rules'
import { listProjectTasks } from './project-tasks'
import { buildSystemPrompt } from './prompt-builder'
import { getTerminalSize, type PtyProcess, setupTerminalPassthrough, spawnClaude } from './pty-spawn'
import { cleanupSettings, writeMergedSettings } from './settings-merge'
import { spawnStreamClaude } from './stream-backend'
import {
  resendTranscriptFromFile,
  sendTranscriptEntriesChunked,
  startSubagentWatcher,
  startTranscriptWatcher,
  stopSubagentWatcher,
} from './transcript-manager'
import { createWsClient } from './ws-client'

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

function readSpinnerVerbs(): string[] | undefined {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json')
    const text = readFileSync(settingsPath, 'utf-8')
    const data = JSON.parse(text)
    const sv = data.spinnerVerbs
    if (sv?.verbs && Array.isArray(sv.verbs) && sv.verbs.length > 0) {
      return sv.verbs
    }
  } catch {}
  return undefined
}

function wsToHttpUrl(url: string): string {
  return url.replace('ws://', 'http://').replace('wss://', 'https://')
}

/**
 * Check if broker is running
 */
async function isBrokerReady(url: string): Promise<boolean> {
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

Wraps the claude CLI with hook injection and session forwarding to a broker server.

USAGE:
  rclaude [OPTIONS] [CLAUDE_ARGS...]

OPTIONS:
  --broker <url>   Broker WebSocket URL (default: ${DEFAULT_BROKER_URL})
  --rclaude-secret <s>   Shared secret for broker auth (or RCLAUDE_SECRET env)
  --no-broker      Run without forwarding to broker
  --headless             Use stream-json backend (default, no terminal, structured I/O)
  --no-headless / --pty  Use PTY backend (interactive terminal mode)
  --no-terminal          Disable remote terminal capability
  --no-channels          Disable MCP channel (channels are ON by default)
  --channels             Enable MCP channel (already default, for explicitness)
  --rclaude-version      Show rclaude build version
  --rclaude-check-update Check if a newer version is available on GitHub
  --rclaude-help         Show this help message

ENVIRONMENT:
  RCLAUDE_SECRET         Shared secret for broker auth
  RCLAUDE_BROKER   Broker WebSocket URL
  RCLAUDE_CHANNELS=0     Disable MCP channel (enabled by default)
  RCLAUDE_DEBUG=1        Enable debug logging to /tmp/rclaude-debug.log

All other arguments are passed through to claude.

EXAMPLES:
  rclaude                           # Start interactive session
  rclaude --resume                  # Resume previous session
  rclaude -p "build X"              # Non-interactive prompt
  rclaude --help                    # Show claude's help
  rclaude --no-broker         # Run without broker
  rclaude --broker ws://myserver:9999
`)
}

/**
 * Ensure .rclaude/ directory exists in the given CWD with a .gitignore.
 * Returns the absolute path to the directory.
 */
function ensureRclaudeDir(cwd: string): string {
  const dir = join(cwd, '.rclaude')

  // Migrate tasks/ -> project/ if old name exists
  const oldTasks = join(dir, 'tasks')
  const newProject = join(dir, 'project')
  if (existsSync(oldTasks) && !existsSync(newProject)) {
    renameSync(oldTasks, newProject)
  }

  mkdirSync(join(dir, 'settings'), { recursive: true })
  mkdirSync(join(dir, 'project'), { recursive: true })

  const gitignorePath = join(dir, '.gitignore')
  if (!existsSync(gitignorePath)) {
    writeFileSync(
      gitignorePath,
      '# Auto-generated by rclaude\n# Session temp files\nsettings/\n\n# Keep project board and config committed\n!project/\n!rclaude.json\n',
    )
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
  // management commands that don't need the rclaude wrapper (broker, MCP,
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

  let brokerUrl =
    process.env.CLAUDWERK_BROKER ?? process.env.RCLAUDE_BROKER ?? process.env.RCLAUDE_CONCENTRATOR ?? DEFAULT_BROKER_URL
  let brokerSecret = process.env.CLAUDWERK_SECRET ?? process.env.RCLAUDE_SECRET
  let noBroker = false
  let noTerminal = false
  let headless = process.env.RCLAUDE_HEADLESS === '1' // opt-in until input routing is solid
  let channelEnabled = process.env.RCLAUDE_CHANNELS !== '0'
  const isAdHoc = process.env.RCLAUDE_ADHOC === '1'
  const adHocTaskId = process.env.RCLAUDE_ADHOC_TASK_ID
  const adHocWorktree = process.env.RCLAUDE_WORKTREE
  const includePartialMessages = process.env.RCLAUDE_INCLUDE_PARTIAL_MESSAGES !== '0'
  const customEnv: Record<string, string> = process.env.RCLAUDE_CUSTOM_ENV
    ? (() => {
        try {
          return JSON.parse(process.env.RCLAUDE_CUSTOM_ENV)
        } catch {
          debug('Failed to parse RCLAUDE_CUSTOM_ENV, ignoring')
          return {}
        }
      })()
    : {}
  const claudeArgs: string[] = []
  let configuredModel: string | undefined

  debug(`Broker URL: ${brokerUrl} (source: ${process.env.RCLAUDE_BROKER ? 'env' : 'default'})`)
  debug(`Broker secret: ${brokerSecret ? 'set' : 'NOT SET'}`)
  if (isAdHoc) {
    debug(
      `[ad-hoc] Mode: taskId=${adHocTaskId || 'none'} worktree=${adHocWorktree || 'none'} promptFile=${process.env.RCLAUDE_INITIAL_PROMPT_FILE || 'none'} channels=${channelEnabled}`,
    )
  }

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
    } else if (arg === '--broker') {
      brokerUrl = args[++i] || DEFAULT_BROKER_URL
    } else if (arg === '--rclaude-secret') {
      brokerSecret = args[++i]
    } else if (arg === '--no-broker') {
      noBroker = true
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

  // Capture --model from claudeArgs (CC strips [1m] suffix from API responses,
  // so we need the original value for accurate context-window detection)
  for (let i = 0; i < claudeArgs.length; i++) {
    if (claudeArgs[i] === '--model' && i + 1 < claudeArgs.length) {
      configuredModel = claudeArgs[i + 1]
      break
    }
  }
  if (!configuredModel && process.env.RCLAUDE_MODEL) {
    configuredModel = process.env.RCLAUDE_MODEL
  }

  // Bare mode: pass --bare to Claude CLI (skips hooks, LSP, plugins, CLAUDE.md)
  if (process.env.RCLAUDE_BARE === '1' && !claudeArgs.includes('--bare')) {
    claudeArgs.push('--bare')
  }

  // Session name: pass --name to Claude CLI (shown in /resume, terminal title)
  if (process.env.CLAUDWERK_CONVERSATION_NAME && !claudeArgs.includes('--name') && !claudeArgs.includes('-n')) {
    claudeArgs.push('--name', process.env.CLAUDWERK_CONVERSATION_NAME)
  }

  // Permission mode: pass --permission-mode to Claude CLI
  if (process.env.RCLAUDE_PERMISSION_MODE && !claudeArgs.includes('--permission-mode')) {
    claudeArgs.push('--permission-mode', process.env.RCLAUDE_PERMISSION_MODE)
  }

  // Agent: pass --agent to Claude CLI
  if (process.env.RCLAUDE_AGENT && !claudeArgs.includes('--agent')) {
    claudeArgs.push('--agent', process.env.RCLAUDE_AGENT)
  }

  // Headless mode implications
  if (headless) {
    noTerminal = true
    channelEnabled = false
    setDebugStderr(true) // no PTY to corrupt, stderr is safe
  }

  // Check if broker is reachable (unless --no-broker)
  if (!noBroker && !(await isBrokerReady(brokerUrl))) {
    debug('Broker not reachable - running without it')
    noBroker = true
  }
  debug(`Broker: ${noBroker ? 'DISABLED' : 'ENABLED'} (url: ${brokerUrl})`)

  const sessionId =
    process.env.RCLAUDE_SESSION_ID ||
    process.env.RCLAUDE_CONVERSATION_ID ||
    process.env.RCLAUDE_WRAPPER_ID ||
    randomUUID()
  const conversationId = process.env.RCLAUDE_CONVERSATION_ID || process.env.RCLAUDE_WRAPPER_ID || sessionId
  const cwd = process.cwd()
  const rclaudeDir = ensureRclaudeDir(cwd)
  const permissionRules = createRulesEngine(cwd)

  // Detect Claude Code version and auth info early - needed for settings merge and broker
  const claudeVersion = detectClaudeVersion()
  setClaudeCodeVersion(claudeVersion)
  setDialogCwd(cwd)
  const claudeAuth = detectClaudeAuth()

  // Read spinner verbs from CC settings (user's custom verbs)
  const spinnerVerbs = readSpinnerVerbs()

  // Shared context object for extracted modules
  const ctx: AgentHostContext = {
    conversationId,
    cwd,
    headless,
    channelEnabled,
    noBroker,

    // Mutable session state
    claudeSessionId: null,
    pendingClearFromId: null,
    clearRequested: false,
    currentLaunchId: randomUUID(),
    currentLaunchPhase: 'initial',
    launchEvents: [],
    terminalAttached: false,
    jsonStreamAttached: false,
    jsonStreamBuffer: [],
    parentTranscriptPath: null,
    lastTasksJson: '',

    // Process references
    wsClient: null,
    ptyProcess: null,
    streamProc: null,
    fileEditor: null,

    // Watchers
    taskWatcher: null,
    taskCandidateDirs: [],
    transcriptWatcher: null,
    projectWatcher: null,
    subagentWatchers: new Map(),
    bgTaskOutputWatchers: new Map(),

    // Caches
    pendingEditInputs: new Map(),
    pendingReadPaths: new Map(),
    agentToolUseMap: new Map(),
    pendingAskRequests: new Map(),
    outstandingInteractions: new Map(),

    pendingTranscriptEntries: [],

    // Event queue
    eventQueue: [],

    // Diagnostics
    diagBuffer: [],
    diagFlushTimer: null,

    // Functions -- wired up below
    // biome-ignore lint/style/noNonNullAssertion: deferred init, assigned immediately after ctx is created
    diag: null!,
    // biome-ignore lint/style/noNonNullAssertion: deferred init, assigned immediately after ctx is created
    flushDiag: null!,
    debug,
    // biome-ignore lint/style/noNonNullAssertion: deferred init, assigned immediately after ctx is created
    connectToBroker: null!,
    // biome-ignore lint/style/noNonNullAssertion: deferred init, assigned immediately after ctx is created
    startTaskWatching: null!,
    // biome-ignore lint/style/noNonNullAssertion: deferred init, assigned immediately after ctx is created
    readTasks: null!,
    // biome-ignore lint/style/noNonNullAssertion: deferred init, assigned immediately after ctx is created
    startProjectWatching: null!,
    // biome-ignore lint/style/noNonNullAssertion: deferred init, assigned immediately after ctx is created
    sendProjectChanged: null!,
    startTranscriptWatcher: (path: string) => startTranscriptWatcher(ctx, path),
    startSubagentWatcher: (agentId: string, path: string, live: boolean) =>
      startSubagentWatcher(ctx, agentId, path, live),
    stopSubagentWatcher: (agentId: string) => stopSubagentWatcher(ctx, agentId),
    sendTranscriptEntriesChunked: (entries: TranscriptEntry[], isInitial: boolean, agentId?: string) =>
      sendTranscriptEntriesChunked(ctx, entries, isInitial, agentId),

    // Upload blob to broker blob store, returns URL or null
    uploadBlob: noBroker
      ? null
      : async (data: Uint8Array, mediaType: string) => {
          const httpUrl = wsToHttpUrl(brokerUrl)
          try {
            const res = await fetch(`${httpUrl}/api/files`, {
              method: 'POST',
              headers: {
                'Content-Type': mediaType,
                ...(brokerSecret ? { Authorization: `Bearer ${brokerSecret}` } : {}),
              },
              body: data,
            })
            if (!res.ok) return null
            const json = (await res.json()) as { url?: string }
            return json.url || null
          } catch {
            return null
          }
        },
  }

  // Local aliases for code remaining in index.ts (read/write the ctx object)
  let savedTerminalSize: { cols: number; rows: number } | null = null

  const MAX_DIAG_BUFFER = 500

  function flushDiag() {
    ctx.diagFlushTimer = null
    if (ctx.diagBuffer.length === 0) return
    if (!ctx.wsClient?.isConnected() || !ctx.claudeSessionId) return
    const entries = ctx.diagBuffer.splice(0)
    ctx.wsClient.send({ type: 'diag', sessionId: ctx.claudeSessionId, entries } as unknown as AgentHostMessage)
  }

  function diag(type: string, msg: string, args?: unknown) {
    debug(`[diag] ${type}: ${msg}${args ? ` ${JSON.stringify(args)}` : ''}`)
    if (ctx.diagBuffer.length >= MAX_DIAG_BUFFER) {
      // Drop oldest entries when buffer is full (broker unreachable)
      ctx.diagBuffer.splice(0, Math.floor(MAX_DIAG_BUFFER / 4))
      debug(`[diag] Buffer full, dropped ${Math.floor(MAX_DIAG_BUFFER / 4)} oldest entries`)
    }
    ctx.diagBuffer.push({ t: Date.now(), type, msg, args })
    if (!ctx.diagFlushTimer) {
      ctx.diagFlushTimer = setTimeout(flushDiag, 500)
    }
  }

  // Wire up context functions now that they're defined
  ctx.diag = diag
  ctx.flushDiag = flushDiag

  /**
   * Read and send current task state.
   * Called by chokidar watcher on changes and on reconnect.
   */
  function readAndSendTasks() {
    if (!ctx.wsClient?.isConnected() || !ctx.claudeSessionId) {
      debug(
        `readAndSendTasks: skipped (connected=${ctx.wsClient?.isConnected()}, ccSessionId=${ctx.claudeSessionId?.slice(0, 8)})`,
      )
      return
    }
    try {
      // Read tasks from ALL candidate dirs - pick the one with actual .json files
      let tasksDir: string | null = null
      for (const dir of ctx.taskCandidateDirs) {
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
      if (json !== ctx.lastTasksJson) {
        ctx.lastTasksJson = json
        const msg: TasksUpdate = { type: 'tasks_update', conversationId: ctx.claudeSessionId, tasks }
        ctx.wsClient?.send(msg)
        debug(`Tasks updated: ${tasks.length} tasks (dir: ${tasksDir?.split('/').pop()?.slice(0, 8)})`)
        diag('tasks', `Sent ${tasks.length} tasks`, { dir: tasksDir?.split('/').pop() })
      }
    } catch (err) {
      debug(`readAndSendTasks error: ${err}`)
      diag('tasks', `Read error: ${err}`, { dirs: ctx.taskCandidateDirs.map(d => d.split('/').pop()) })
    }
  }

  /**
   * Watch ~/.claude/tasks/ for task state changes using chokidar
   */
  function startTaskWatching() {
    if (ctx.taskWatcher) return
    const tasksBase = join(homedir(), '.claude', 'tasks')
    // Watch both Claude's session ID dir and our internal ID dir (they may differ)
    const candidates = new Set<string>()
    if (ctx.claudeSessionId) candidates.add(join(tasksBase, ctx.claudeSessionId))
    candidates.add(join(tasksBase, conversationId))
    ctx.taskCandidateDirs = Array.from(candidates)

    const watchPaths = ctx.taskCandidateDirs.map(d => join(d, '*.json'))
    debug(`Task watcher dirs: ${ctx.taskCandidateDirs.map(d => d.split('/').pop()).join(', ')}`)
    ctx.taskWatcher = chokidarWatch(watchPaths, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    })
    ctx.taskWatcher.on('add', readAndSendTasks)
    ctx.taskWatcher.on('change', readAndSendTasks)
    ctx.taskWatcher.on('unlink', readAndSendTasks)
    // Also poll periodically in case chokidar misses events (e.g. dir created after watcher)
    const pollInterval = setInterval(() => readAndSendTasks(), 5000)
    ctx.taskWatcher.on('close', () => clearInterval(pollInterval))
    diag('watch', 'Task watcher started', { dirs: ctx.taskCandidateDirs.map(d => d.split('/').pop()), watchPaths })
  }

  // Wire up task/project watching on context
  ctx.startTaskWatching = startTaskWatching
  ctx.readTasks = readAndSendTasks

  /**
   * Send project_changed to broker with full task list.
   * Called by chokidar watcher (debounced) and directly by MCP tool callbacks.
   */
  function sendProjectChanged() {
    if (!ctx.wsClient?.isConnected() || !ctx.claudeSessionId) return
    const tasks = listProjectTasks(cwd)
    ctx.wsClient.send({
      type: 'project_changed',
      sessionId: ctx.claudeSessionId,
      notes: tasks,
    } as unknown as AgentHostMessage)
    debug(`Project tasks changed: ${tasks.length} tasks`)
  }

  /**
   * Watch .rclaude/project/ for task changes (created by dashboard, Claude, or manually).
   * Debounces and sends project_changed to broker so dashboard can refresh.
   */
  let projectDebounce: ReturnType<typeof setTimeout> | null = null
  const PROJECT_TASK_PATTERN = new RegExp(`\\.rclaude/project/(${TASK_STATUS_PATTERN})/.+\\.md$`)

  function startProjectWatching() {
    if (ctx.projectWatcher) return
    const projectDir = join(cwd, '.rclaude', 'project')
    ctx.projectWatcher = chokidarWatch(join(projectDir, '**', '*.md'), {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      depth: 2,
    })

    function onProjectTaskChange(path: string) {
      if (!PROJECT_TASK_PATTERN.test(path)) return
      if (projectDebounce) clearTimeout(projectDebounce)
      projectDebounce = setTimeout(() => {
        projectDebounce = null
        sendProjectChanged()
      }, 300)
    }

    ctx.projectWatcher.on('add', onProjectTaskChange)
    ctx.projectWatcher.on('change', onProjectTaskChange)
    ctx.projectWatcher.on('unlink', onProjectTaskChange)
    // Poll fallback in case chokidar misses events (e.g. dir created after watcher, Bun quirks)
    let lastProjectHash = ''
    const projectPollInterval = setInterval(() => {
      try {
        const tasks = listProjectTasks(cwd)
        const hash = tasks.map(t => `${t.slug}:${t.status}`).join('|')
        if (lastProjectHash && hash !== lastProjectHash) {
          sendProjectChanged()
        }
        lastProjectHash = hash
      } catch {}
    }, 5000)
    ctx.projectWatcher.on('close', () => clearInterval(projectPollInterval))
    debug('Project watcher started')
  }

  // Wire up project watching
  ctx.startProjectWatching = startProjectWatching
  ctx.sendProjectChanged = sendProjectChanged

  function connectToBroker(ccSessionId: string | null) {
    if (noBroker || ctx.wsClient) return

    // Build capabilities list -- boot_stream advertises that we send early
    // boot events before the CC session id is known.
    const replEnabled = process.env.CLAUDE_CODE_REPL === 'true'
    const capabilities = [
      ...(!noTerminal ? ['terminal' as const] : []),
      ...(channelEnabled ? ['channel' as const] : []),
      ...(headless ? (['headless', 'json_stream'] as const) : []),
      ...(isAdHoc ? ['ad-hoc' as const] : []),
      ...(replEnabled ? ['repl' as const] : []),
      'boot_stream' as const,
      'config_rw' as const,
    ]

    /**
     * Execute a high-level control verb against the local CC process. Shared
     * entry point for:
     *   - dashboard input: user types a bare `/clear`, `/quit`, `:q`, `/model X`
     *   - dashboard control buttons (quit / interrupt)
     *   - inter-session MCP `control_session` tool
     * Backend-specific: headless uses typed methods (kill+respawn, sendSetModel,
     * closeStdin), PTY writes the raw slash command into CC's CLI input layer.
     */
    function executeControl(
      action: 'clear' | 'quit' | 'interrupt' | 'set_model' | 'set_effort' | 'set_permission_mode',
      args: { model?: string; effort?: string; permissionMode?: string; source?: string } = {},
    ): boolean {
      const source = args.source || 'unknown'
      if (headless) {
        if (!ctx.streamProc) return false
        switch (action) {
          case 'clear':
            diag('session', `Clear requested (${source}) - killing CC and respawning fresh`)
            // Start a fresh launch timeline BEFORE killing. New launchId groups
            // every subsequent event (process_killed, mcp_reset, ..., ready)
            // into the reboot card in the dashboard.
            beginLaunch(ctx, 'reboot')
            emitLaunchEvent(ctx, 'clear_requested', { detail: source })
            ctx.streamProc.kill()
            ctx.clearRequested = true
            return true
          case 'quit': {
            diag('session', `Quit requested (${source}) - closing stdin for graceful shutdown`)
            const closed = ctx.streamProc.closeStdin()
            if (closed) {
              // Safety net: SIGTERM if CC doesn't exit within 10s
              const proc = ctx.streamProc
              setTimeout(() => {
                if (!proc.proc.killed) {
                  diag('session', 'CC still alive 10s after stdin close - sending SIGTERM')
                  proc.kill()
                }
              }, 10_000)
            } else {
              diag('session', 'Stdin close failed - falling back to SIGTERM')
              ctx.streamProc.kill()
            }
            return true
          }
          case 'interrupt':
            diag('session', `Interrupt requested (${source})`)
            ctx.streamProc.sendInterrupt()
            return true
          case 'set_model':
            if (!args.model) return false
            diag('session', `Set model requested (${source}): ${args.model}`)
            ctx.streamProc.sendSetModel(args.model)
            return true
          case 'set_effort':
            if (!args.effort) return false
            diag('session', `Set effort requested (${source}): ${args.effort}`)
            ctx.streamProc.sendSetEffort(args.effort)
            return true
          case 'set_permission_mode':
            if (!args.permissionMode) return false
            diag('session', `Set permission mode requested (${source}): ${args.permissionMode}`)
            ctx.streamProc.sendSetPermissionMode(args.permissionMode)
            return true
        }
      }

      // PTY mode
      if (!ctx.ptyProcess) return false
      switch (action) {
        case 'clear':
          diag('session', `Clear requested (${source}) - injecting /clear via PTY`)
          // PTY /clear: CC handles kill+respawn internally. We only see the
          // downstream SessionStart hook with the new id. Still emit the
          // requested step + mark a fresh launch so the rekey lands in the
          // right card. No process_killed / mcp_reset etc. (CC is opaque).
          beginLaunch(ctx, 'reboot')
          emitLaunchEvent(ctx, 'clear_requested', { detail: `${source} (pty)` })
          ctx.ptyProcess.write('/clear\r')
          return true
        case 'quit':
          diag('session', `Quit requested (${source}) - sending SIGTERM to PTY`)
          ctx.ptyProcess.kill('SIGTERM')
          return true
        case 'interrupt':
          diag('session', `Interrupt requested (${source}) - sending Ctrl+C to PTY`)
          ctx.ptyProcess.write('\x03')
          return true
        case 'set_model':
          if (!args.model) return false
          diag('session', `Set model requested (${source}): ${args.model}`)
          ctx.ptyProcess.write(`/model ${args.model}\r`)
          return true
        case 'set_effort':
          if (!args.effort) return false
          diag('session', `Set effort requested (${source}): ${args.effort}`)
          ctx.ptyProcess.write(`/effort ${args.effort}\r`)
          return true
        case 'set_permission_mode':
          if (!args.permissionMode) return false
          diag('session', `Set permission mode not supported in PTY mode (${source}): ${args.permissionMode}`)
          return false
      }
    }

    ctx.wsClient = createWsClient({
      brokerUrl,
      brokerSecret,
      ccSessionId: ccSessionId,
      conversationId: conversationId,
      cwd,
      configuredModel,
      args: claudeArgs,
      claudeVersion,
      claudeAuth,
      spinnerVerbs,
      autocompactPct: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
        ? Number(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)
        : undefined,
      maxBudgetUsd: process.env.RCLAUDE_MAX_BUDGET_USD ? Number(process.env.RCLAUDE_MAX_BUDGET_USD) : undefined,
      adHocTaskId,
      adHocWorktree,
      capabilities,
      initialBoot: ccSessionId
        ? undefined
        : {
            claudeArgs,
            title: process.env.CLAUDWERK_CONVERSATION_NAME || undefined,
            description: process.env.CLAUDWERK_CONVERSATION_DESCRIPTION || undefined,
            // launchConfig is stored on the broker at spawn time (keyed
            // by conversationId) -- the broker merges it into the session on
            // promote, so we don't need to duplicate it here.
          },
      onConnected() {
        diag('ws', 'Connected to broker', { ccSessionId: ccSessionId ?? 'boot' })
        // Flush buffered diag entries
        flushDiag()
        // Flush queued events (drop if still no session id -- hooks don't fire
        // during boot phase, but defensive)
        if (ccSessionId) {
          for (const event of ctx.eventQueue) {
            ctx.wsClient?.sendHookEvent({ ...event, conversationId })
          }
          ctx.eventQueue.length = 0
        }
        // Flush pending session name (queued before WS connected)
        if (ctx.pendingConversationName && ctx.wsClient) {
          ctx.wsClient.send({
            type: 'conversation_name',
            conversationId: ctx.claudeSessionId || conversationId,
            name: ctx.pendingConversationName.name,
            userSet: ctx.pendingConversationName.userSet,
            description: ctx.pendingConversationName.description,
          } as AgentHostMessage)
          ctx.pendingConversationName = undefined
        }
        // Re-send transcript from JSONL file (repopulates broker cache after restart)
        if (headless) resendTranscriptFromFile(ctx)
        // Replay buffered launch events so late subscribers see the full timeline.
        replayLaunchEvents(ctx)
        // Replay every outstanding user interaction (permission / ask / dialog / plan).
        // Broker in-memory pending* state is lost on restart; the wrapper is
        // the authoritative holder, so a reconnect rehydrates the broker.
        replayInteractions(ctx)
        // Start polling task files + watching task notes
        startTaskWatching()
        startProjectWatching()
      },
      onDisconnected() {
        debug('Disconnected from broker')
      },
      onError(error) {
        debug(`Broker error: ${error.message}`)
      },
      onInput(input, crDelay) {
        // Headless mode: typed methods, no PTY handler
        if (headless) {
          if (!ctx.streamProc || !input) return
          const trimmed = input.trimEnd()
          // Legacy safety net: older dashboards (and scripts) may still send
          // bare slash commands via `send_input`. The dashboard now translates
          // these into `session_control` up-front, but we keep interception
          // here so a bare /clear typed in either path still works.
          if (trimmed === '/exit' || trimmed === '/quit' || trimmed === ':q' || trimmed === ':q!') {
            executeControl('quit', { source: 'headless-input' })
          } else if (trimmed === '/clear') {
            executeControl('clear', { source: 'headless-input' })
          } else if (trimmed.startsWith('/model ')) {
            const model = trimmed.slice(7).trim()
            if (model) executeControl('set_model', { model, source: 'headless-input' })
          } else if (trimmed.startsWith('/effort ')) {
            const effort = trimmed.slice(8).trim()
            if (effort) executeControl('set_effort', { effort, source: 'headless-input' })
          } else if (trimmed.startsWith('/mode ')) {
            const mode = trimmed.slice(6).trim()
            if (mode) executeControl('set_permission_mode', { permissionMode: mode, source: 'headless-input' })
          } else if (trimmed === '/plan') {
            executeControl('set_permission_mode', { permissionMode: 'plan', source: 'headless-input' })
          } else {
            ctx.streamProc.sendUserMessage(input)
          }
          return
        }

        if (!ctx.ptyProcess) return

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
                if (ctx.ptyProcess) {
                  const trimmed = input.replace(/[\r\n]+$/, '')
                  ctx.ptyProcess.write(trimmed)
                  setTimeout(() => ctx.ptyProcess?.write('\r'), 150)
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
          ctx.ptyProcess.write(trimmed)
          setTimeout(() => {
            ctx.ptyProcess?.write('\r')
            setTimeout(() => ctx.ptyProcess?.write('\r'), singleCrDelay)
          }, singlePreDelay)
        } else {
          // Multiline: chunk line-by-line inside bracketed paste, then submit
          // Delays scale with input size so large pastes don't outrun the PTY
          const perLineDelay = Math.min(50, Math.max(20, lines.length > 50 ? 50 : 20))
          ctx.ptyProcess.write('\x1b[200~')
          lines.forEach((line, i) => {
            setTimeout(() => {
              if (!ctx.ptyProcess) return
              ctx.ptyProcess.write(i > 0 ? `\n${line}` : line)
              if (i === lines.length - 1) {
                // End bracketed paste, then wait for PTY to process before sending Enter
                const settleDelay = crDelay != null ? crDelay : Math.min(500, Math.max(100, lines.length * 2))
                setTimeout(() => {
                  ctx.ptyProcess?.write('\x1b[201~')
                  setTimeout(() => {
                    ctx.ptyProcess?.write('\r')
                    setTimeout(() => ctx.ptyProcess?.write('\r'), multiSettleBase)
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
        if (ctx.ptyProcess) {
          ctx.ptyProcess.write(data)
        }
      },
      onTerminalAttach(cols, rows) {
        ctx.terminalAttached = true
        // Save local terminal size before remote viewer takes over
        savedTerminalSize = getTerminalSize()
        debug(
          `Terminal attached (${cols}x${rows}), saved local size (${savedTerminalSize.cols}x${savedTerminalSize.rows})`,
        )
        if (ctx.ptyProcess) {
          // Resize triggers SIGWINCH internally, which repaints most apps.
          // Double-tap: resize to 1 col smaller first, then to actual size.
          // This guarantees a size change even if browser matches current PTY size,
          // forcing a full repaint from Claude Code / Ink / vim / etc.
          ctx.ptyProcess.resize(Math.max(1, cols - 1), rows)
          setTimeout(() => {
            ctx.ptyProcess?.resize(cols, rows)
            // Extra SIGWINCH as fallback for apps that ignore resize
            setTimeout(() => ctx.ptyProcess?.redraw(), 100)
          }, 50)
        }
      },
      onTerminalDetach() {
        ctx.terminalAttached = false
        // Restore local terminal size
        if (savedTerminalSize && ctx.ptyProcess) {
          ctx.ptyProcess.resize(savedTerminalSize.cols, savedTerminalSize.rows)
          debug(`Terminal detached, restored to ${savedTerminalSize.cols}x${savedTerminalSize.rows}`)
          savedTerminalSize = null
        } else {
          debug('Terminal detached')
        }
      },
      onJsonStreamAttach() {
        ctx.jsonStreamAttached = true
        debug(`JSON stream attached, sending ${ctx.jsonStreamBuffer.length} backfill lines`)
        if (ctx.wsClient?.isConnected() && ctx.jsonStreamBuffer.length > 0) {
          ctx.wsClient.sendJsonStreamData(ctx.jsonStreamBuffer.slice(-100), true)
        }
      },
      onJsonStreamDetach() {
        ctx.jsonStreamAttached = false
        debug('JSON stream detached')
      },
      onTerminalResize(cols, rows) {
        if (ctx.ptyProcess) {
          ctx.ptyProcess.resize(cols, rows)
        }
        debug(`Terminal resized to ${cols}x${rows}`)
      },
      onFileRequest(requestId, path) {
        // Read file from local filesystem and respond
        readFile(path)
          .then(buf => {
            const ext = path.split('.').pop()?.toLowerCase() || ''
            const mediaType = extToMediaType(ext)
            ctx.wsClient?.sendFileResponse(requestId, buf.toString('base64'), mediaType)
            debug(`File response: ${path} (${buf.length} bytes)`)
          })
          .catch(err => {
            ctx.wsClient?.sendFileResponse(requestId, undefined, undefined, String(err))
            debug(`File request failed: ${path} - ${err}`)
          })
      },
      onFileEditorMessage(msg) {
        handleFileEditorMessage(ctx, msg)
      },
      onAck() {
        // Broker has processed our meta message and registered the socket.
        // This is the correct signal to resend state (not an arbitrary timeout).
        if (ctx.transcriptWatcher) {
          debug('Ack received, re-sending transcript')
          ctx.transcriptWatcher.resend().catch(err => debug(`Resend failed: ${err}`))
        }
        ctx.lastTasksJson = ''
        readAndSendTasks()
      },
      onConfigUpdated() {
        permissionRules.reload()
        diag('info', 'Permission rules reloaded (notify_config_updated)')
      },
      onConfigGet(requestId: string) {
        const cfgPath = join(cwd, '.rclaude', 'rclaude.json')
        try {
          const raw = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8') : null
          ctx.wsClient?.send({
            type: 'rclaude_config_data',
            requestId,
            config: raw ? JSON.parse(raw) : null,
            path: cfgPath,
            cwd,
          } as unknown as AgentHostMessage)
        } catch {
          ctx.wsClient?.send({
            type: 'rclaude_config_data',
            requestId,
            config: null,
            path: cfgPath,
            cwd,
          } as unknown as AgentHostMessage)
        }
      },
      onConfigSet(requestId: string, config: import('../shared/protocol').RclaudePermissionConfig) {
        const cfgPath = join(cwd, '.rclaude', 'rclaude.json')
        try {
          const dir = join(cwd, '.rclaude')
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          const withSchema = {
            $schema: 'https://raw.githubusercontent.com/claudification/claudewerk/main/schemas/rclaude.schema.json',
            ...config,
          }
          writeFileSync(cfgPath, `${JSON.stringify(withSchema, null, 2)}\n`)
          ctx.wsClient?.send({ type: 'rclaude_config_ok', requestId, ok: true } as unknown as AgentHostMessage)
        } catch (err) {
          ctx.wsClient?.send({
            type: 'rclaude_config_ok',
            requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          } as unknown as AgentHostMessage)
        }
      },
      onTranscriptKick() {
        // Broker detected we have events but no transcript - retry the watcher
        if (!ctx.transcriptWatcher && ctx.parentTranscriptPath) {
          debug(`Transcript kick received - retrying watcher for: ${ctx.parentTranscriptPath}`)
          diag('info', 'Transcript kick - retrying watcher', { path: ctx.parentTranscriptPath })
          // Re-run the same retry logic with a fresh 15min timeout
          async function retryTranscriptWatcher(path: string) {
            let delay = 500
            const maxDelay = 10_000
            const maxTotal = 900_000
            let elapsed = 0
            while (elapsed < maxTotal) {
              if (existsSync(path)) {
                debug(`Transcript file found after kick: ${path}`)
                startTranscriptWatcher(ctx, path)
                return
              }
              await new Promise(r => setTimeout(r, delay))
              elapsed += delay
              delay = Math.min(delay * 2, maxDelay)
            }
            diag('error', 'Transcript file still not found after kick', { path })
          }
          retryTranscriptWatcher(ctx.parentTranscriptPath).catch(err => {
            debug(`retryTranscriptWatcher error: ${err instanceof Error ? err.message : err}`)
          })
        } else if (ctx.transcriptWatcher) {
          debug('Transcript kick received but watcher already running')
        } else {
          debug('Transcript kick received but no transcript path known')
        }
      },
      onChannelConversationsList(sessions, self) {
        pendingListConversations?.(sessions, self)
      },
      onChannelSendResult(result) {
        pendingSendResult?.(
          result as { ok: boolean; error?: string; conversationId?: string; targetSessionId?: string },
        )
      },
      onChannelReviveResult(result) {
        pendingReviveResult?.(result)
      },
      onChannelRestartResult(result) {
        pendingRestartResult?.(result)
      },
      onChannelSpawnResult(result) {
        if (result.requestId && pendingSpawnRequestId && result.requestId !== pendingSpawnRequestId) {
          diag(
            'channel',
            `Ignoring stale channel_spawn_result (expected=${pendingSpawnRequestId.slice(0, 8)}, got=${result.requestId.slice(0, 8)})`,
          )
          return
        }
        pendingSpawnResult?.(result)
      },
      onSpawnDiagnosticsResult(result) {
        if (!result.jobId) return
        const resolver = pendingSpawnDiagnostics.get(result.jobId)
        if (!resolver) return
        pendingSpawnDiagnostics.delete(result.jobId)
        resolver(result)
      },
      onLaunchJobEvent(event) {
        const jobId = typeof event.jobId === 'string' ? event.jobId : undefined
        if (!jobId) return
        launchJobListeners.get(jobId)?.(event)
      },
      onChannelConfigureResult(result) {
        pendingConfigureResult?.(result)
      },
      onChannelRenameResult(result) {
        pendingRenameResult?.(result)
      },
      onConversationControlResult(result) {
        pendingControlResult?.(result)
      },
      onChannelDeliver(delivery) {
        if (headless && ctx.streamProc) {
          // Headless mode: deliver inter-session messages via stdin as <channel> tags (no conduit wrapper)
          const attrs = [
            `sender="session"`,
            `from_session="${delivery.fromSession}"`,
            `from_project="${delivery.fromProject}"`,
            `intent="${delivery.intent}"`,
            ...(delivery.conversationId ? [`conversation_id="${delivery.conversationId}"`] : []),
          ].join(' ')
          const wrapped = `<channel ${attrs}>\n${delivery.message}\n</channel>`
          ctx.streamProc.sendUserMessage(wrapped)
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
        clearInteraction(ctx, requestId)
        if (headless && ctx.streamProc) {
          // Headless: respond via control_response on stdin
          ctx.streamProc.sendPermissionResponse(requestId, behavior === 'allow', undefined, toolUseId)
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
        clearInteraction(ctx, toolUseId)
        // Headless: resolve via control_response to CC's can_use_tool request
        const pending = ctx.pendingAskRequests.get(toolUseId)
        if (pending && headless && ctx.streamProc) {
          ctx.pendingAskRequests.delete(toolUseId)
          if (skip || !answers) {
            ctx.streamProc.sendPermissionResponse(pending.requestId, false, undefined, toolUseId)
            diag('headless', `AskUserQuestion skipped: ${toolUseId.slice(0, 12)}`)
          } else {
            ctx.streamProc.sendPermissionResponse(
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
        clearInteraction(ctx, dialogId)
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
      onPlanApprovalResponse(requestId, action, feedback, toolUseId) {
        if (!headless || !ctx.streamProc) return
        clearInteraction(ctx, requestId)

        const sessionId = ctx.claudeSessionId || ctx.conversationId
        if (action === 'approve') {
          ctx.streamProc.sendPermissionResponse(requestId, true, undefined, toolUseId)
          diag('plan', `Plan approved: ${requestId.slice(0, 8)}`)
        } else if (action === 'feedback') {
          ctx.streamProc.sendPermissionResponse(requestId, true, { feedback: feedback || '' }, toolUseId)
          diag('plan', `Plan approved with feedback: ${requestId.slice(0, 8)}`)
        } else {
          ctx.streamProc.sendPermissionResponse(requestId, false, undefined, toolUseId)
          diag('plan', `Plan rejected: ${requestId.slice(0, 8)}`)
        }
        // Broadcast plan mode exit
        if (ctx.wsClient?.isConnected()) {
          ctx.wsClient.send({
            type: 'plan_mode_changed',
            sessionId,
            planMode: false,
          } as unknown as AgentHostMessage)
        }
      },
      onRendezvousResult(message: Record<string, unknown>) {
        const msgType = message.type as string
        const ccSessionId = message.sessionId as string | undefined
        const cwd = message.cwd as string | undefined
        const error = message.error as string | undefined
        const isReady = msgType === 'spawn_ready' || msgType === 'revive_ready' || msgType === 'restart_ready'
        const action = msgType.startsWith('spawn') ? 'spawn' : msgType.startsWith('restart') ? 'restart' : 'revive'

        if (isReady) {
          diag('rendezvous', `${action} ready: session=${ccSessionId?.slice(0, 8)} cwd=${cwd}`)
        } else {
          diag('rendezvous', `${action} timeout: ${error || 'unknown'}`)
        }

        // Resolve pending spawn/revive promise if one exists
        const pending = pendingRendezvous.get(message.conversationId as string)
        if (pending) {
          pendingRendezvous.delete(message.conversationId as string)
          if (isReady) {
            pending.resolve(message)
          } else {
            pending.reject(error || `${action} timed out`)
          }
        }

        // Also push to channel so Claude sees the result
        if (channelEnabled && isMcpChannelReady()) {
          const text = isReady
            ? `Session ${action === 'spawn' ? 'spawned' : 'revived'}: ${cwd?.split('/').pop() || ccSessionId?.slice(0, 8)} (${ccSessionId?.slice(0, 8)})`
            : `Session ${action} timed out: ${error || 'no response within timeout'}`
          pushChannelMessage(text, {
            sender: 'system',
            [`${action}_result`]: isReady ? 'ready' : 'timeout',
            ...(ccSessionId ? { target_session: ccSessionId } : {}),
          }).catch(() => {})
        }
      },
      onPermissionRule(toolName: string, behavior: 'allow' | 'deny') {
        if (behavior === 'allow') {
          permissionRules.addConversationRule(toolName)
          diag('channel', `Auto-approve rule added: ${toolName}`)
        } else {
          permissionRules.removeConversationRule(toolName)
          diag('channel', `Auto-approve rule removed: ${toolName}`)
        }
      },
      onQuitConversation() {
        executeControl('quit', { source: 'dashboard-quit' })
      },
      onInterrupt() {
        executeControl('interrupt', { source: 'dashboard-interrupt' })
      },
      onControl(action, args) {
        const source = args.fromSession ? `inter-session:${args.fromSession.slice(0, 8)}` : 'control-channel'
        const ok = executeControl(action, {
          model: args.model,
          effort: args.effort,
          permissionMode: args.permissionMode,
          source,
        })
        if (!ok) diag('session', `Control ignored: ${action} (backend not ready or missing args)`)
      },
      onDiag(type, msg, args) {
        diag(type, msg, args)
      },
    })
  }

  // Wire up connectToBroker on context
  ctx.connectToBroker = connectToBroker

  let devChannelConfirmed = false
  const osc52Parser = new Osc52Parser()
  diag('channel', `MCP enabled (channel input: ${channelEnabled})`)
  initMcpChannel(
    {
      onNotify(message, title) {
        diag('channel', `Notify: ${title ? `[${title}] ` : ''}${message.slice(0, 80)}`)
        if (ctx.wsClient?.isConnected()) {
          ctx.wsClient.send({ type: 'notify', conversationId: ctx.claudeSessionId || conversationId, message, title })
        }
      },
      async onShareFile(filePath) {
        // Upload file to broker blob store, get public URL back
        // SECURITY: restrict to files within the session CWD
        if (!isPathWithinCwd(filePath, cwd)) {
          debug(`[channel] share_file: path outside CWD: ${filePath}`)
          return null
        }
        const httpUrl = noBroker ? null : wsToHttpUrl(brokerUrl)
        if (!httpUrl) return null
        try {
          const file = Bun.file(filePath)
          if (!(await file.exists())) {
            debug(`[channel] share_file: file not found: ${filePath}`)
            return null
          }
          // Stream the file -- Bun handles BunFile (Blob) as fetch body natively
          const contentType = file.type || 'application/octet-stream'
          const res = await fetch(`${httpUrl}/api/files`, {
            method: 'POST',
            headers: {
              'Content-Type': contentType,
              'X-Session-Id': ctx.claudeSessionId || conversationId,
              ...(brokerSecret ? { Authorization: `Bearer ${brokerSecret}` } : {}),
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
      async onListConversations(status, showMetadata) {
        if (!ctx.wsClient?.isConnected()) return { sessions: [] }
        return new Promise(resolve => {
          const timeout = setTimeout(() => resolve({ sessions: [] }), 5000)
          pendingListConversations = (sessions, self) => {
            clearTimeout(timeout)
            pendingListConversations = null
            resolve({ sessions, self })
          }
          ctx.wsClient?.send({
            type: 'channel_list_sessions',
            status,
            show_metadata: showMetadata,
          } as unknown as AgentHostMessage)
        })
      },
      async onSendMessage(to, intent, message, context, conversationId) {
        if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected' }
        return new Promise(resolve => {
          const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 10000)
          pendingSendResult = result => {
            clearTimeout(timeout)
            pendingSendResult = null
            resolve(result)
          }
          ctx.wsClient?.send({
            type: 'channel_send',
            fromSession: ctx.claudeSessionId || conversationId,
            toSession: to,
            intent,
            message,
            context,
            conversationId,
          } as unknown as AgentHostMessage)
        })
      },
      onPermissionRequest(data) {
        // Check auto-approve rules before forwarding to dashboard
        if (permissionRules.shouldAutoApprove(data.toolName, data.inputPreview)) {
          if (headless && ctx.streamProc) {
            ctx.streamProc.sendPermissionResponse(data.requestId, true)
          } else {
            sendPermissionResponse(data.requestId, 'allow').catch(err => {
              debug(`sendPermissionResponse (auto) error: ${err instanceof Error ? err.message : err}`)
            })
          }
          diag(headless ? 'headless' : 'channel', `Permission auto-approved: ${data.requestId} ${data.toolName}`)
          // Notify dashboard for visibility (not for approval)
          if (ctx.wsClient?.isConnected()) {
            ctx.wsClient.send({
              type: 'permission_auto_approved',
              sessionId: ctx.claudeSessionId || conversationId,
              requestId: data.requestId,
              toolName: data.toolName,
              description: data.description,
            } as unknown as AgentHostMessage)
          }
          return
        }

        diag('channel', `Permission request: ${data.requestId} ${data.toolName}`)
        sendInteraction(ctx, 'permission_request', data.requestId, {
          type: 'permission_request',
          conversationId: ctx.claudeSessionId || conversationId,
          requestId: data.requestId,
          toolName: data.toolName,
          description: data.description,
          inputPreview: data.inputPreview,
        })
      },
      onDialogShow(dialogId, layout) {
        diag('dialog', `Show: "${layout.title}" (${dialogId.slice(0, 8)})`)
        sendInteraction(ctx, 'dialog_show', dialogId, {
          type: 'dialog_show',
          sessionId: ctx.claudeSessionId || conversationId,
          dialogId,
          layout,
        } as unknown as AgentHostMessage)
      },
      onDialogDismiss(dialogId) {
        diag('dialog', `Dismiss: ${dialogId.slice(0, 8)}`)
        clearInteraction(ctx, dialogId)
        ctx.wsClient?.send({
          type: 'dialog_dismiss',
          sessionId: ctx.claudeSessionId || conversationId,
          dialogId,
        } as unknown as AgentHostMessage)
      },
      onDeliverMessage(content, meta) {
        if (headless && ctx.streamProc) {
          // Headless: deliver as <channel> tag on stdin
          const attrs = Object.entries(meta)
            .map(([k, v]) => `${k}="${v}"`)
            .join(' ')
          const wrapped = `<channel ${attrs}>\n${content}\n</channel>`
          ctx.streamProc.sendUserMessage(wrapped)
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
          if (ctx.streamProc) {
            diag('channel', 'toggle_plan_mode: sending set_permission_mode via control_request')
            ctx.streamProc.sendSetPermissionMode('plan')
          }
        } else {
          diag('channel', 'toggle_plan_mode: injecting /plan via PTY')
          if (ctx.ptyProcess) ctx.ptyProcess.write('/plan\r')
        }
      },
      async onReviveConversation(targetConversationId) {
        if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected to broker' }
        return new Promise(resolve => {
          const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 10000)
          pendingReviveResult = result => {
            clearTimeout(timeout)
            pendingReviveResult = null
            resolve(result)
          }
          ctx.wsClient?.send({
            type: 'channel_revive',
            sessionId: targetConversationId,
          } as unknown as AgentHostMessage)
        })
      },
      async onSpawnConversation({ onProgress, ...spawnParams }) {
        if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected to broker' }

        // Step 1: Send spawn request via WS, get immediate ack with conversationId + jobId.
        // requestId correlates ack to this specific request, preventing stale
        // channel_spawn_result messages from resolving the wrong promise.
        const requestId = randomUUID()
        const spawnResult = await new Promise<{ ok: boolean; error?: string; conversationId?: string; jobId?: string }>(
          resolve => {
            const timeout = setTimeout(() => {
              if (pendingSpawnRequestId === requestId) {
                pendingSpawnResult = null
                pendingSpawnRequestId = null
              }
              resolve({ ok: false, error: 'Timeout' })
            }, 15000)
            pendingSpawnRequestId = requestId
            pendingSpawnResult = result => {
              clearTimeout(timeout)
              pendingSpawnResult = null
              pendingSpawnRequestId = null
              resolve(result)
            }
            ctx.wsClient?.send({
              type: 'channel_spawn',
              requestId,
              ...spawnParams,
            } as unknown as AgentHostMessage)
          },
        )

        if (!spawnResult.ok) return spawnResult

        const jobId = spawnResult.jobId
        diag(
          'channel',
          `spawn_session: ${spawnParams.cwd} mode=${spawnParams.mode || 'default'} conversationId=${spawnResult.conversationId?.slice(0, 8)} job=${jobId?.slice(0, 8)}`,
        )

        // Subscribe to job progress now that we have the server-generated jobId.
        // Early events (job_created, spawn_sent) are buffered on the job and
        // available via get_spawn_diagnostics -- the progress pump here is
        // best-effort for live MCP notifications.
        if (jobId && onProgress) {
          launchJobListeners.set(jobId, onProgress)
          ctx.wsClient?.send({ type: 'subscribe_job', jobId } as unknown as AgentHostMessage)
        }

        const cleanupJob = () => {
          if (!jobId) return
          launchJobListeners.delete(jobId)
          ctx.wsClient?.send({ type: 'unsubscribe_job', jobId } as unknown as AgentHostMessage)
        }

        // Step 2: Await rendezvous (broker sends spawn_ready/spawn_timeout when session connects).
        // Must stay under CC's ~60s MCP tool timeout. The broker's own rendezvous is 120s
        // but we give up sooner and return timedOut so the MCP caller isn't left hanging.
        const SPAWN_RENDEZVOUS_MS = 45_000
        if (spawnResult.conversationId) {
          try {
            const wid = spawnResult.conversationId
            const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
              const timer = setTimeout(() => {
                pendingRendezvous.delete(wid)
                reject(new Error(`Rendezvous timeout (${SPAWN_RENDEZVOUS_MS / 1000}s)`))
              }, SPAWN_RENDEZVOUS_MS)
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
            cleanupJob()
            return { ok: true, conversationId: spawnResult.conversationId, jobId, session }
          } catch (err) {
            diag('channel', `spawn_session: rendezvous failed: ${err instanceof Error ? err.message : err}`)
            cleanupJob()
            return { ok: true, conversationId: spawnResult.conversationId, jobId, timedOut: true }
          }
        }

        cleanupJob()
        return { ok: true, conversationId: spawnResult.conversationId, jobId }
      },
      async onListHosts() {
        if (!ctx.wsClient?.isConnected()) return []
        try {
          const httpUrl = wsToHttpUrl(brokerUrl)
          const resp = await fetch(`${httpUrl}/api/sentinels`, {
            headers: { Authorization: `Bearer ${brokerSecret}` },
          })
          if (!resp.ok) return []
          const data = (await resp.json()) as Array<{
            alias: string
            hostname?: string
            connected: boolean
          }>
          return data.map(s => ({
            alias: s.alias,
            hostname: s.hostname,
            connected: s.connected,
            sessionCount: 0,
          }))
        } catch {
          return []
        }
      },
      async onGetSpawnDiagnostics(jobId) {
        if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected to broker' }
        return new Promise(resolve => {
          const timeout = setTimeout(() => {
            pendingSpawnDiagnostics.delete(jobId)
            resolve({ ok: false, error: 'Timeout waiting for diagnostics' })
          }, 10_000)
          pendingSpawnDiagnostics.set(jobId, result => {
            clearTimeout(timeout)
            resolve(result)
          })
          ctx.wsClient?.send({
            type: 'get_spawn_diagnostics',
            jobId,
          } as unknown as AgentHostMessage)
        })
      },
      async onRestartConversation(targetConversationId) {
        if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected to broker' }
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
          ctx.wsClient?.send({
            type: 'channel_restart',
            sessionId: targetConversationId,
          } as unknown as AgentHostMessage)
        })
      },
      async onControlSession({ conversationId: targetConversationId, action, model, effort }) {
        if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected to broker' }
        return new Promise(resolve => {
          const timeout = setTimeout(
            () => resolve({ ok: false, error: 'Timeout waiting for control confirmation' }),
            10000,
          )
          pendingControlResult = result => {
            clearTimeout(timeout)
            pendingControlResult = null
            resolve(result)
          }
          ctx.wsClient?.send({
            type: 'conversation_control',
            targetSession: targetConversationId,
            action,
            ...(model && { model }),
            ...(effort && { effort }),
            fromSession: ctx.claudeSessionId || conversationId,
          } as unknown as AgentHostMessage)
        })
      },
      async onConfigureConversation({
        conversationId: targetConversationId,
        label,
        icon,
        color,
        description,
        keyterms,
      }) {
        if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected to broker' }
        return new Promise(resolve => {
          const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 10000)
          pendingConfigureResult = result => {
            clearTimeout(timeout)
            pendingConfigureResult = null
            resolve(result)
          }
          ctx.wsClient?.send({
            type: 'channel_configure',
            sessionId: targetConversationId,
            label,
            icon,
            color,
            description,
            keyterms,
          } as unknown as AgentHostMessage)
        })
      },
      async onRenameConversation(name, description) {
        if (!ctx.wsClient?.isConnected()) return { ok: false, error: 'Not connected to broker' }
        const sessionId = ctx.claudeSessionId || ctx.conversationId
        return new Promise(resolve => {
          const timeout = setTimeout(() => resolve({ ok: false, error: 'Timeout' }), 10000)
          pendingRenameResult = result => {
            clearTimeout(timeout)
            pendingRenameResult = null
            resolve(result)
          }
          ctx.wsClient?.send({
            type: 'rename_conversation',
            sessionId,
            name,
            description,
          } as unknown as AgentHostMessage)
        })
      },
      onProjectChanged() {
        sendProjectChanged()
      },
      onExitConversation(status, message) {
        const detail = message ? `${status}: ${message}` : status
        beginLaunch(ctx, 'live')
        emitLaunchEvent(ctx, 'conversation_exit', {
          detail,
          raw: { status, message },
        })
        const endReason = status === 'error' ? `self_exit_error: ${message || 'unknown'}` : 'self_exit'
        if (ctx.claudeSessionId) {
          ctx.wsClient?.sendConversationEnd(endReason)
        }
        setTimeout(() => {
          cleanup()
          process.exit(status === 'error' ? 1 : 0)
        }, 500)
      },
    },
    {
      sessionId,
      conversationId: conversationId,
      cwd,
      configuredModel,
      headless,
      claudeVersion,
      claudeAuth,
    },
  )

  // Pending callbacks for inter-session request/response
  let pendingListConversations: ((sessions: ConversationInfo[], self?: Record<string, unknown>) => void) | null = null
  let pendingSendResult:
    | ((result: { ok: boolean; error?: string; conversationId?: string; targetSessionId?: string }) => void)
    | null = null
  let pendingReviveResult: ((result: { ok: boolean; error?: string; name?: string }) => void) | null = null
  let pendingRestartResult:
    | ((result: { ok: boolean; error?: string; name?: string; selfRestart?: boolean; alreadyEnded?: boolean }) => void)
    | null = null
  let pendingSpawnResult:
    | ((result: { ok: boolean; error?: string; conversationId?: string; requestId?: string }) => void)
    | null = null
  let pendingSpawnRequestId: string | null = null
  // Keyed by jobId so concurrent get_spawn_diagnostics calls don't trample each
  // other. Broker replies include the jobId so we can route back.
  const pendingSpawnDiagnostics = new Map<
    string,
    (result: { ok: boolean; jobId?: string; error?: string; diagnostics?: Record<string, unknown> }) => void
  >()
  // jobId -> listener for launch_progress / launch_log / job_complete /
  // job_failed events. Populated when an MCP spawn_session caller passes a
  // progressToken; cleared when the spawn resolves (either side of timeout).
  const launchJobListeners = new Map<string, (event: Record<string, unknown>) => void>()
  let pendingConfigureResult: ((result: { ok: boolean; error?: string }) => void) | null = null
  let pendingRenameResult: ((result: { ok: boolean; error?: string }) => void) | null = null
  let pendingControlResult: ((result: { ok: boolean; error?: string; name?: string }) => void) | null = null
  const pendingRendezvous = new Map<
    string,
    { resolve: (msg: Record<string, unknown>) => void; reject: (error: string) => void }
  >()

  // Wire debug logging into local server
  setLocalServerDebug(debug)

  // Start local HTTP server for hook callbacks + MCP endpoint (always enabled)
  const { server: localServer, port: localServerPort } = await startLocalServer({
    conversationId: conversationId,
    mcpEnabled: true,
    onHookEvent(event: HookEvent) {
      processHookEvent(ctx, event)
    },
    onNotify(message: string, title?: string) {
      const sid = ctx.claudeSessionId || conversationId
      debug(`Notify: ${title ? `[${title}] ` : ''}${message}`)
      if (ctx.wsClient?.isConnected()) {
        ctx.wsClient.send({ type: 'notify', conversationId: sid, message, title })
      }
    },
    onAskQuestion(request) {
      debug(`AskUserQuestion: ${request.questions.length} questions, toolUseId=${request.toolUseId.slice(0, 12)}`)
      sendInteraction(ctx, 'ask_question', request.toolUseId, {
        ...request,
        sessionId: ctx.claudeSessionId || conversationId,
      } as unknown as AgentHostMessage)
    },
    onAskTimeout(toolUseId: string) {
      clearInteraction(ctx, toolUseId)
    },
    hasDashboardSubscribers() {
      return ctx.wsClient?.isConnected() ?? false
    },
  })

  // Generate merged settings with hook injection (version-aware to avoid invalid keys)
  const settingsPath = await writeMergedSettings(conversationId, localServerPort, claudeVersion, rclaudeDir)

  // Connect to the broker NOW, before CC is spawned, so the dashboard
  // sees a "booting" session immediately and receives live boot events. The
  // real CC session id (from SessionStart hook or stream-json init) is
  // attached later via ctx.wsClient.setSessionId(). Launched under a
  // try/catch so a flaky WS never blocks the CC spawn.
  try {
    ctx.connectToBroker(null)
    ctx.wsClient?.sendBootEvent('wrapper_started', `cwd=${cwd} headless=${headless}`)
    ctx.wsClient?.sendBootEvent('settings_merged', settingsPath)
  } catch (err) {
    debug(`early connect failed: ${err instanceof Error ? err.message : err}`)
  }

  // Set terminal title to last 2 path segments (shows in tmux)
  setTerminalTitle(cwd)

  // Write system prompt additions for rclaude-specific behavior
  const promptFile = join(rclaudeDir, 'settings', `prompt-${conversationId}.txt`)
  writeFileSync(
    promptFile,
    buildSystemPrompt({
      channelEnabled,
      headless,
      identity: { sessionId, conversationId: conversationId, cwd, configuredModel, headless },
    }),
  )
  claudeArgs.push('--append-system-prompt', readFileSync(promptFile, 'utf-8'))

  // Spawn claude with PTY
  // Convert WS URL to HTTP for tools/scripts that need to call the broker REST API
  const brokerHttpUrl = noBroker ? undefined : wsToHttpUrl(brokerUrl)

  // Always inject MCP config (tools: notify, share_file, list_sessions, send_message, toggle_plan_mode)
  // Channel input (--dangerously-load-development-channels) only when channels enabled
  const mcpConfigPath = join(rclaudeDir, 'settings', `mcp-${conversationId}.json`)
  await Bun.write(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: { rclaude: { type: 'http', url: `http://localhost:${localServerPort}/mcp` } },
    }),
  )
  ctx.wsClient?.sendBootEvent('mcp_prepared', mcpConfigPath)
  // Auto-generate a funny session name unless user already specified --name/-n
  const hasUserName = claudeArgs.includes('--name') || claudeArgs.includes('-n')
  const isResuming = claudeArgs.includes('--resume') || claudeArgs.includes('-c')
  // Managed sessions (spawned/revived via agent) get a funny name even when resuming,
  // unless a name was already provided via CLAUDWERK_CONVERSATION_NAME (-> hasUserName).
  // User-initiated --resume skips name generation (existing session has one).
  const isManagedSession = !!(process.env.RCLAUDE_CONVERSATION_ID || process.env.RCLAUDE_WRAPPER_ID)
  const sessionName = hasUserName || (isResuming && !isManagedSession) ? undefined : generateFunnyName()

  // Resolve the actual name that will be sent to CC (user-provided via env, or auto-generated)
  const resolvedConversationName = process.env.CLAUDWERK_CONVERSATION_NAME || sessionName
  debug(`Session name: ${resolvedConversationName || '(none)'} (user=${!!process.env.CLAUDWERK_CONVERSATION_NAME})`)

  // Send session name to broker (immediately if connected, or deferred to onConnected)
  // Store on context so onConnected can send it after WS connects
  const sessionDescription = process.env.CLAUDWERK_CONVERSATION_DESCRIPTION || undefined
  ctx.pendingConversationName = resolvedConversationName
    ? {
        name: resolvedConversationName,
        userSet: !!process.env.CLAUDWERK_CONVERSATION_NAME,
        description: sessionDescription,
      }
    : undefined
  if (resolvedConversationName && ctx.wsClient?.isConnected()) {
    ctx.wsClient.send({
      type: 'conversation_name',
      conversationId: ctx.claudeSessionId || conversationId,
      name: resolvedConversationName,
      userSet: !!process.env.CLAUDWERK_CONVERSATION_NAME,
      description: sessionDescription,
    } as AgentHostMessage)
    ctx.pendingConversationName = undefined
  }

  const finalClaudeArgs = [
    '--mcp-config',
    mcpConfigPath,
    '--disallowed-tools',
    'SendMessage',
    ...(channelEnabled ? ['--dangerously-load-development-channels', 'server:rclaude'] : []),
    ...(sessionName ? ['--name', sessionName] : []),
    ...claudeArgs,
  ]

  let cleanupTerminal = () => {}

  if (headless) {
    // --- HEADLESS MODE: stream-json backend ---
    debug('Starting in HEADLESS mode (stream-json)')
    diag('headless', 'Stream-JSON backend active')

    const headlessSpawnOptions = buildHeadlessSpawnOptions({
      ctx,
      permissionRules,
      finalClaudeArgs,
      settingsPath,
      localServerPort,
      rclaudeDir,
      claudeVersion,
      mcpConfigPath,
      brokerUrl: brokerHttpUrl,
      brokerSecret,
      spawnStreamClaude,
      cleanup,
      env: Object.keys(customEnv).length ? customEnv : undefined,
      includePartialMessages,
    })

    ctx.wsClient?.sendBootEvent('claude_spawning', `headless ${finalClaudeArgs.length} args`)
    emitLaunchEvent(ctx, 'launch_started', {
      detail: `headless (${finalClaudeArgs.length} args)`,
      raw: {
        args: finalClaudeArgs,
        env: filterRelevantEnv(process.env, customEnv),
        cwd,
        headless: true,
        channelEnabled,
        mcpConfigPath,
        settingsPath,
      },
    })
    ctx.streamProc = spawnStreamClaude(headlessSpawnOptions)
    ctx.streamProc.forwardStdin()
    ctx.wsClient?.sendBootEvent('claude_started', `pid=${ctx.streamProc.proc.pid}`, {
      pid: ctx.streamProc.proc.pid,
    })
    ctx.wsClient?.sendBootEvent('awaiting_init', 'Waiting for stream-json system:init')

    // Send ad-hoc initial prompt (if RCLAUDE_INITIAL_PROMPT_FILE is set)
    sendAdHocPrompt(ctx)
  } else {
    // --- PTY MODE: existing behavior ---
    ctx.wsClient?.sendBootEvent('claude_spawning', `pty ${finalClaudeArgs.length} args`)
    emitLaunchEvent(ctx, 'launch_started', {
      detail: `pty (${finalClaudeArgs.length} args)`,
      raw: {
        args: finalClaudeArgs,
        env: filterRelevantEnv(process.env, customEnv),
        cwd,
        headless: false,
        channelEnabled,
        mcpConfigPath,
        settingsPath,
      },
    })
    const ptySpawnedAt = Date.now()
    try {
      ctx.ptyProcess = spawnClaude({
        args: finalClaudeArgs,
        settingsPath,
        conversationId: conversationId,
        localServerPort,
        brokerUrl: brokerHttpUrl,
        brokerSecret,
        env: Object.keys(customEnv).length ? customEnv : undefined,
        onData(data) {
          // Auto-confirm dev channel warning prompt (fires once on startup)
          if (channelEnabled && !devChannelConfirmed) {
            const plain = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b[=>?][0-9]*[a-zA-Z]/g, '')
            if (plain.includes('Entertoconfirm')) {
              devChannelConfirmed = true
              setTimeout(() => {
                debug('[channel] Sending Enter to confirm dev channel warning')
                ctx.ptyProcess?.write('\r')
              }, 300)
              diag('channel', 'Auto-confirmed dev channel warning')
            }
          }

          // Scan for OSC 52 clipboard sequences and forward captures to broker
          const cleaned = osc52Parser.write(data, capture => {
            if (ctx.wsClient?.isConnected()) {
              const sid = ctx.claudeSessionId || conversationId
              ctx.wsClient.send({
                type: 'clipboard_capture',
                conversationId: sid,
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
          if (ctx.terminalAttached && ctx.claudeSessionId && ctx.wsClient?.isConnected()) {
            ctx.wsClient.sendTerminalData(cleaned)
          }
        },
        onExit(code) {
          // Detect early exit (within 10s) - likely hook/config/binary failure
          const elapsedMs = Date.now() - ptySpawnedAt
          if (elapsedMs < 10_000 && code !== 0) {
            debug(`PTY early exit: code=${code} elapsed=${elapsedMs}ms - reporting spawn_failed`)
            ctx.wsClient?.send({
              type: 'spawn_failed',
              conversationId: conversationId,
              project: cwdToProjectUri(cwd),
              exitCode: code,
              elapsedMs,
              error: `Claude process exited in ${elapsedMs}ms (exit ${code}) - likely hook, config, or binary failure`,
            })
          }

          if (ctx.claudeSessionId) {
            ctx.wsClient?.sendConversationEnd(code === 0 ? 'normal' : `exit_code_${code}`)
          }
          cleanup()
          process.exit(code ?? 0)
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      debug(`PTY spawn failed: ${msg}`)
      ctx.wsClient?.send({
        type: 'spawn_failed',
        conversationId: conversationId,
        project: cwdToProjectUri(cwd),
        error: `PTY spawn failed: ${msg}`,
      })
      // Give WS a moment to flush the message before exiting
      setTimeout(() => {
        cleanup()
        process.exit(1)
      }, 500)
      return
    }

    ctx.wsClient?.sendBootEvent('claude_started', `pid=${ctx.ptyProcess?.proc.pid ?? 'unknown'}`, {
      pid: ctx.ptyProcess?.proc.pid,
    })
    ctx.wsClient?.sendBootEvent('awaiting_init', 'Waiting for SessionStart hook')

    // Setup terminal passthrough (PTY mode only)
    cleanupTerminal = setupTerminalPassthrough(ctx.ptyProcess as PtyProcess)
  }

  // Cleanup function
  function cleanup() {
    if (ctx.taskWatcher) ctx.taskWatcher.close()
    ctx.transcriptWatcher?.stop()
    for (const watcher of ctx.subagentWatchers.values()) watcher.stop()
    ctx.subagentWatchers.clear()
    for (const watcher of ctx.bgTaskOutputWatchers.values()) watcher.stop()
    ctx.bgTaskOutputWatchers.clear()
    ctx.fileEditor?.destroy()
    cleanupTerminal()
    stopLocalServer(localServer)
    ctx.wsClient?.close()
    // Clear diag buffer and timer
    if (ctx.diagFlushTimer) {
      clearTimeout(ctx.diagFlushTimer)
      ctx.diagFlushTimer = null
    }
    ctx.diagBuffer.length = 0
    ctx.eventQueue.length = 0
    cleanupSettings(conversationId, rclaudeDir).catch(() => {})
    closeMcpChannel().catch(() => {})
    // NOTE: Do NOT delete mcpConfigPath here. CC reads it asynchronously and
    // another wrapper with the same RCLAUDE_CONVERSATION_ID may still need it.
    // The 25-day stale reaper handles cleanup. (77 bytes per file.)
    try {
      unlinkSync(promptFile)
    } catch {}
    // Reap stale settings files older than 25 days
    try {
      const settingsDir = join(rclaudeDir, 'settings')
      const maxAge = 25 * 24 * 60 * 60 * 1000
      const now = Date.now()
      for (const file of readdirSync(settingsDir)) {
        const filePath = join(settingsDir, file)
        try {
          const stat = Bun.file(filePath)
          if (now - stat.lastModified > maxAge) unlinkSync(filePath)
        } catch {}
      }
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
