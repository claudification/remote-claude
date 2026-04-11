#!/usr/bin/env bun
/**
 * rclaude-agent - Host-side agent for session revival
 *
 * Connects to concentrator via WebSocket, listens for revive commands,
 * and spawns tmux + rclaude sessions on the host machine.
 *
 * Only one agent can be connected at a time. If another agent is already
 * connected, this process exits immediately.
 */

import { checkBunVersion } from '../shared/bun-version'

checkBunVersion()

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import type {
  ConcentratorAgentMessage,
  ExtraUsage,
  ListDirsResult,
  ReviveResult,
  SpawnResult,
  UsageUpdate,
  UsageWindow,
} from '../shared/protocol'
import { DEFAULT_CONCENTRATOR_URL, HEARTBEAT_INTERVAL_MS } from '../shared/protocol'

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

// Find revive-session.sh in common locations
function findReviveScript(): string {
  const binDir = dirname(resolve(process.argv[0]))
  const homeLocalBin = `${process.env.HOME || '/root'}/.local/bin`
  const candidates = [
    resolve(binDir, 'revive-session.sh'), // same dir as binary
    resolve(binDir, '../scripts/revive-session.sh'), // dev layout: bin/../scripts/
    resolve(binDir, 'scripts/revive-session.sh'), // compiled binary in project root
    resolve(homeLocalBin, 'revive-session.sh'), // installed to ~/.local/bin
  ]
  for (const path of candidates) {
    if (Bun.spawnSync(['test', '-f', path]).success) return path
  }
  return candidates[0] // will fail at startup validation
}
const DEFAULT_REVIVE_SCRIPT = findReviveScript()

function parseArgs() {
  const args = process.argv.slice(2)
  let concentratorUrl = process.env.RCLAUDE_CONCENTRATOR || DEFAULT_CONCENTRATOR_URL
  let secret = process.env.RCLAUDE_SECRET
  let verbose = false
  let reviveScript = DEFAULT_REVIVE_SCRIPT
  let spawnRoot = process.env.HOME || '/root'
  let noSpawn = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--concentrator') {
      concentratorUrl = args[++i] || DEFAULT_CONCENTRATOR_URL
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

  if (!secret) secret = process.env.RCLAUDE_SECRET

  return { concentratorUrl, secret, verbose, reviveScript, spawnRoot, noSpawn }
}

function printHelp() {
  console.log(`
rclaude-agent - Host-side agent for session revival and spawning

Connects to concentrator and listens for revive/spawn commands.
Spawns tmux + rclaude sessions on the host machine.

USAGE:
  rclaude-agent [OPTIONS]

OPTIONS:
  --concentrator <url>   Concentrator WebSocket URL (default: ${DEFAULT_CONCENTRATOR_URL})
  --secret <s>           Shared secret (or RCLAUDE_SECRET env)
  --revive-script <path> Path to revive-session.sh (default: auto-detected)
  --spawn-root <path>    Root directory for relative spawn paths (default: $HOME)
  -v, --verbose          Enable verbose logging
  -h, --help             Show this help

Spawn security: directories need a .rclaude-spawn marker file at or above
the target path to allow spawning. Only one agent can be connected at a time.
`)
}

// Module-level WS ref for diag()
let activeWs: WebSocket | null = null

function log(msg: string) {
  console.log(`[rclaude-agent] ${msg}`)
}

function debug(msg: string, verbose: boolean) {
  if (verbose) console.log(`[rclaude-agent] ${msg}`)
}

function diag(type: string, msg: string, args?: unknown) {
  log(`[diag] ${type}: ${msg}${args ? ` ${JSON.stringify(args)}` : ''}`)
  if (activeWs?.readyState === WebSocket.OPEN) {
    try {
      activeWs.send(
        JSON.stringify({
          type: 'agent_diag',
          entries: [{ t: Date.now(), type, msg, args }],
        }),
      )
    } catch {}
  }
}

/**
 * Revive a session by calling the external revive-session.sh script.
 * The script handles all tmux logic and can be customized without restarting the agent.
 *
 * Script exit codes: 0=continued, 1=fresh session, 2=dir not found, 3=tmux failed
 * Script stdout: TMUX_SESSION=<name> and CONTINUED=<true|false>
 */
