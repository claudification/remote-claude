/**
 * Settings Merge Module
 * Reads user's Claude settings and injects hook configurations
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

interface CommandHook {
  type: 'command'
  command: string
}

interface HttpHook {
  type: 'http'
  url: string
  timeout?: number
  headers?: Record<string, string>
}

type Hook = CommandHook | HttpHook

interface HookMatcher {
  matcher: string
  hooks: Hook[]
}

interface ClaudeSettings {
  hooks?: {
    SessionStart?: HookMatcher[]
    UserPromptSubmit?: HookMatcher[]
    PreToolUse?: HookMatcher[]
    PostToolUse?: HookMatcher[]
    PostToolUseFailure?: HookMatcher[]
    Notification?: HookMatcher[]
    Stop?: HookMatcher[]
    SessionEnd?: HookMatcher[]
    SubagentStart?: HookMatcher[]
    SubagentStop?: HookMatcher[]
    PreCompact?: HookMatcher[]
    PostCompact?: HookMatcher[]
    PermissionRequest?: HookMatcher[]
    TeammateIdle?: HookMatcher[]
    TaskCompleted?: HookMatcher[]
    InstructionsLoaded?: HookMatcher[]
    ConfigChange?: HookMatcher[]
    WorktreeCreate?: HookMatcher[]
    WorktreeRemove?: HookMatcher[]
    Elicitation?: HookMatcher[]
    ElicitationResult?: HookMatcher[]
    StopFailure?: HookMatcher[]
    Setup?: HookMatcher[]
  }
  [key: string]: unknown
}

/**
 * Core hook events supported by all Claude Code versions with hooks support.
 */
const CORE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PermissionRequest',
  'TeammateIdle',
  'TaskCompleted',
  'InstructionsLoaded',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'Setup',
] as const

/**
 * Hook events added in specific Claude Code versions.
 * Each entry maps a minimum version to the events it introduced.
 */
const VERSIONED_HOOK_EVENTS: { minVersion: string; events: string[] }[] = [
  { minVersion: '2.1.76', events: ['PostCompact', 'Elicitation', 'ElicitationResult', 'StopFailure'] },
]

/**
 * Compare two semver version strings. Returns true if actual >= required.
 */
function isVersionAtLeast(actual: string, required: string): boolean {
  const [aMajor, aMinor, aPatch] = actual.split('.').map(Number)
  const [rMajor, rMinor, rPatch] = required.split('.').map(Number)
  if (aMajor !== rMajor) return aMajor > rMajor
  if (aMinor !== rMinor) return aMinor > rMinor
  return aPatch >= rPatch
}

/**
 * Get the list of hook events supported by the given Claude Code version.
 */
function getSupportedHookEvents(claudeVersion?: string): string[] {
  const events = [...CORE_HOOK_EVENTS]
  if (claudeVersion) {
    for (const { minVersion, events: versionEvents } of VERSIONED_HOOK_EVENTS) {
      if (isVersionAtLeast(claudeVersion, minVersion)) {
        events.push(...versionEvents)
      }
    }
  }
  return events
}

/**
 * Read user's existing Claude settings
 */
async function readUserSettings(): Promise<ClaudeSettings> {
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  const file = Bun.file(settingsPath)

  if (await file.exists()) {
    try {
      return (await file.json()) as ClaudeSettings
    } catch (error) {
      // Silently fall back to empty settings on parse error
      return {}
    }
  }

  return {}
}

/**
 * Create hook matcher for forwarding to local server
 * NOTE: HTTP hooks only support tool-related events (PreToolUse, PostToolUse, Stop, etc.)
 * by design. Lifecycle events (SessionStart, SessionEnd, SubagentStart, PreCompact, etc.)
 * are command-only. Since rclaude needs SessionStart for session_id + transcript_path,
 * we use command+curl for all hooks.
 */
function createHookMatcher(hookEvent: string, port: number, sessionId: string): HookMatcher {
  return {
    matcher: '', // Match all
    hooks: [
      {
        type: 'command',
        command: `curl -sf --max-time 3 -X POST "http://127.0.0.1:${port}/hook/${hookEvent}" -H "Content-Type: application/json" -H "X-Session-Id: ${sessionId}" -d @- 2>/dev/null || true`,
      },
    ],
  }
}

