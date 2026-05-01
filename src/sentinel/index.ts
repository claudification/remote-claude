#!/usr/bin/env bun
/**
 * sentinel - Host-side sentinel for session revival and spawning
 *
 * Connects to broker via WebSocket, listens for revive/spawn commands.
 * Headless sessions are spawned directly via Bun.spawn() with PID tracking.
 * PTY/interactive sessions still use tmux via revive-session.sh.
 *
 * Only one sentinel can be connected at a time. If another agent is already
 * connected, this process exits immediately.
 */

import { checkBunVersion } from '../shared/bun-version'

checkBunVersion()

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Subprocess } from 'bun'
import { cwdToProjectUri, parseProjectUri } from '../shared/project-uri'
import type {
  BrokerSentinelMessage,
  ExtraUsage,
  ListDirsResult,
  ReviveConversation,
  ReviveResult,
  SpawnConversation,
  SpawnFailed,
  SpawnResult,
  UsageUpdate,
  UsageWindow,
} from '../shared/protocol'
import { DEFAULT_BROKER_URL, HEARTBEAT_INTERVAL_MS } from '../shared/protocol'

function getRawMachineId(): string {
  const platform = process.platform

  if (platform === 'darwin') {
    try {
      const result = Bun.spawnSync(['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (result.success) {
        const output = result.stdout.toString()
        const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
        if (match) return match[1]
      }
    } catch {}
  }

  if (platform === 'linux') {
    try {
      const id = readFileSync('/etc/machine-id', 'utf8').trim()
      if (id) return id
    } catch {}
  }

  return osHostname()
}

function getMachineId(): string {
  const raw = getRawMachineId()
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

const RECONNECT_DELAY_MS = 5000

// ─── tmux binary discovery ────────────────────────────────────────────
// When the sentinel runs as a launchd daemon (macOS), it inherits a minimal PATH
// (e.g. /usr/bin:/bin:/usr/sbin:/sbin) without Homebrew's /opt/homebrew/bin.
// Resolve tmux to an absolute path at startup by checking common package manager
// locations directly, without mutating process.env.PATH (which would widen the
// PATH inherited by all child processes).
function findTmuxBinary(): string {
  // First, check the existing PATH
  const fromPath = Bun.which('tmux')
  if (fromPath) return fromPath
  // Check common package manager locations that may not be in PATH
  const extraDirs = [
    '/opt/homebrew/bin', // Homebrew on Apple Silicon
    '/usr/local/bin', // Homebrew on Intel Mac / common Linux
    '/home/linuxbrew/.linuxbrew/bin', // Homebrew on Linux (system-wide)
    join(process.env.HOME || '/root', '.linuxbrew', 'bin'), // Homebrew on Linux (per-user)
  ]
  for (const dir of extraDirs) {
    const candidate = join(dir, 'tmux')
    if (existsSync(candidate)) return candidate
  }
  return 'tmux' // bare fallback — will fail with a clear error at the call site
}

const TMUX_BIN = findTmuxBinary()

// ─── PID Registry (headless child process tracking) ─────────────────
const PID_REGISTRY_DIR = join(process.env.HOME || '/root', '.rclaude')
const PID_REGISTRY_PATH = join(PID_REGISTRY_DIR, 'sentinel-sessions.json')

interface PidRegistryEntry {
  conversationId: string
  pid: number
  cwd: string
  startedAt: string
}

interface TrackedChild {
  proc: Subprocess
  conversationId: string
  pid: number
  cwd: string
  startedAt: string
}

/** Live headless children spawned by this sentinel instance */
const trackedChildren = new Map<string, TrackedChild>()

/** Dead PIDs discovered from registry on startup (reported once WS connects) */
const deadPidsToReport: PidRegistryEntry[] = []

function writePidRegistry() {
  const entries: PidRegistryEntry[] = [...trackedChildren.values()].map(c => ({
    conversationId: c.conversationId,
    pid: c.pid,
    cwd: c.cwd,
    startedAt: c.startedAt,
  }))
  try {
    mkdirSync(PID_REGISTRY_DIR, { recursive: true })
    writeFileSync(PID_REGISTRY_PATH, JSON.stringify(entries, null, 2))
  } catch (e) {
    log(`Failed to write PID registry: ${e}`)
  }
}

function loadAndCheckPidRegistry() {
  if (!existsSync(PID_REGISTRY_PATH)) return
  try {
    const entries: PidRegistryEntry[] = JSON.parse(readFileSync(PID_REGISTRY_PATH, 'utf8'))
    for (const entry of entries) {
      try {
        process.kill(entry.pid, 0) // check if alive (signal 0 = no-op)
        log(`PID ${entry.pid} still alive (wrapper ${entry.conversationId.slice(0, 8)}, cwd=${entry.cwd})`)
        // Can't re-attach Bun.spawn to existing PID - just note it's alive.
        // The rclaude process manages its own WS connection to the broker.
      } catch {
        log(`PID ${entry.pid} dead (wrapper ${entry.conversationId.slice(0, 8)})`)
        deadPidsToReport.push(entry)
      }
    }
    unlinkSync(PID_REGISTRY_PATH)
  } catch (e) {
    log(`Failed to read PID registry: ${e}`)
  }
}

/** Report dead PIDs from a previous sentinel run (called after WS connects) */
function reportDeadPids(ws: WebSocket) {
  for (const entry of deadPidsToReport) {
    const msg: SpawnFailed = {
      type: 'spawn_failed',
      conversationId: entry.conversationId,
      project: cwdToProjectUri(entry.cwd),
      pid: entry.pid,
      error: 'Process died during sentinel restart (discovered from PID registry)',
    }
    try {
      ws.send(JSON.stringify(msg))
    } catch {}
  }
  if (deadPidsToReport.length > 0) {
    log(`Reported ${deadPidsToReport.length} dead PIDs from previous run`)
  }
  deadPidsToReport.length = 0
}

// ─── CC Transcript Discovery ─────────────────────────────────────────

/** Check if a CC transcript file exists for the given session ID and CWD.
 *  CC stores transcripts at ~/.claude/projects/{mangled-cwd}/{session-id}.jsonl
 *  where mangled-cwd replaces all / with - in the absolute path. */
function ccTranscriptExists(sessionId: string, cwd: string): boolean {
  const home = process.env.HOME || '/root'
  const mangledCwd = cwd.replace(/\//g, '-')
  const transcriptPath = join(home, '.claude', 'projects', mangledCwd, `${sessionId}.jsonl`)
  return existsSync(transcriptPath)
}

// ─── rclaude Binary Discovery ────────────────────────────────────────

function findRclaudeBinary(): string | null {
  // Bun.which checks PATH
  const fromPath = Bun.which('rclaude')
  if (fromPath) return fromPath
  // Fallback: same dir as sentinel binary, or ~/.local/bin
  const binDir = dirname(resolve(process.argv[0]))
  const homeLocalBin = join(process.env.HOME || '/root', '.local', 'bin')
  const candidates = [resolve(binDir, 'rclaude'), resolve(homeLocalBin, 'rclaude')]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

// ─── Env Sanitization ──────────────────────────────────────────────

/** Session-scoped RCLAUDE_* vars that must NOT leak from the sentinel's own
 *  environment into spawned child sessions. The sentinel may have inherited
 *  these from the rclaude process that launched it. Each spawned session
 *  gets its own values set explicitly. */
const RCLAUDE_SESSION_VARS = new Set([
  'RCLAUDE_HEADLESS',
  'RCLAUDE_CONVERSATION_ID',
  'RCLAUDE_SESSION_ID',
  'CLAUDWERK_CONVERSATION_NAME',
  'CLAUDWERK_CONVERSATION_DESCRIPTION',
  'RCLAUDE_SECRET',
  'RCLAUDE_PERMISSION_MODE',
  'RCLAUDE_BARE',
  'RCLAUDE_ADHOC',
  'RCLAUDE_ADHOC_TASK_ID',
  'RCLAUDE_CHANNELS',
  'RCLAUDE_INITIAL_PROMPT_FILE',
  'RCLAUDE_WORKTREE',
  'RCLAUDE_EFFORT',
  'RCLAUDE_MODEL',
  'RCLAUDE_AUTOCOMPACT_PCT',
  'RCLAUDE_MAX_BUDGET_USD',
  'RCLAUDE_PORT',
  'RCLAUDE_CUSTOM_ENV',
  'RCLAUDE_INCLUDE_PARTIAL_MESSAGES',
])

/**
 * Return a copy of process.env with session-scoped RCLAUDE_* and
 * CLAUDE_CODE_* vars stripped. Safe base for building child env.
 */
function cleanSentinelEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || RCLAUDE_SESSION_VARS.has(key)) {
      delete env[key]
    }
  }
  return env
}

// ─── Direct Headless Spawn ──────────────────────────────────────────

/**
 * Build the env object for a directly-spawned headless rclaude process.
 * Replicates what revive-session.sh sets up, minus the shell quoting dance.
 */
function buildHeadlessEnv(opts: {
  secret: string
  conversationId: string
  sessionId?: string
  sessionName?: string
  sessionDescription?: string
  permissionMode?: string
  autocompactPct?: number
  maxBudgetUsd?: number
  agent?: string
  adHoc?: boolean
  adHocTaskId?: string
  leaveRunning?: boolean
  promptFile?: string
  worktree?: string
  effort?: string
  model?: string
  bare?: boolean
  repl?: boolean
  includePartialMessages?: boolean
  env?: Record<string, string>
}): Record<string, string | undefined> {
  // Start from sanitized sentinel env (PATH, API keys, etc. but no session-scoped vars)
  const env = cleanSentinelEnv()

  // Required
  env.RCLAUDE_SECRET = opts.secret
  env.RCLAUDE_CONVERSATION_ID = opts.conversationId
  env.RCLAUDE_HEADLESS = '1'

  // Optional
  if (opts.sessionId) env.RCLAUDE_SESSION_ID = opts.sessionId
  if (opts.sessionName) env.CLAUDWERK_CONVERSATION_NAME = opts.sessionName
  if (opts.sessionDescription) env.CLAUDWERK_CONVERSATION_DESCRIPTION = opts.sessionDescription
  if (opts.permissionMode) env.RCLAUDE_PERMISSION_MODE = opts.permissionMode
  if (opts.autocompactPct) env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(opts.autocompactPct)
  if (opts.bare) env.RCLAUDE_BARE = '1'
  if (opts.repl) env.CLAUDE_CODE_REPL = 'true'
  if (opts.adHoc) {
    env.RCLAUDE_ADHOC = '1'
    env.RCLAUDE_CHANNELS = '0'
  }
  if (opts.adHocTaskId) env.RCLAUDE_ADHOC_TASK_ID = opts.adHocTaskId
  if (opts.leaveRunning) env.RCLAUDE_LEAVE_RUNNING = '1'
  if (opts.promptFile) env.RCLAUDE_INITIAL_PROMPT_FILE = opts.promptFile
  if (opts.worktree) env.RCLAUDE_WORKTREE = opts.worktree
  if (opts.agent) env.RCLAUDE_AGENT = opts.agent
  if (opts.includePartialMessages === false) env.RCLAUDE_INCLUDE_PARTIAL_MESSAGES = '0'
  if (opts.env && Object.keys(opts.env).length) env.RCLAUDE_CUSTOM_ENV = JSON.stringify(opts.env)

  return env
}

/**
 * Build CLI args for a directly-spawned headless rclaude process.
 */
function buildHeadlessArgs(opts: {
  mode?: 'fresh' | 'resume'
  resumeId?: string
  resumeName?: string
  effort?: string
  model?: string
  agent?: string
  worktree?: string
  maxBudgetUsd?: number
}): string[] {
  const args = ['--dangerously-skip-permissions']
  if (opts.mode === 'resume') {
    const resumeKey = opts.resumeId || opts.resumeName
    if (resumeKey) args.push('--resume', resumeKey)
  }
  if (opts.effort) args.push('--effort', opts.effort)
  if (opts.model) args.push('--model', opts.model)
  if (opts.agent) args.push('--agent', opts.agent)
  if (opts.worktree) args.push('--worktree', opts.worktree)
  if (opts.maxBudgetUsd) args.push('--max-budget-usd', String(opts.maxBudgetUsd))
  return args
}

/**
 * Spawn a headless rclaude session directly via Bun.spawn().
 * Returns immediately after process starts. Monitors exit asynchronously.
 */
function spawnHeadlessDirect(
  rclaudeBin: string,
  cwd: string,
  conversationId: string,
  args: string[],
  env: Record<string, string | undefined>,
  jobId?: string,
): { success: boolean; error?: string; pid?: number } {
  const startTime = Date.now()

  launchLog(jobId, 'Spawning headless (direct)', 'info', `${rclaudeBin} ${args.join(' ')}`)

  let proc: Subprocess
  try {
    proc = Bun.spawn([rclaudeBin, ...args], {
      cwd,
      env,
      stdout: 'ignore', // headless rclaude communicates via WS, not stdout
      stderr: 'pipe', // capture for diagnostics
    })
  } catch (e: unknown) {
    const err = `Bun.spawn failed: ${(e as Error).message}`
    launchLog(jobId, 'Spawn failed', 'error', err)
    return { success: false, error: err }
  }

  const pid = proc.pid
  log(`Headless spawn: PID ${pid} conv=${conversationId.slice(0, 8)} cwd=${cwd}`)

  // Track the child
  const child: TrackedChild = { proc, conversationId, pid, cwd, startedAt: new Date().toISOString() }
  trackedChildren.set(conversationId, child)
  writePidRegistry()

  // Capture stderr for diagnostics
  captureChildStderr(proc, conversationId)

  // Monitor for exit
  proc.exited.then(exitCode => {
    const elapsedMs = Date.now() - startTime
    trackedChildren.delete(conversationId)
    writePidRegistry()

    if (exitCode === 0) {
      log(`Headless child exited normally: PID ${pid} conv=${conversationId.slice(0, 8)} (${elapsedMs}ms)`)
      diag('spawn', `Child exited OK (${elapsedMs}ms)`, { conversationId: conversationId.slice(0, 8), pid })
    } else {
      const earlyFailure = elapsedMs < 5000
      log(
        `Headless child FAILED: PID ${pid} exit=${exitCode} elapsed=${elapsedMs}ms conv=${conversationId.slice(0, 8)}${earlyFailure ? ' (EARLY - likely hook/config failure)' : ''}`,
      )
      diag('spawn', `Child FAILED exit=${exitCode} elapsed=${elapsedMs}ms`, {
        conversationId: conversationId.slice(0, 8),
        pid,
        earlyFailure,
      })

      // Report to broker
      if (activeWs?.readyState === WebSocket.OPEN) {
        const msg: SpawnFailed = {
          type: 'spawn_failed',
          conversationId,
          project: cwdToProjectUri(cwd),
          pid,
          exitCode,
          elapsedMs,
          error: earlyFailure
            ? `Process exited in ${elapsedMs}ms (exit ${exitCode}) - likely hook or config failure`
            : `Process exited with code ${exitCode} after ${Math.round(elapsedMs / 1000)}s`,
        }
        try {
          activeWs.send(JSON.stringify(msg))
        } catch {}
      }
    }
  })

  launchLog(jobId, 'Headless process started', 'ok', `PID ${pid}`)
  return { success: true, pid }
}

/** Read stderr from a child process and forward lines as diag entries */
async function captureChildStderr(proc: Subprocess, conversationId: string) {
  const stderr = proc.stderr
  if (!stderr) return
  const reader = (stderr as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (line.trim()) {
          diag('child-stderr', line.trim(), { wrapper: conversationId.slice(0, 8) })
        }
      }
    }
    // Flush remaining
    if (buffer.trim()) {
      diag('child-stderr', buffer.trim(), { wrapper: conversationId.slice(0, 8) })
    }
  } catch {
    // Stream closed, normal on exit
  }
}

