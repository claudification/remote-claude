/**
 * Settings Merge Module
 * Reads user's Claude settings and injects hook configurations
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveScript } from '../shared/resolve-script'

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
  if?: string // CC 2.1.85+: permission rule syntax filter (e.g. "AskUserQuestion", "Bash(git *)")
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
    CwdChanged?: HookMatcher[]
    FileChanged?: HookMatcher[]
    TaskCreated?: HookMatcher[]
    PermissionDenied?: HookMatcher[]
    [key: string]: HookMatcher[] | undefined
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
  // NOTE: WorktreeCreate and WorktreeRemove are registered separately below
  // (not as notification forwarders). CC delegates the actual worktree
  // creation/removal to these hooks. See registerWorktreeHooks().
  'Setup',
] as const

/**
 * Hook events added in specific Claude Code versions.
 * Each entry maps a minimum version to the events it introduced.
 */
const VERSIONED_HOOK_EVENTS: { minVersion: string; events: string[] }[] = [
  { minVersion: '2.1.76', events: ['PostCompact', 'Elicitation', 'ElicitationResult', 'StopFailure'] },
  { minVersion: '2.1.83', events: ['CwdChanged', 'FileChanged'] },
  { minVersion: '2.1.84', events: ['TaskCreated'] },
  { minVersion: '2.1.88', events: ['PermissionDenied'] },
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
  const events: string[] = [...CORE_HOOK_EVENTS]
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
    } catch (_error) {
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
export async function generateMergedSettings(
  sessionId: string,
  port: number,
  claudeVersion?: string,
): Promise<ClaudeSettings> {
  const userSettings = await readUserSettings()

  // Create our hook configuration, filtered by Claude Code version
  const supportedEvents = getSupportedHookEvents(claudeVersion)
  const ourHooks: ClaudeSettings['hooks'] = {}
  for (const event of supportedEvents) {
    ourHooks[event as keyof ClaudeSettings['hooks']] = [createHookMatcher(event, port, sessionId)]
  }

  // WorktreeCreate: custom hook that branches from local HEAD instead of origin/HEAD.
  // CC delegates the entire worktree creation to this hook when registered.
  // The script reads JSON from stdin, creates the worktree, and prints the path to stdout.
  // Resolved via layered lookup: $RCLAUDE_SCRIPTS -> XDG data dir -> embedded fallback.
  const createScript = resolveScript('worktree-create.sh')
  if (createScript) {
    ourHooks.WorktreeCreate = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: `bash "${createScript}"` }],
      },
    ]
  }

  // WorktreeRemove: safety-net hook that checks for unmerged work before cleanup.
  // CC ignores exit codes for this hook, so failures are logged but don't block.
  const removeScript = resolveScript('worktree-remove.sh')
  if (removeScript) {
    ourHooks.WorktreeRemove = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: `bash "${removeScript}"` }],
      },
    ]
  }

  // CC 2.1.85+: Add a long-timeout PreToolUse hook specifically for AskUserQuestion.
  // Uses the `if` field to only fire for AskUserQuestion tool calls.
  // The general PreToolUse hook (3s) still fires for tracking; this one blocks
  // until the dashboard user answers (or 120s timeout, whichever comes first).
  if (claudeVersion && isVersionAtLeast(claudeVersion, '2.1.85')) {
    const askHook: HookMatcher = {
      matcher: '',
      if: 'AskUserQuestion',
      hooks: [
        {
          type: 'command',
          command: `curl -sf --max-time 120 -X POST "http://127.0.0.1:${port}/hook/AskUserQuestion" -H "Content-Type: application/json" -H "X-Session-Id: ${sessionId}" -d @- 2>/dev/null || true`,
        },
      ],
    }
    ourHooks.PreToolUse = [...(ourHooks.PreToolUse || []), askHook]

    // Block CC's built-in SendMessage tool -- it writes to a local file inbox
    // that nobody reads. Sessions must use mcp__rclaude__send_message instead,
    // which routes through the concentrator where messages are visible and delivered.
    const blockSendMessage: HookMatcher = {
      matcher: '',
      if: 'SendMessage',
      hooks: [
        {
          type: 'command',
          // Read stdin (CC passes event data), check tool_name, only block SendMessage.
          // The `if` field SHOULD filter this but is broken (fires for all tools).
          // Belt-and-suspenders: command itself validates tool_name via jq.
          command: `read -r data; tool=$(echo "$data" | jq -r '.tool_name // empty' 2>/dev/null); if [ "$tool" = "SendMessage" ]; then echo '{"decision":"block","reason":"BLOCKED: Do NOT use the built-in SendMessage tool. Use mcp__rclaude__send_message instead -- it routes through the concentrator where messages are actually delivered to the target session."}'; fi`,
        },
      ],
    }
    ourHooks.PreToolUse = [...(ourHooks.PreToolUse || []), blockSendMessage]
  }

  // Whitelist our local hook server URLs for HTTP hooks
  const allowedHttpHookUrls = [`http://127.0.0.1:${port}/*`]

  // Merge with user's settings (our hooks first, then user's)
  return deepMerge(userSettings, { hooks: ourHooks, allowedHttpHookUrls })
}

/**
 * Write merged settings to a temp file and return the path
 */
export async function writeMergedSettings(
  sessionId: string,
  port: number,
  claudeVersion?: string,
  dir?: string,
): Promise<string> {
  const settings = await generateMergedSettings(sessionId, port, claudeVersion)
  const settingsPath = dir ? `${dir}/settings/settings-${sessionId}.json` : `/tmp/rclaude-settings-${sessionId}.json`

  await Bun.write(settingsPath, JSON.stringify(settings, null, 2))
  console.log(
    `[settings] Written ${settingsPath} (port=${port} session=${sessionId.slice(0, 8)} hooks=${Object.keys(settings.hooks || {}).length})`,
  )

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

  await Bun.write(mcpPath, `${JSON.stringify({ ...existing, mcpServers }, null, 2)}\n`)
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
      await Bun.write(mcpPath, `${JSON.stringify(config, null, 2)}\n`)
    }
  } catch {
    /* ignore */
  }
}

/**
 * Clean up the temp settings file
 */
export async function cleanupSettings(sessionId: string, dir?: string): Promise<void> {
  const settingsPath = dir ? `${dir}/settings/settings-${sessionId}.json` : `/tmp/rclaude-settings-${sessionId}.json`
  try {
    ;(await Bun.file(settingsPath).exists()) && (await Bun.$`rm ${settingsPath}`.quiet())
  } catch {
    // Ignore cleanup errors
  }
}
