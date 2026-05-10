/**
 * CLI argument parsing and early environment resolution for rclaude.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { DEFAULT_BROKER_URL } from '../shared/protocol'
import { checkForUpdate, formatUpdateResult, formatVersion } from '../shared/update-check'
import { debug } from './debug'

export interface CliConfig {
  brokerUrl: string
  brokerSecret: string | undefined
  noBroker: boolean
  noTerminal: boolean
  headless: boolean
  channelEnabled: boolean
  isAdHoc: boolean
  adHocTaskId: string | undefined
  adHocWorktree: string | undefined
  includePartialMessages: boolean
  customEnv: Record<string, string>
  claudeArgs: string[]
  configuredModel: string | undefined
  resumeId: string | undefined
}

function detectClaudeVersion(): string | undefined {
  try {
    const claudePath = Bun.which('claude')
    if (!claudePath) return undefined

    const resolved = realpathSync(claudePath)
    const version = basename(resolved)
    if (/^\d+\.\d+\.\d+/.test(version)) {
      debug(`Claude version from symlink: ${version}`)
      return version
    }

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

export { detectClaudeVersion }

interface ClaudeAuthInfo {
  email?: string
  orgId?: string
  orgName?: string
  subscriptionType?: string
}

export function detectClaudeAuth(): ClaudeAuthInfo | undefined {
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

export function readSpinnerVerbs(): string[] | undefined {
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

export function wsToHttpUrl(url: string): string {
  return url.replace('ws://', 'http://').replace('wss://', 'https://')
}

export async function isBrokerReady(url: string): Promise<boolean> {
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
export function setTerminalTitle(cwd: string) {
  const segments = cwd.split('/').filter(Boolean)
  const last2 = segments.slice(-2)
  let title = last2.join('/')

  if (title.length > 20) {
    const right = last2[last2.length - 1]
    if (right.length >= 20) {
      title = right.slice(0, 20)
    } else if (last2.length > 1) {
      const budget = 20 - right.length - 1
      title = budget > 0 ? `${last2[0].slice(0, budget)}/${right}` : right
    }
  }

  title = title.replace(/[\x00-\x1f\x7f]/g, '')
  if (!title) return

  process.title = title
  process.stdout.write(`\x1b]2;${title}\x07`)

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

// Claude CLI subcommands that should be passed through directly (no agent host logic)
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

export function handlePassthroughSubcommand(args: string[]): boolean {
  const firstNonFlag = args.find(a => !a.startsWith('-'))
  if (firstNonFlag && CLAUDE_PASSTHROUGH_SUBCOMMANDS.has(firstNonFlag)) {
    debug(`Passthrough subcommand detected: ${firstNonFlag} -- exec'ing claude directly`)
    const proc = Bun.spawnSync(['claude', ...args], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    process.exit(proc.exitCode ?? 1)
  }
  return false
}

export async function parseCliArgs(args: string[]): Promise<CliConfig> {
  let brokerUrl =
    process.env.CLAUDWERK_BROKER ?? process.env.RCLAUDE_BROKER ?? process.env.RCLAUDE_CONCENTRATOR ?? DEFAULT_BROKER_URL
  let brokerSecret = process.env.CLAUDWERK_SECRET ?? process.env.RCLAUDE_SECRET
  let noBroker = false
  let noTerminal = false
  let headless = process.env.RCLAUDE_HEADLESS === '1'
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

  // Capture --model and --resume from claudeArgs
  let resumeId: string | undefined
  for (let i = 0; i < claudeArgs.length; i++) {
    if (claudeArgs[i] === '--model' && i + 1 < claudeArgs.length) {
      configuredModel = claudeArgs[i + 1]
    } else if (claudeArgs[i] === '--resume' && i + 1 < claudeArgs.length) {
      resumeId = claudeArgs[i + 1]
    }
  }
  if (!configuredModel && process.env.RCLAUDE_MODEL) {
    configuredModel = process.env.RCLAUDE_MODEL
  }

  // Bare mode
  if (process.env.RCLAUDE_BARE === '1' && !claudeArgs.includes('--bare')) {
    claudeArgs.push('--bare')
  }

  // Session name
  if (process.env.CLAUDWERK_CONVERSATION_NAME && !claudeArgs.includes('--name') && !claudeArgs.includes('-n')) {
    claudeArgs.push('--name', process.env.CLAUDWERK_CONVERSATION_NAME)
  }

  // Permission mode
  if (process.env.RCLAUDE_PERMISSION_MODE && !claudeArgs.includes('--permission-mode')) {
    claudeArgs.push('--permission-mode', process.env.RCLAUDE_PERMISSION_MODE)
  }

  // Agent
  if (process.env.RCLAUDE_AGENT && !claudeArgs.includes('--agent')) {
    claudeArgs.push('--agent', process.env.RCLAUDE_AGENT)
  }

  // Headless mode implications
  if (headless) {
    noTerminal = true
    channelEnabled = false
  }

  return {
    brokerUrl,
    brokerSecret,
    noBroker,
    noTerminal,
    headless,
    channelEnabled,
    isAdHoc,
    adHocTaskId,
    adHocWorktree,
    includePartialMessages,
    customEnv,
    claudeArgs,
    configuredModel,
    resumeId,
  }
}

export function extToMediaType(ext: string): string {
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