// Find revive-session.sh in common locations.
// Two install layouts to support:
//   1. Compiled standalone: process.argv[0] is the binary itself (bin/sentinel
//      under the project root) -- look in ../scripts/.
//   2. Bundled JS via `bun install -g ./packages/sentinel`: process.argv[0] is
//      the bun runtime; the actual script is process.argv[1], a symlink chain
//      that ends at packages/sentinel/bin/sentinel inside the project root.
//      realpathSync follows the chain back to the source layout.
function findReviveScript(): string {
  const argv0Dir = dirname(resolve(process.argv[0]))
  const argv1 = process.argv[1]
  let scriptDir: string | null = null
  if (argv1) {
    try {
      scriptDir = dirname(realpathSync(argv1))
    } catch {}
  }
  const homeLocalBin = `${process.env.HOME || '/root'}/.local/bin`
  const candidates = [
    // Bundled JS dogfood/npm: packages/sentinel/bin/ -> project root scripts/
    scriptDir && resolve(scriptDir, '../../../scripts/revive-session.sh'),
    // Compiled standalone: bin/ -> project root scripts/
    resolve(argv0Dir, '../scripts/revive-session.sh'),
    // Compiled binary sitting at project root with sibling scripts/
    resolve(argv0Dir, 'scripts/revive-session.sh'),
    // Same dir as binary (fallback)
    resolve(argv0Dir, 'revive-session.sh'),
    scriptDir && resolve(scriptDir, 'revive-session.sh'),
    // Installed to ~/.local/bin
    resolve(homeLocalBin, 'revive-session.sh'),
  ].filter((p): p is string => typeof p === 'string')
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return candidates[0] // will fail at startup validation
}
const DEFAULT_REVIVE_SCRIPT = findReviveScript()