async function reviveSession(
  sessionId: string,
  cwd: string,
  wrapperId: string,
  reviveScript: string,
  secret: string,
  verbose: boolean,
  mode?: string,
  headless = true,
  effort?: string,
  model?: string,
): Promise<ReviveResult> {
  const result: ReviveResult = {
    type: 'revive_result',
    sessionId,
    wrapperId,
    success: false,
    continued: false,
  }

  const scriptArgs = [reviveScript, sessionId, cwd]
  if (mode) scriptArgs.push('--mode', mode)

  debug(`Running: ${scriptArgs.join(' ')}`, verbose)

  const proc = Bun.spawnSync(scriptArgs, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      RCLAUDE_SECRET: secret,
      RCLAUDE_WRAPPER_ID: wrapperId,
      RCLAUDE_SESSION_ID: sessionId,
      ...(headless ? { RCLAUDE_HEADLESS: '1' } : {}),
      ...(effort ? { RCLAUDE_EFFORT: effort } : {}),
      ...(model ? { RCLAUDE_MODEL: model } : {}),
    },
  })

  const stdout = proc.stdout.toString().trim()
  const stderr = proc.stderr.toString().trim()
  const exitCode = proc.exitCode

  if (verbose && stdout) debug(`Script stdout: ${stdout}`, verbose)
  if (stderr) debug(`Script stderr: ${stderr}`, verbose)

  // Parse output lines for TMUX_SESSION= and CONTINUED=
  for (const line of stdout.split('\n')) {
    const [key, value] = line.split('=', 2)
    if (key === 'TMUX_SESSION') result.tmuxSession = value
    if (key === 'CONTINUED') result.continued = value === 'true'
  }

  switch (exitCode) {
    case 0: // success, continued existing session
      result.success = true
      result.continued = true
      break
    case 1: // success, fresh session (--continue failed)
      result.success = true
      result.continued = false
      break
    case 2: // directory not found
      result.error = stderr || `Directory not found: ${cwd}`
      break
    case 3: // tmux spawn failed
      result.error = stderr || 'Failed to create tmux session'
      break
    default:
      result.error = stderr || `Script exited with code ${exitCode}`
  }

  return result
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
 * Reuses revive-session.sh with a synthetic sessionId.
 */
