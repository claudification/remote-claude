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

export interface OpenCodeMcpRemoteEntry {
  type: 'remote'
  url: string
  headers?: Record<string, string>
  enabled?: boolean
}

export interface OpenCodeConfig {
  $schema?: string
  tools?: Record<string, boolean>
  permission?: Record<string, 'allow' | 'ask' | 'deny'>
  mcp?: Record<string, OpenCodeMcpRemoteEntry>
}

/**
 * Optional MCP wiring. When `brokerMcpUrl` AND `secret` are present, an
 * `mcp.claudwerk` block is emitted that points OpenCode's native MCP client
 * at the broker's `/mcp` endpoint with bearer auth. If either is missing,
 * no block is emitted (defensive: we never expose tools without a target).
 */
export interface OpenCodeMcpBridgeOptions {
  brokerMcpUrl?: string
  secret?: string
}

/** The single MCP server name we register with OpenCode. Mirrors the
 *  Claude-side `claudwerk` MCP server name so dashboards and hooks key on the
 *  same identifier across backends. */
export const OPENCODE_MCP_SERVER_NAME = 'claudwerk'

/**
 * Build an opencode.json config for a given permission tier.
 * Returns null for 'full' WHEN no MCP bridge is configured -- in that case
 * the caller passes --dangerously-skip-permissions and writes no file.
 *
 * If `mcp` options are supplied with both `brokerMcpUrl` and `secret`, the
 * resulting config carries an `mcp.claudwerk` remote-server entry. For the
 * 'full' tier this means a config IS written (so MCP can be discovered) but
 * without `tools` / `permission` -- those keys remain absent and OpenCode
 * keeps its default everything-allowed behaviour.
 */
export function buildOpenCodeConfig(
  tier: OpenCodeToolPermissionTier,
  mcp?: OpenCodeMcpBridgeOptions,
): OpenCodeConfig | null {
  const mcpBlock = buildMcpBlock(mcp)

  if (tier === 'full') {
    if (!mcpBlock) return null
    return {
      $schema: 'https://opencode.ai/config.json',
      mcp: mcpBlock,
    }
  }

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

  const cfg: OpenCodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    tools,
    permission,
  }
  if (mcpBlock) cfg.mcp = mcpBlock
  return cfg
}

function buildMcpBlock(mcp?: OpenCodeMcpBridgeOptions): Record<string, OpenCodeMcpRemoteEntry> | null {
  if (!mcp) return null
  const { brokerMcpUrl, secret } = mcp
  if (!brokerMcpUrl || !secret) return null
  return {
    [OPENCODE_MCP_SERVER_NAME]: {
      type: 'remote',
      url: brokerMcpUrl,
      headers: { Authorization: `Bearer ${secret}` },
      enabled: true,
    },
  }
}

/**
 * Convert a broker WebSocket URL (ws:// or wss://) to its HTTP MCP endpoint
 * (http(s)://<host>/mcp). The broker mounts MCP at `/mcp` regardless of the
 * WebSocket entrypoint. Returns null when the URL is missing or unparseable
 * so the caller skips MCP wiring rather than emitting a broken config.
 */
export function brokerMcpUrlFromWs(brokerWsUrl: string | undefined): string | null {
  if (!brokerWsUrl) return null
  try {
    const u = new URL(brokerWsUrl)
    if (u.protocol === 'ws:') u.protocol = 'http:'
    else if (u.protocol === 'wss:') u.protocol = 'https:'
    else if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    // Broker mounts the MCP router at the root path /mcp, regardless of any
    // path prefix on the WS URL. Replace the pathname outright.
    u.pathname = '/mcp'
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return null
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

/**
 * Hard-coded fallback OpenCode model ID. Used when neither the spawn request,
 * the per-project default, nor the global default supplied a model. Picked
 * because opencode-go/glm-5.1 is the OpenCode Go default and ships with a
 * working free tier under the user's `opencode auth login` token.
 */
export const OPENCODE_FALLBACK_MODEL = 'opencode-go/glm-5.1'

/**
 * Resolve the effective OpenCode model from explicit > project > global > fallback.
 * Empty strings are treated as unset. Returns OPENCODE_FALLBACK_MODEL when
 * everything is empty -- callers that want the empty / "OpenCode default"
 * sentinel should check before calling this.
 */
export function resolveOpenCodeModel(
  explicit: string | undefined,
  projectDefault: string | undefined,
  globalDefault: string | undefined,
): string {
  return (explicit?.trim() || projectDefault?.trim() || globalDefault?.trim() || OPENCODE_FALLBACK_MODEL) as string
}