function parseArgs() {
  const args = process.argv.slice(2)
  let brokerUrl =
    process.env.CLAUDWERK_BROKER ?? process.env.RCLAUDE_BROKER ?? process.env.RCLAUDE_CONCENTRATOR ?? DEFAULT_BROKER_URL
  let secret =
    process.env.CLAUDWERK_SENTINEL_SECRET ??
    process.env.RCLAUDE_SENTINEL_SECRET ??
    process.env.CLAUDWERK_SECRET ??
    process.env.RCLAUDE_SECRET
  let verbose = false
  let reviveScript = DEFAULT_REVIVE_SCRIPT
  let spawnRoot = process.env.HOME || '/root'
  let noSpawn = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--broker') {
      brokerUrl = args[++i] || DEFAULT_BROKER_URL
    } else if (arg === '--secret') {
      secret = args[++i]
    } else if (arg === '--revive-script') {
      reviveScript = resolve(args[++i])
    } else if (arg === '--spawn-root') {
      spawnRoot = resolve(args[++i])
    } else if (arg === '--no-spawn') {
      noSpawn = true
    } else if (arg === '-v' || arg === '--verbose') {
      verbose = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  if (!secret) {
    secret =
      process.env.CLAUDWERK_SENTINEL_SECRET ??
      process.env.RCLAUDE_SENTINEL_SECRET ??
      process.env.CLAUDWERK_SECRET ??
      process.env.RCLAUDE_SECRET
  }

  return { brokerUrl, secret, verbose, reviveScript, spawnRoot, noSpawn }
}

function printHelp() {
  console.log(`
sentinel - Host-side sentinel for session revival and spawning

Connects to broker and listens for revive/spawn commands.
Headless sessions are spawned directly (Bun.spawn + PID tracking).
PTY/interactive sessions use tmux via revive-session.sh.

USAGE:
  sentinel [OPTIONS]

OPTIONS:
  --broker <url>   Broker WebSocket URL (default: ${DEFAULT_BROKER_URL})
  --secret <s>           Secret (CLAUDWERK_SENTINEL_SECRET or RCLAUDE_SECRET env)
  --revive-script <path> Path to revive-session.sh (default: auto-detected)
  --spawn-root <path>    Root directory for relative spawn paths (default: $HOME)
  -v, --verbose          Enable verbose logging
  -h, --help             Show this help

Spawn security: directories need a .rclaude-spawn marker file at or above
the target path to allow spawning. Only one sentinel can be connected at a time.
`)
}

// Module-level WS ref for diag()
let activeWs: WebSocket | null = null

function log(msg: string) {
  console.log(`[sentinel] ${msg}`)
}

function debug(msg: string, verbose: boolean) {
  if (verbose) console.log(`[sentinel] ${msg}`)
}

function diag(type: string, msg: string, args?: unknown) {
  log(`[diag] ${type}: ${msg}${args ? ` ${JSON.stringify(args)}` : ''}`)
  if (activeWs?.readyState === WebSocket.OPEN) {
    try {
      activeWs.send(
        JSON.stringify({
          type: 'sentinel_diag',
          entries: [{ t: Date.now(), type, msg, args }],
        }),
      )
    } catch {}
  }
}

