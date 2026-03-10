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

import { dirname, resolve } from 'node:path'
import type { ConcentratorAgentMessage, ReviveResult } from '../shared/protocol'
import { DEFAULT_CONCENTRATOR_URL } from '../shared/protocol'

const RECONNECT_DELAY_MS = 5000
const HEARTBEAT_INTERVAL_MS = 30000

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
  let concentratorUrl = DEFAULT_CONCENTRATOR_URL
  let secret = process.env.RCLAUDE_SECRET
  let verbose = false
  let reviveScript = DEFAULT_REVIVE_SCRIPT

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--concentrator') {
      concentratorUrl = args[++i] || DEFAULT_CONCENTRATOR_URL
    } else if (arg === '--secret') {
      secret = args[++i]
    } else if (arg === '--revive-script') {
      reviveScript = resolve(args[++i])
    } else if (arg === '-v' || arg === '--verbose') {
      verbose = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  if (!secret) secret = process.env.RCLAUDE_SECRET

  return { concentratorUrl, secret, verbose, reviveScript }
}

function printHelp() {
  console.log(`
rclaude-agent - Host-side agent for session revival

Connects to concentrator and listens for revive commands.
Spawns tmux + rclaude sessions on the host machine.

USAGE:
  rclaude-agent [OPTIONS]

OPTIONS:
  --concentrator <url>   Concentrator WebSocket URL (default: ${DEFAULT_CONCENTRATOR_URL})
  --secret <s>           Shared secret (or RCLAUDE_SECRET env)
  --revive-script <path> Path to revive-session.sh (default: auto-detected)
  -v, --verbose          Enable verbose logging
  -h, --help             Show this help

Only one agent can be connected at a time.
`)
}

function log(msg: string) {
  console.log(`[rclaude-agent] ${msg}`)
}

function debug(msg: string, verbose: boolean) {
  if (verbose) console.log(`[rclaude-agent] ${msg}`)
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
): Promise<ReviveResult> {
  const result: ReviveResult = {
    type: 'revive_result',
    sessionId,
    wrapperId,
    success: false,
    continued: false,
  }

  debug(`Running: ${reviveScript} ${sessionId} ${cwd}`, verbose)

  const proc = Bun.spawnSync([reviveScript, sessionId, cwd], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, RCLAUDE_SECRET: secret, RCLAUDE_WRAPPER_ID: wrapperId },
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

function connect(url: string, secret: string, reviveScript: string, verbose: boolean) {
  const wsUrl = secret ? `${url}?secret=${encodeURIComponent(secret)}` : url
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let shouldReconnect = true

  log(`Connecting to ${url}...`)

  const ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    log('Connected to concentrator')
    // Identify as agent
    ws.send(JSON.stringify({ type: 'agent_identify' }))

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

        case 'quit':
          log(`Quit requested: ${'reason' in msg ? msg.reason : 'no reason'}`)
          shouldReconnect = false
          ws.close()
          process.exit(0)

        case 'revive': {
          const reviveMsg = msg as { sessionId: string; cwd: string; wrapperId: string }
          log(`Reviving session ${reviveMsg.sessionId.slice(0, 8)}... wrapper=${reviveMsg.wrapperId.slice(0, 8)} (${reviveMsg.cwd})`)
          const result = await reviveSession(reviveMsg.sessionId, reviveMsg.cwd, reviveMsg.wrapperId, reviveScript, secret, verbose)
          ws.send(JSON.stringify(result))
          if (result.success) {
            log(`Revived in tmux session "${result.tmuxSession}" (continued: ${result.continued})`)
          } else {
            log(`Revive failed: ${result.error}`)
          }
          break
        }
      }
    } catch (err) {
      debug(`Failed to parse message: ${err}`, verbose)
    }
  }

  ws.onclose = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)

    if (shouldReconnect) {
      log(`Disconnected. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`)
      setTimeout(() => connect(url, secret, reviveScript, verbose), RECONNECT_DELAY_MS)
    }
  }

  ws.onerror = err => {
    debug(`WebSocket error: ${err}`, verbose)
  }
}

// Main
const { concentratorUrl, secret, verbose, reviveScript } = parseArgs()

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
connect(concentratorUrl, secret, reviveScript, verbose)