async function spawnSession(
  cwd: string,
  wrapperId: string,
  reviveScript: string,
  secret: string,
  _verbose: boolean,
  mkdir = false,
  mode?: 'fresh' | 'continue' | 'resume',
  resumeId?: string,
  headless = true,
  effort?: string,
  model?: string,
): Promise<{ success: boolean; error?: string; tmuxSession?: string }> {
  // Diagnostic dump
  const whichRclaude = Bun.spawnSync(['which', 'rclaude'])
  diag('spawn', 'Starting spawn', {
    cwd,
    wrapperId,
    mkdir,
    reviveScript,
    reviveScriptExists: existsSync(reviveScript),
    secretSet: !!secret,
    concentratorUrl: process.env.RCLAUDE_CONCENTRATOR || 'UNSET',
    rclaude: whichRclaude.stdout.toString().trim() || 'NOT FOUND',
    PATH: process.env.PATH,
  })

  if (!existsSync(cwd)) {
    if (mkdir) {
      try {
        mkdirSync(cwd, { recursive: true })
        diag('spawn', 'Created directory', { cwd })
      } catch (e: unknown) {
        return { success: false, error: `Failed to create directory: ${(e as Error).message}` }
      }
    } else {
      return { success: false, error: `Directory not found: ${cwd}` }
    }
  }

  if (!isSpawnApproved(cwd)) {
    return { success: false, error: `Spawn not allowed: no .rclaude-spawn marker at or above ${cwd}` }
  }

  // Use "spawn-<timestamp>" as synthetic sessionId (revive-session.sh uses it for tmux window naming)
  const syntheticId = `spawn-${Date.now()}`
  const scriptArgs = [reviveScript, syntheticId, cwd]
  if (mode) scriptArgs.push('--mode', mode)
  if (mode === 'resume' && resumeId) scriptArgs.push('--resume-id', resumeId)
  const scriptEnv = {
    ...process.env,
    RCLAUDE_SECRET: secret,
    RCLAUDE_WRAPPER_ID: wrapperId,
    ...(headless ? { RCLAUDE_HEADLESS: '1' } : {}),
    ...(effort ? { RCLAUDE_EFFORT: effort } : {}),
    ...(model ? { RCLAUDE_MODEL: model } : {}),
  }

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
  const tmuxCheck = Bun.spawnSync(['tmux', 'list-windows', '-t', 'remote-claude'])
  const tmuxWindows = tmuxCheck.stdout.toString().trim()

  diag('spawn', 'Script completed', {
    exitCode,
    stdout,
    stderr: stderr || undefined,
    tmuxWindowsAfter: tmuxWindows || '(none/session gone)',
  })

  let tmuxSession: string | undefined
  for (const line of stdout.split('\n')) {
    const [key, value] = line.split('=', 2)
    if (key === 'TMUX_SESSION') tmuxSession = value
  }

  if (exitCode === 0) {
    return { success: true, tmuxSession }
  }
  return { success: false, error: stderr || `Script exited with code ${exitCode}` }
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
      monthlyLimit: raw.extra_usage.monthly_limit,
      usedCredits: raw.extra_usage.used_credits,
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
      // Never let a poll crash the agent
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
    log('Connected to concentrator')
    activeWs = ws
    // Identify as agent with machine fingerprint
    ws.send(JSON.stringify({ type: 'agent_identify', machineId: getMachineId(), hostname: osHostname() }))

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
      const msg = JSON.parse(String(event.data)) as ConcentratorAgentMessage | { type: string }

      switch (msg.type) {
        case 'ack':
          debug('Agent registered successfully', verbose)
          break

        case 'agent_reject':
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
          const reviveMsg = msg as {
            sessionId: string
            cwd: string
            wrapperId: string
            mode?: string
            headless?: boolean
            effort?: string
            model?: string
          }
          log(
            `Reviving session ${reviveMsg.sessionId.slice(0, 8)}... wrapper=${reviveMsg.wrapperId.slice(0, 8)} mode=${reviveMsg.mode || 'default'} headless=${reviveMsg.headless !== false}${reviveMsg.effort ? ` effort=${reviveMsg.effort}` : ''}${reviveMsg.model ? ` model=${reviveMsg.model}` : ''} (${reviveMsg.cwd})`,
          )
          const result = await reviveSession(
            reviveMsg.sessionId,
            reviveMsg.cwd,
            reviveMsg.wrapperId,
            reviveScript,
            secret,
            verbose,
            reviveMsg.mode,
            reviveMsg.headless !== false,
            reviveMsg.effort,
            reviveMsg.model,
          )
          ws.send(JSON.stringify(result))
          if (result.success) {
            log(`Revived in tmux session "${result.tmuxSession}" (continued: ${result.continued})`)
          } else {
            log(`Revive failed: ${result.error}`)
          }
          break
        }

        case 'spawn': {
          const spawnMsg = msg as {
            requestId: string
            cwd: string
            wrapperId: string
            mkdir?: boolean
            mode?: 'fresh' | 'continue' | 'resume'
            resumeId?: string
            headless?: boolean
            effort?: string
            model?: string
          }
          if (noSpawn) {
            ws.send(
              JSON.stringify({
                type: 'spawn_result',
                requestId: spawnMsg.requestId,
                success: false,
                error: 'Spawning disabled (--no-spawn)',
              }),
            )
            break
          }
          const expandedCwd = expandPath(spawnMsg.cwd, spawnRoot)
          diag('spawn', 'Spawn request received', {
            requestId: spawnMsg.requestId,
            rawCwd: spawnMsg.cwd,
            expandedCwd,
            wrapperId: spawnMsg.wrapperId,
            mkdir: spawnMsg.mkdir,
            mode: spawnMsg.mode,
            resumeId: spawnMsg.resumeId,
          })
          const spawnRes = await spawnSession(
            expandedCwd,
            spawnMsg.wrapperId,
            reviveScript,
            secret,
            verbose,
            spawnMsg.mkdir,
            spawnMsg.mode,
            spawnMsg.resumeId,
            spawnMsg.headless !== false, // default true
            spawnMsg.effort,
            spawnMsg.model,
          )
          const response: SpawnResult = {
            type: 'spawn_result',
            requestId: spawnMsg.requestId,
            success: spawnRes.success,
            error: spawnRes.error,
            tmuxSession: spawnRes.tmuxSession,
            wrapperId: spawnMsg.wrapperId,
          }
          ws.send(JSON.stringify(response))
          diag('spawn', spawnRes.success ? 'Spawn OK' : 'Spawn FAILED', {
            tmuxSession: spawnRes.tmuxSession,
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
      debug(`Failed to parse message: ${err}`, verbose)
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
const { concentratorUrl, secret, verbose, reviveScript, spawnRoot, noSpawn } = parseArgs()

if (!secret) {
  console.error('ERROR: --secret or RCLAUDE_SECRET is required')
  process.exit(1)
}

// Verify revive script exists
try {
  const stat = Bun.spawnSync(['test', '-x', reviveScript])
  if (!stat.success) {
    console.error(`ERROR: Revive script not found or not executable: ${reviveScript}`)
    console.error('Make sure revive-session.sh exists and has +x permission.')
    process.exit(1)
  }
} catch {
  console.error(`ERROR: Cannot check revive script: ${reviveScript}`)
  process.exit(1)
}

log('Starting host agent (single instance)')
log(`Revive script: ${reviveScript}`)
log(`Spawn root: ${spawnRoot}${noSpawn ? ' (DISABLED)' : ''}`)
connect(concentratorUrl, secret, reviveScript, verbose, spawnRoot, noSpawn)