/** Send a launch_log event tagged with jobId for request-scoped progress tracking */
function launchLog(jobId: string | undefined, step: string, status: 'info' | 'ok' | 'error', detail?: string) {
  if (!jobId) return
  log(`[job:${jobId.slice(0, 8)}] ${status}: ${step}${detail ? ` -- ${detail}` : ''}`)
  if (activeWs?.readyState === WebSocket.OPEN) {
    try {
      activeWs.send(JSON.stringify({ type: 'launch_log', jobId, step, status, detail, t: Date.now() }))
    } catch {}
  }
}

/**
 * Revive a session. Headless sessions are spawned directly via Bun.spawn(),
 * PTY sessions use the external revive-session.sh script for tmux.
 *
 * Script exit codes: 0=continued, 1=fresh session, 2=dir not found, 3=tmux failed
 * Script stdout: TMUX_SESSION=<name> and CONTINUED=<true|false>
 */
async function reviveSession(
  sessionId: string,
  cwd: string,
  conversationId: string,
  reviveScript: string,
  secret: string,
  verbose: boolean,
  mode?: 'fresh' | 'resume',
  headless = true,
  effort?: string,
  model?: string,
  sessionName?: string,
  autocompactPct?: number,
  maxBudgetUsd?: number,
  jobId?: string,
  adHocWorktree?: string,
  env?: Record<string, string>,
  agent?: string,
): Promise<ReviveResult & { tmuxPaneId?: string }> {
  const result: ReviveResult = {
    type: 'revive_result',
    ccSessionId: sessionId,
    conversationId,
    project: cwdToProjectUri(cwd),
    jobId,
    success: false,
    continued: false,
  }

  // ─── Direct spawn for headless ─────────────────────────────
  if (headless) {
    const rclaudeBin = findRclaudeBinary()
    if (!rclaudeBin) {
      result.error = 'rclaude binary not found in PATH or known locations'
      launchLog(jobId, 'rclaude not found', 'error', result.error)
      return result
    }

    // Check if CC transcript exists before attempting --resume.
    // If missing, fall back to fresh start to avoid immediate exit code 1.
    let effectiveMode = mode
    if (mode === 'resume' && !ccTranscriptExists(sessionId, cwd)) {
      log(`CC transcript missing for ${sessionId.slice(0, 8)} - falling back to fresh start`)
      launchLog(
        jobId,
        'CC transcript missing, starting fresh',
        'info',
        `session ${sessionId.slice(0, 8)} has no JSONL file`,
      )
      effectiveMode = 'fresh'
    }

    const args = buildHeadlessArgs({
      mode: effectiveMode,
      resumeId: sessionId,
      resumeName: sessionName,
      effort,
      model,
      agent,
      maxBudgetUsd,
    })
    const spawnEnv = buildHeadlessEnv({
      secret,
      conversationId,
      sessionId,
      sessionName,
      autocompactPct,
      maxBudgetUsd,
      agent,
      effort,
      model,
      worktree: adHocWorktree,
      env,
    })

    launchLog(jobId, 'Reviving headless (direct spawn)', 'info', `mode=${effectiveMode || 'default'}`)
    const spawnRes = spawnHeadlessDirect(rclaudeBin, cwd, conversationId, args, spawnEnv, jobId)
    result.success = spawnRes.success
    result.error = spawnRes.error
    result.continued = effectiveMode === 'resume'
    return result
  }

  // ─── tmux path for PTY sessions ────────────────────────────
  // Same transcript check as headless path
  let effectiveTmuxMode = mode
  if (mode === 'resume' && !ccTranscriptExists(sessionId, cwd)) {
    log(`CC transcript missing for ${sessionId.slice(0, 8)} - falling back to fresh start (tmux)`)
    launchLog(
      jobId,
      'CC transcript missing, starting fresh',
      'info',
      `session ${sessionId.slice(0, 8)} has no JSONL file`,
    )
    effectiveTmuxMode = 'fresh'
  }

  const scriptArgs = [reviveScript, sessionId, cwd]
  if (effectiveTmuxMode) scriptArgs.push('--mode', effectiveTmuxMode)
  if (effectiveTmuxMode === 'resume') scriptArgs.push('--resume-id', sessionId)

  launchLog(jobId, 'Running revive script (tmux)', 'info', `mode=${mode || 'default'}`)
  debug(`Running: ${scriptArgs.join(' ')}`, verbose)

  const proc = Bun.spawnSync(scriptArgs, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...cleanSentinelEnv(),
      RCLAUDE_SECRET: secret,
      RCLAUDE_CONVERSATION_ID: conversationId,
      RCLAUDE_SESSION_ID: sessionId,
      ...(effort ? { RCLAUDE_EFFORT: effort } : {}),
      ...(model ? { RCLAUDE_MODEL: model } : {}),
      ...(sessionName ? { CLAUDWERK_CONVERSATION_NAME: sessionName } : {}),
      ...(autocompactPct ? { RCLAUDE_AUTOCOMPACT_PCT: String(autocompactPct) } : {}),
      ...(maxBudgetUsd ? { RCLAUDE_MAX_BUDGET_USD: String(maxBudgetUsd) } : {}),
      ...(adHocWorktree ? { RCLAUDE_WORKTREE: adHocWorktree } : {}),
      ...(agent ? { RCLAUDE_AGENT: agent } : {}),
      ...(env && Object.keys(env).length ? { RCLAUDE_CUSTOM_ENV: JSON.stringify(env) } : {}),
    },
  })

  const stdout = proc.stdout.toString().trim()
  const stderr = proc.stderr.toString().trim()
  const exitCode = proc.exitCode

  if (verbose && stdout) debug(`Script stdout: ${stdout}`, verbose)
  if (stderr) debug(`Script stderr: ${stderr}`, verbose)

  // Parse output lines for TMUX_SESSION=, PANE_ID=, CONTINUED=
  let tmuxPaneId: string | undefined
  for (const line of stdout.split('\n')) {
    const [key, value] = line.split('=', 2)
    if (key === 'TMUX_SESSION') result.tmuxSession = value
    if (key === 'PANE_ID') tmuxPaneId = value
    if (key === 'CONTINUED') result.continued = value === 'true'
  }

  switch (exitCode) {
    case 0: // success, continued existing session
      result.success = true
      result.continued = true
      launchLog(jobId, 'Session revived', 'ok', `continued=true tmux=${result.tmuxSession}`)
      break
    case 1: // success, fresh session (resume failed or not requested)
      result.success = true
      result.continued = false
      launchLog(jobId, 'Fresh session started', 'ok', `tmux=${result.tmuxSession}`)
      break
    case 2: // directory not found
      result.error = stderr || `Directory not found: ${cwd}`
      launchLog(jobId, 'Directory not found', 'error', result.error)
      break
    case 3: // tmux spawn failed
      result.error = stderr || 'Failed to create tmux session'
      launchLog(jobId, 'tmux spawn failed', 'error', result.error)
      break
    default:
      result.error = stderr || `Script exited with code ${exitCode}`
      launchLog(jobId, 'Script failed', 'error', result.error)
  }

  return Object.assign(result, { tmuxPaneId })
}

