/**
 * Pure helpers for generating an `opencode.json` configuration object from a
 * tool-permission tier. The agent host writes this config to a temp file per
 * conversation and points OpenCode at it via the `OPENCODE_CONFIG` env var.
 *
 * Tiers (matches Phase 2 of plan-opencode-backend.md):
 *   - 'none' = pure chat. All 13 OpenCode tools disabled.
 *   - 'safe' = read-only tools (read, glob, grep, ls, webfetch). bash/write/
 *     edit are disabled at the schema level so OpenCode won't even surface
 *     them to the model.
 *   - 'full' = no config -- spawn with `--dangerously-skip-permissions`.
 *     Returns null so the caller skips writing a file.
 *
 * The schema is the subset documented at https://opencode.ai/docs/config/.
 * `tools: { name: false }` removes the tool from the agent's tool list
 * entirely; `permission: { name: 'deny' }` tells OpenCode to refuse if
 * something tries to invoke it. We set both for defense in depth.
 */
export type OpenCodeToolPermissionTier = 'none' | 'safe' | 'full'

/** All tool names OpenCode supports as of opencode-ai 1.14.46. */
export const OPENCODE_ALL_TOOLS = [
  'bash',
  'edit',
  'write',
  'read',
  'grep',
  'glob',
  'ls',
  'webfetch',
  'task',
  'todoread',
  'todowrite',
  'patch',
  'multiedit',
] as const

/** Tools that are safe to expose without filesystem-write or shell access. */
export const OPENCODE_SAFE_TOOLS = ['read', 'grep', 'glob', 'ls', 'webfetch'] as const

export interface OpenCodeConfig {
  $schema?: string
  tools?: Record<string, boolean>
  permission?: Record<string, 'allow' | 'ask' | 'deny'>
}

/**
 * Build an opencode.json config for a given permission tier.
 * Returns null for 'full' (caller should pass --dangerously-skip-permissions
 * and not write a config file).
 */
export function buildOpenCodeConfig(tier: OpenCodeToolPermissionTier): OpenCodeConfig | null {
  if (tier === 'full') return null

  const tools: Record<string, boolean> = {}
  const permission: Record<string, 'allow' | 'ask' | 'deny'> = {}

  if (tier === 'none') {
    for (const t of OPENCODE_ALL_TOOLS) {
      tools[t] = false
      permission[t] = 'deny'
    }
  } else {
    // 'safe' -- enable read-only tools, deny everything else.
    const safeSet = new Set<string>(OPENCODE_SAFE_TOOLS)
    for (const t of OPENCODE_ALL_TOOLS) {
      const allowed = safeSet.has(t)
      tools[t] = allowed
      permission[t] = allowed ? 'allow' : 'deny'
    }
  }

  return {
    $schema: 'https://opencode.ai/config.json',
    tools,
    permission,
  }
}

/**
 * Whether to pass --dangerously-skip-permissions to `opencode run`.
 * Only true for the 'full' tier.
 */
export function shouldSkipPermissions(tier: OpenCodeToolPermissionTier): boolean {
  return tier === 'full'
}

/** Default tier when nothing else is specified (project setting unset, no
 *  explicit request value). Defensive choice: read-only. */
export const DEFAULT_OPENCODE_TOOL_PERMISSION: OpenCodeToolPermissionTier = 'safe'

export function normalizeTier(value: unknown): OpenCodeToolPermissionTier {
  if (value === 'none' || value === 'safe' || value === 'full') return value
  return DEFAULT_OPENCODE_TOOL_PERMISSION
}