/**
 * Deep merge two objects, with second object taking precedence
 */
function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result = { ...base } as T

  for (const key in override) {
    const overrideValue = override[key]
    const baseValue = result[key]

    if (
      overrideValue &&
      typeof overrideValue === 'object' &&
      !Array.isArray(overrideValue) &&
      baseValue &&
      typeof baseValue === 'object' &&
      !Array.isArray(baseValue)
    ) {
      result[key] = deepMerge(
        baseValue as Record<string, unknown>,
        overrideValue as Record<string, unknown>,
      ) as T[Extract<keyof T, string>]
    } else if (Array.isArray(overrideValue) && Array.isArray(baseValue)) {
      // For arrays (like hook matchers), prepend our hooks to preserve user's
      result[key] = [...overrideValue, ...baseValue] as T[Extract<keyof T, string>]
    } else if (overrideValue !== undefined) {
      result[key] = overrideValue as T[Extract<keyof T, string>]
    }
  }

  return result
}

/**
 * Generate merged settings with hook injection
 */
export async function generateMergedSettings(sessionId: string, port: number, claudeVersion?: string): Promise<ClaudeSettings> {
  const userSettings = await readUserSettings()

  // Create our hook configuration, filtered by Claude Code version
  const supportedEvents = getSupportedHookEvents(claudeVersion)
  const ourHooks: ClaudeSettings['hooks'] = {}
  for (const event of supportedEvents) {
    ourHooks[event as keyof ClaudeSettings['hooks']] = [createHookMatcher(event, port, sessionId)]
  }

  // Whitelist our local hook server URLs for HTTP hooks
  const allowedHttpHookUrls = [`http://127.0.0.1:${port}/*`]

  // Merge with user's settings (our hooks first, then user's)
  return deepMerge(userSettings, { hooks: ourHooks, allowedHttpHookUrls })
}

/**
 * Write merged settings to a temp file and return the path
 */
export async function writeMergedSettings(sessionId: string, port: number, claudeVersion?: string): Promise<string> {
  const settings = await generateMergedSettings(sessionId, port, claudeVersion)
  const settingsPath = `/tmp/rclaude-settings-${sessionId}.json`

  await Bun.write(settingsPath, JSON.stringify(settings, null, 2))

  return settingsPath
}

/**
 * Write .mcp.json for channel support.
 * Merges rclaude MCP server into existing project .mcp.json without overwriting user servers.
 */
export async function writeMcpConfig(cwd: string, port: number): Promise<void> {
  const mcpPath = join(cwd, '.mcp.json')
  let existing: Record<string, unknown> = {}
  try {
    const file = Bun.file(mcpPath)
    if (await file.exists()) {
      existing = JSON.parse(await file.text())
    }
  } catch {
    /* no existing config or parse error */
  }

  const mcpServers = (existing.mcpServers || {}) as Record<string, unknown>
  mcpServers.rclaude = {
    type: 'http',
    url: `http://localhost:${port}/mcp`,
  }

  await Bun.write(mcpPath, JSON.stringify({ ...existing, mcpServers }, null, 2) + '\n')
}

/**
 * Remove rclaude entry from .mcp.json on cleanup
 */
export async function cleanupMcpConfig(cwd: string): Promise<void> {
  const mcpPath = join(cwd, '.mcp.json')
  try {
    const file = Bun.file(mcpPath)
    if (!(await file.exists())) return
    const config = JSON.parse(await file.text())
    const mcpServers = config.mcpServers as Record<string, unknown> | undefined
    if (mcpServers?.rclaude) {
      delete mcpServers.rclaude
      await Bun.write(mcpPath, JSON.stringify(config, null, 2) + '\n')
    }
  } catch {
    /* ignore */
  }
}

/**
 * Clean up the temp settings file
 */
export async function cleanupSettings(sessionId: string): Promise<void> {
  const settingsPath = `/tmp/rclaude-settings-${sessionId}.json`
  try {
    ;(await Bun.file(settingsPath).exists()) && (await Bun.$`rm ${settingsPath}`.quiet())
  } catch {
    // Ignore cleanup errors
  }
}