/**
 * Expand path shortcuts: ~ -> $HOME, relative paths -> spawnRoot
 */
function expandPath(p: string, spawnRoot: string): string {
  const home = process.env.HOME || '/root'
  if (p.startsWith('~/')) return resolve(home, p.slice(2))
  if (p === '~') return home
  if (!p.startsWith('/')) return resolve(spawnRoot, p)
  return resolve(p)
}

/**
 * Check if a directory is spawn-approved.
 * Walks up from `cwd` looking for a `.rclaude-spawn` marker file.
 * If found at or above the target, spawn is allowed.
 */
function isSpawnApproved(cwd: string): boolean {
  let dir = resolve(cwd)
  const root = resolve('/')
  while (true) {
    if (existsSync(resolve(dir, '.rclaude-spawn'))) return true
    if (dir === root) break
    dir = dirname(dir)
  }
  return false
}

/**
 * Spawn a new rclaude session at the given cwd.
 * Headless sessions use direct Bun.spawn(), PTY sessions use tmux via revive-session.sh.
 */
async function spawnSession(
  cwd: string,
  conversationId: string,
  reviveScript: string,
  secret: string,
  _verbose: boolean,
  mkdir = false,
  mode?: 'fresh' | 'resume',
  resumeId?: string,
  headless = true,
  effort?: string,
  model?: string,
  bare = false,
  repl = false,
  sessionName?: string,
  sessionDescription?: string,
  permissionMode?: string,
  autocompactPct?: number,
  maxBudgetUsd?: number,
  prompt?: string,
  adHoc = false,
  adHocTaskId?: string,
  worktree?: string,
  jobId?: string,
  leaveRunning = false,
  includePartialMessages?: boolean,
  env?: Record<string, string>,
  agent?: string,
): Promise<{ success: boolean; error?: string; tmuxSession?: string; tmuxPaneId?: string }> {
  launchLog(jobId, 'Validating directory', 'info', cwd)

  // Diagnostic dump
  const rclaudeBin = findRclaudeBinary()
  diag('spawn', 'Starting spawn', {
    cwd,
    conversationId,
    mkdir,
    headless,
    reviveScript,
    reviveScriptExists: existsSync(reviveScript),
    secretSet: !!secret,
    brokerUrl: process.env.RCLAUDE_BROKER || 'UNSET',
    rclaude: rclaudeBin || 'NOT FOUND',
    PATH: process.env.PATH,
  })

  if (!existsSync(cwd)) {
    if (mkdir) {
      try {
        mkdirSync(cwd, { recursive: true })
        launchLog(jobId, 'Created directory', 'ok', cwd)
        diag('spawn', 'Created directory', { cwd })
      } catch (e: unknown) {
        const err = `Failed to create directory: ${(e as Error).message}`
        launchLog(jobId, 'Directory creation failed', 'error', err)
        return { success: false, error: err }
      }
    } else {
      launchLog(jobId, 'Directory not found', 'error', cwd)
      return { success: false, error: `Directory not found: ${cwd}` }
    }
  } else {
    launchLog(jobId, 'Directory validated', 'ok')
  }

  if (!isSpawnApproved(cwd)) {
    const err = `Spawn not allowed: no .rclaude-spawn marker at or above ${cwd}`
    launchLog(jobId, 'Spawn not approved', 'error', err)
    return { success: false, error: err }
  }
  launchLog(jobId, 'Spawn approved', 'ok')

  // Write ad-hoc prompt to file (prompt content can contain anything, files avoid shell escaping issues)
  if (adHoc) {
    diag('spawn', '[ad-hoc] Starting ad-hoc spawn', {
      taskId: adHocTaskId,
      worktree,
      promptLength: prompt?.length || 0,
      sessionName,
    })
  }
  let promptFile: string | undefined
  if (prompt) {
    promptFile = `/tmp/rclaude-adhoc-${conversationId}`
    try {
      await Bun.write(promptFile, prompt)
      launchLog(jobId, 'Prompt file written', 'ok', `${prompt.length} chars`)
      diag('spawn', 'Wrote prompt file', { path: promptFile, length: prompt.length })
    } catch (e: unknown) {
      diag('spawn', 'Failed to write prompt file', { error: (e as Error).message })
      launchLog(jobId, 'Prompt file failed', 'error', (e as Error).message)
      promptFile = undefined
    }
  }

  // ─── Direct spawn for headless ─────────────────────────────
  if (headless) {
    if (!rclaudeBin) {
      const err = 'rclaude binary not found in PATH or known locations'
      launchLog(jobId, 'rclaude not found', 'error', err)
      return { success: false, error: err }
    }

    const args = buildHeadlessArgs({
      mode,
      resumeId,
      resumeName: sessionName,
      effort,
      model,
      agent,
      worktree,
      maxBudgetUsd,
    })
    const spawnEnv = buildHeadlessEnv({
      secret,
      conversationId,
      sessionName,
      sessionDescription,
      permissionMode,
      autocompactPct,
      maxBudgetUsd,
      agent,
      adHoc,
      adHocTaskId,
      leaveRunning,
      promptFile,
      worktree,
      effort,
      model,
      bare,
      repl,
      includePartialMessages,
      env,
    })

    const spawnRes = spawnHeadlessDirect(rclaudeBin, cwd, conversationId, args, spawnEnv, jobId)
    if (spawnRes.success) {
      launchLog(jobId, 'Waiting for session to connect', 'info')
    }
    return { success: spawnRes.success, error: spawnRes.error }
  }

  // ─── tmux path for PTY sessions ────────────────────────────

  // Sanitize strings that will be embedded in shell commands by revive-session.sh.
  // The env vars are safe in Bun.spawnSync, but the shell script injects them into
  // CMD_PREFIX which gets nested through tmux -> /bin/sh -> /bin/zsh. Quotes,
  // backticks, backslashes, and dollar signs break the quoting chain.
  const shellSafe = (s: string) => s.replace(/['"\\`$]/g, '')

  // Use "spawn-<timestamp>" as synthetic sessionId (revive-session.sh uses it for tmux window naming)
  const syntheticId = `spawn-${Date.now()}`
  const scriptArgs = [reviveScript, syntheticId, cwd]
  if (mode) scriptArgs.push('--mode', mode)
  if (mode === 'resume' && resumeId) scriptArgs.push('--resume-id', resumeId)
  if (mode === 'resume' && sessionName) scriptArgs.push('--resume-name', sessionName)
  const scriptEnv = {
    ...cleanSentinelEnv(),
    RCLAUDE_SECRET: secret,
    RCLAUDE_CONVERSATION_ID: conversationId,
    ...(effort ? { RCLAUDE_EFFORT: effort } : {}),
    ...(model ? { RCLAUDE_MODEL: model } : {}),
    ...(bare ? { RCLAUDE_BARE: '1' } : {}),
    ...(repl ? { CLAUDE_CODE_REPL: 'true' } : {}),
    ...(sessionName ? { CLAUDWERK_CONVERSATION_NAME: shellSafe(sessionName) } : {}),
    ...(sessionDescription ? { CLAUDWERK_CONVERSATION_DESCRIPTION: shellSafe(sessionDescription) } : {}),
    ...(permissionMode ? { RCLAUDE_PERMISSION_MODE: permissionMode } : {}),
    ...(autocompactPct ? { RCLAUDE_AUTOCOMPACT_PCT: String(autocompactPct) } : {}),
    ...(maxBudgetUsd ? { RCLAUDE_MAX_BUDGET_USD: String(maxBudgetUsd) } : {}),
    ...(adHoc ? { RCLAUDE_ADHOC: '1', RCLAUDE_CHANNELS: '0' } : {}),
    ...(adHocTaskId ? { RCLAUDE_ADHOC_TASK_ID: adHocTaskId } : {}),
    ...(leaveRunning ? { RCLAUDE_LEAVE_RUNNING: '1' } : {}),
    ...(promptFile ? { RCLAUDE_INITIAL_PROMPT_FILE: promptFile } : {}),
    ...(includePartialMessages === false ? { RCLAUDE_INCLUDE_PARTIAL_MESSAGES: '0' } : {}),
    ...(worktree ? { RCLAUDE_WORKTREE: shellSafe(worktree) } : {}),
    ...(agent ? { RCLAUDE_AGENT: shellSafe(agent) } : {}),
    ...(env && Object.keys(env).length ? { RCLAUDE_CUSTOM_ENV: JSON.stringify(env) } : {}),
  }

  launchLog(jobId, 'Starting tmux session', 'info')
  diag('spawn', 'Running revive script', { args: scriptArgs })

  const proc = Bun.spawnSync(scriptArgs, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: scriptEnv,
  })

  const stdout = proc.stdout.toString().trim()
  const stderr = proc.stderr.toString().trim()
  const exitCode = proc.exitCode

  // After spawn, check if the tmux session/window actually exists
  const tmuxCheck = Bun.spawnSync([TMUX_BIN, 'list-windows', '-t', 'claudewerk'])
  const tmuxWindows = tmuxCheck.stdout.toString().trim()

  diag('spawn', 'Script completed', {
    exitCode,
    stdout,
    stderr: stderr || undefined,
    tmuxWindowsAfter: tmuxWindows || '(none/session gone)',
  })

  let tmuxSession: string | undefined
  let tmuxPaneId: string | undefined
  for (const line of stdout.split('\n')) {
    const [key, value] = line.split('=', 2)
    if (key === 'TMUX_SESSION') tmuxSession = value
    if (key === 'PANE_ID') tmuxPaneId = value
  }

  if (exitCode === 0) {
    launchLog(jobId, 'tmux session created', 'ok', `tmux=${tmuxSession} pane=${tmuxPaneId || 'n/a'}`)
    return { success: true, tmuxSession, tmuxPaneId }
  }
  const err = stderr || `Script exited with code ${exitCode}`
  launchLog(jobId, 'tmux spawn failed', 'error', err)
  return { success: false, error: err }
}

/**
 * List directories at a path for the dashboard's path autocomplete.
 */
function listDirs(dirPath: string): { dirs: string[]; error?: string } {
  try {
    const resolved = resolve(dirPath)
    if (!existsSync(resolved)) {
      return { dirs: [], error: `Path not found: ${dirPath}` }
    }
    const stat = statSync(resolved)
    if (!stat.isDirectory()) {
      return { dirs: [], error: `Not a directory: ${dirPath}` }
    }
    const entries = readdirSync(resolved, { withFileTypes: true })
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort()
    return { dirs }
  } catch (err) {
    return { dirs: [], error: `${err}` }
  }
}

// ─── Credential Discovery ─────────────────────────────────────────
// Priority: 1) macOS Keychain  2) ~/.claude/.credentials.json  3) ~/.claude.json

function getOAuthToken(): string | null {
  // 1. macOS Keychain
  if (process.platform === 'darwin') {
    try {
      const result = Bun.spawnSync(['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (result.success) {
        const raw = result.stdout.toString().trim()
        const data = JSON.parse(raw)
        const token = data?.claudeAiOauth?.accessToken
        if (token) return token
      }
    } catch {}
  }

  // 2. ~/.claude/.credentials.json
  const home = process.env.HOME || '/root'
  const credPath = resolve(home, '.claude/.credentials.json')
  try {
    if (existsSync(credPath)) {
      const data = JSON.parse(readFileSync(credPath, 'utf8'))
      const token = data?.claudeAiOauth?.accessToken || data?.accessToken || data?.access_token
      if (token) return token
    }
  } catch {}

  // 3. ~/.claude.json
  const legacyPath = resolve(home, '.claude.json')
  try {
    if (existsSync(legacyPath)) {
      const data = JSON.parse(readFileSync(legacyPath, 'utf8'))
      const token = data?.oauthAccount?.accessToken || data?.primaryApiKey
      if (token) return token
    }
  } catch {}

  return null
}

// ─── Usage API Polling ────────────────────────────────────────────

const USAGE_POLL_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes
const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage'

interface RawUsageWindow {
  utilization: number | null
  resets_at: string
}

interface RawUsageResponse {
  five_hour: RawUsageWindow
  seven_day: RawUsageWindow
  seven_day_opus: RawUsageWindow | null
  seven_day_sonnet: RawUsageWindow | null
  extra_usage: {
    is_enabled: boolean
    monthly_limit: number
    used_credits: number
    utilization: number | null
  } | null
}

function parseWindow(raw: RawUsageWindow | null): UsageWindow | undefined {
  if (!raw || raw.utilization == null) return undefined
  return { usedPercent: raw.utilization, resetAt: raw.resets_at }
}

function parseUsageResponse(raw: RawUsageResponse): UsageUpdate | null {
  const fiveHour = parseWindow(raw.five_hour)
  const sevenDay = parseWindow(raw.seven_day)
  if (!fiveHour || !sevenDay) return null

  const update: UsageUpdate = {
    type: 'usage_update',
    fiveHour,
    sevenDay,
    polledAt: Date.now(),
  }

  const opus = parseWindow(raw.seven_day_opus)
  if (opus) update.sevenDayOpus = opus

  const sonnet = parseWindow(raw.seven_day_sonnet)
  if (sonnet) update.sevenDaySonnet = sonnet

  if (raw.extra_usage) {
    update.extraUsage = {
      isEnabled: raw.extra_usage.is_enabled,
      monthlyLimit: raw.extra_usage.monthly_limit / 100,
      usedCredits: raw.extra_usage.used_credits / 100,
      utilization: raw.extra_usage.utilization,
    } satisfies ExtraUsage
  }

  return update
}

async function pollUsage(token: string): Promise<UsageUpdate | null> {
  try {
    const res = await fetch(USAGE_API_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      diag('usage', `API error: ${res.status} ${res.statusText}`, { body: body.slice(0, 200) })
      return null
    }
    const data = (await res.json()) as RawUsageResponse
    const usage = parseUsageResponse(data)
    if (!usage) {
      diag('usage', 'Failed to parse usage response', { data })
    }
    return usage
  } catch (err) {
    diag('usage', `Poll failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

let usagePollTimer: ReturnType<typeof setInterval> | null = null

function startUsagePolling(ws: WebSocket, verbose: boolean) {
  stopUsagePolling() // clean up any previous timer

  const token = getOAuthToken()
  if (!token) {
    log('No OAuth token found - usage polling disabled')
    diag('usage', 'No OAuth token discovered (checked keychain + credential files)')
    return
  }
  log('OAuth token found - starting usage polling (10min interval)')
  diag('usage', 'Token discovered, polling started')
  const oauthToken = token // narrow for closure

  async function doPoll() {
    try {
      const usage = await pollUsage(oauthToken)
      if (usage && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(usage))
        debug(`Usage sent: 5h=${usage.fiveHour.usedPercent}% 7d=${usage.sevenDay.usedPercent}%`, verbose)
      }
    } catch (err) {
      // Never let a poll crash the sentinel
      diag('usage', `Uncaught poll error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Poll immediately on connect, then every 10 minutes
  doPoll()
  usagePollTimer = setInterval(doPoll, USAGE_POLL_INTERVAL_MS)
}

function stopUsagePolling() {
  if (usagePollTimer) {
    clearInterval(usagePollTimer)
    usagePollTimer = null
  }
}

function connect(
  url: string,
  secret: string,
  reviveScript: string,
  verbose: boolean,
  spawnRoot: string,
  noSpawn: boolean,
) {
  const wsUrl = secret ? `${url}?secret=${encodeURIComponent(secret)}` : url
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let shouldReconnect = true

  log(`Connecting to ${url}...`)

  const ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    log('Connected to broker')
    activeWs = ws
    // Identify as sentinel with machine fingerprint
    ws.send(
      JSON.stringify({
        type: 'sentinel_identify',
        machineId: getMachineId(),
        hostname: osHostname(),
        spawnRoot,
      }),
    )

    // Report any dead PIDs from previous sentinel run
    reportDeadPids(ws)

    // Start usage polling
    startUsagePolling(ws, verbose)

    // Start heartbeat
    heartbeatTimer = setInterval(() => {
      try {
        ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }))
      } catch {}
    }, HEARTBEAT_INTERVAL_MS)
  }

  ws.onmessage = async event => {
    try {
      const msg = JSON.parse(String(event.data)) as BrokerSentinelMessage | { type: string }

      switch (msg.type) {
        case 'ack':
          debug('Sentinel registered successfully', verbose)
          break

        case 'sentinel_reject':
          log(`Rejected: ${'reason' in msg ? msg.reason : 'unknown'}`)
          shouldReconnect = false
          ws.close()
          process.exit(1)
          break

        case 'quit':
          log(`Quit requested: ${'reason' in msg ? msg.reason : 'no reason'}`)
          shouldReconnect = false
          ws.close()
          process.exit(0)
          break

        case 'revive': {
          const reviveMsg = msg as ReviveConversation
          const reviveCwd = parseProjectUri(reviveMsg.project).path
          log(
            `Reviving ccSession=${reviveMsg.ccSessionId.slice(0, 8)} conv=${reviveMsg.conversationId.slice(0, 8)} mode=${reviveMsg.mode || 'default'} headless=${reviveMsg.headless !== false}${reviveMsg.effort ? ` effort=${reviveMsg.effort}` : ''}${reviveMsg.model ? ` model=${reviveMsg.model}` : ''}${reviveMsg.maxBudgetUsd ? ` maxBudget=$${reviveMsg.maxBudgetUsd}` : ''}${reviveMsg.jobId ? ` job=${reviveMsg.jobId.slice(0, 8)}` : ''} (${reviveCwd})`,
          )
          launchLog(reviveMsg.jobId, 'Sentinel received revive request', 'ok')
          const result = await reviveSession(
            reviveMsg.ccSessionId,
            reviveCwd,
            reviveMsg.conversationId,
            reviveScript,
            secret,
            verbose,
            reviveMsg.mode,
            reviveMsg.headless !== false,
            reviveMsg.effort,
            reviveMsg.model,
            reviveMsg.sessionName,
            reviveMsg.autocompactPct,
            reviveMsg.maxBudgetUsd,
            reviveMsg.jobId,
            reviveMsg.adHocWorktree,
            reviveMsg.env,
            reviveMsg.agent,
          )
          // Strip sentinel-internal tmuxPaneId before sending over WS
          const { tmuxPaneId, ...reviveResult } = result
          ws.send(JSON.stringify(reviveResult))
          if (result.success) {
            launchLog(reviveMsg.jobId, 'Waiting for session to connect', 'info')
            if (result.tmuxSession) {
              log(
                `Revived in tmux session "${result.tmuxSession}" pane=${tmuxPaneId || 'n/a'} (continued: ${result.continued})`,
              )
            } else {
              log(`Revived headless (continued: ${result.continued})`)
            }

            // Async tmux health check: verify the pane is still alive after 5s.
            // Catches cases where rclaude crashes before it can connect WS
            // (binary not found, shell PATH broken, early bootstrap failure).
            // Pane IDs (%NNN) are globally unique and stable regardless of
            // session/window renames.
            if (tmuxPaneId) {
              const paneId = tmuxPaneId
              const wid = reviveMsg.conversationId
              const jid = reviveMsg.jobId
              setTimeout(() => {
                const check = Bun.spawnSync([TMUX_BIN, 'list-panes', '-t', paneId], {
                  stdout: 'pipe',
                  stderr: 'pipe',
                })
                if (check.exitCode !== 0) {
                  log(`tmux pane ${paneId} died within 5s of spawn (conv=${wid.slice(0, 8)})`)
                  launchLog(jid, 'tmux pane died', 'error', 'rclaude crashed during startup')
                  const msg: SpawnFailed = {
                    type: 'spawn_failed',
                    conversationId: wid,
                    project: cwdToProjectUri(reviveCwd),
                    error: 'rclaude process died within 5s of tmux launch - check shell environment, PATH, and hooks',
                  }
                  try {
                    ws.send(JSON.stringify(msg))
                  } catch {}
                } else {
                  debug(`tmux health check OK: pane ${paneId} alive (conv=${wid.slice(0, 8)})`, verbose)
                }
              }, 5000)
            }
          } else {
            log(`Revive failed: ${result.error}`)
          }
          break
        }

        case 'spawn': {
          const spawnMsg = msg as SpawnConversation
          if (noSpawn) {
            launchLog(spawnMsg.jobId, 'Spawning disabled', 'error', '--no-spawn flag is set')
            ws.send(
              JSON.stringify({
                type: 'spawn_result',
                requestId: spawnMsg.requestId,
                jobId: spawnMsg.jobId,
                success: false,
                error: 'Spawning disabled (--no-spawn)',
              }),
            )
            break
          }
          const expandedCwd = expandPath(spawnMsg.cwd, spawnRoot)
          launchLog(spawnMsg.jobId, 'Sentinel received spawn request', 'ok', expandedCwd.split('/').pop())
          diag('spawn', 'Spawn request received', {
            requestId: spawnMsg.requestId,
            rawCwd: spawnMsg.cwd,
            expandedCwd,
            conversationId: spawnMsg.conversationId,
            mkdir: spawnMsg.mkdir,
            mode: spawnMsg.mode,
            headless: spawnMsg.headless,
            resumeId: spawnMsg.resumeId,
          })
          const spawnRes = await spawnSession(
            expandedCwd,
            spawnMsg.conversationId,
            reviveScript,
            secret,
            verbose,
            spawnMsg.mkdir,
            spawnMsg.mode,
            spawnMsg.resumeId,
            spawnMsg.headless !== false, // default true
            spawnMsg.effort,
            spawnMsg.model,
            spawnMsg.bare || false,
            spawnMsg.repl || false,
            spawnMsg.sessionName,
            spawnMsg.sessionDescription,
            spawnMsg.permissionMode,
            spawnMsg.autocompactPct,
            spawnMsg.maxBudgetUsd,
            spawnMsg.prompt,
            spawnMsg.adHoc || false,
            spawnMsg.adHocTaskId,
            spawnMsg.worktree,
            spawnMsg.jobId,
            spawnMsg.leaveRunning || false,
            spawnMsg.includePartialMessages,
            spawnMsg.env,
            spawnMsg.agent,
          )
          const response: SpawnResult = {
            type: 'spawn_result',
            requestId: spawnMsg.requestId,
            jobId: spawnMsg.jobId,
            success: spawnRes.success,
            error: spawnRes.error,
            tmuxSession: spawnRes.tmuxSession,
            conversationId: spawnMsg.conversationId,
          }
          ws.send(JSON.stringify(response))
          if (spawnRes.success) {
            launchLog(spawnMsg.jobId, 'Waiting for session to connect', 'info')

            // Async tmux pane health check (same as revive path)
            if (spawnRes.tmuxPaneId) {
              const paneId = spawnRes.tmuxPaneId
              const wid = spawnMsg.conversationId
              const jid = spawnMsg.jobId
              const spawnCwd = expandedCwd
              setTimeout(() => {
                const check = Bun.spawnSync([TMUX_BIN, 'list-panes', '-t', paneId], {
                  stdout: 'pipe',
                  stderr: 'pipe',
                })
                if (check.exitCode !== 0) {
                  log(`tmux pane ${paneId} died within 5s of spawn (conv=${wid.slice(0, 8)})`)
                  launchLog(jid, 'tmux pane died', 'error', 'rclaude crashed during startup')
                  const failMsg: SpawnFailed = {
                    type: 'spawn_failed',
                    conversationId: wid,
                    project: cwdToProjectUri(spawnCwd),
                    error: 'rclaude process died within 5s of tmux launch - check shell environment, PATH, and hooks',
                  }
                  try {
                    ws.send(JSON.stringify(failMsg))
                  } catch {}
                } else {
                  debug(`tmux health check OK: pane ${paneId} alive (conv=${wid.slice(0, 8)})`, verbose)
                }
              }, 5000)
            }
          }
          diag('spawn', spawnRes.success ? 'Spawn OK' : 'Spawn FAILED', {
            tmuxSession: spawnRes.tmuxSession,
            tmuxPaneId: spawnRes.tmuxPaneId,
            error: spawnRes.error,
          })
          break
        }

        case 'list_dirs': {
          const dirMsg = msg as { requestId: string; path: string }
          const expandedDir = expandPath(dirMsg.path, spawnRoot)
          debug(`Listing dirs: ${expandedDir}`, verbose)
          const dirResult = listDirs(expandedDir)
          const dirResponse: ListDirsResult = {
            type: 'list_dirs_result',
            requestId: dirMsg.requestId,
            dirs: dirResult.dirs,
            error: dirResult.error,
          }
          ws.send(JSON.stringify(dirResponse))
          break
        }
      }
    } catch (err) {
      log(`Failed to handle message: ${err}`)
    }
  }

  ws.onclose = () => {
    activeWs = null
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    stopUsagePolling()

    if (shouldReconnect) {
      log(`Disconnected. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`)
      setTimeout(() => connect(url, secret, reviveScript, verbose, spawnRoot, noSpawn), RECONNECT_DELAY_MS)
    }
  }

  ws.onerror = err => {
    debug(`WebSocket error: ${err}`, verbose)
  }
}

// Main
const { brokerUrl, secret, verbose, reviveScript, spawnRoot, noSpawn } = parseArgs()

if (!secret) {
  console.error('ERROR: --secret or CLAUDWERK_SENTINEL_SECRET / RCLAUDE_SECRET is required')
  process.exit(1)
}

// Verify revive script exists (still needed for PTY sessions)
try {
  const stat = Bun.spawnSync(['test', '-x', reviveScript])
  if (!stat.success) {
    log(`WARNING: Revive script not found or not executable: ${reviveScript}`)
    log('PTY sessions will fail. Headless direct-spawn still works.')
  }
} catch {
  log(`WARNING: Cannot check revive script: ${reviveScript}`)
}

// Check for rclaude binary (needed for headless direct spawn)
const rclaudeBinCheck = findRclaudeBinary()
if (rclaudeBinCheck) {
  log(`rclaude binary: ${rclaudeBinCheck}`)
} else {
  log('WARNING: rclaude binary not found - headless direct spawn will fail')
}

// Load PID registry from previous run and check for dead children
loadAndCheckPidRegistry()

// SIGTERM handler: unref all children so they survive sentinel restart, write PID registry
process.on('SIGTERM', () => {
  log(`SIGTERM received. ${trackedChildren.size} tracked children.`)
  for (const child of trackedChildren.values()) {
    try {
      child.proc.unref()
      log(`Unrefed PID ${child.pid} (wrapper ${child.conversationId.slice(0, 8)})`)
    } catch (e) {
      log(`Failed to unref PID ${child.pid}: ${e}`)
    }
  }
  writePidRegistry()
  log('PID registry written. Exiting.')
  process.exit(0)
})

// Also handle SIGINT for graceful Ctrl-C shutdown
process.on('SIGINT', () => {
  log(`SIGINT received. ${trackedChildren.size} tracked children.`)
  for (const child of trackedChildren.values()) {
    try {
      child.proc.unref()
    } catch {}
  }
  writePidRegistry()
  process.exit(0)
})

log('Starting sentinel (single instance)')
log(`Revive script: ${reviveScript}`)
log(`Spawn root: ${spawnRoot}${noSpawn ? ' (DISABLED)' : ''}`)
connect(brokerUrl, secret, reviveScript, verbose, spawnRoot, noSpawn)
