/**
 * Per-agent ACP launch recipes.
 *
 * The sentinel owns this table -- it knows how to spawn each ACP-speaking
 * agent. The acp-host binary itself is agent-agnostic; the recipe carries
 * everything that varies per backend (the spawn command, the model env
 * mapping, any optional permission-config preamble).
 *
 * Adding a new agent is a single entry here plus optional auth notes.
 *
 * The recipe is consumed at spawn time to:
 *   - decide if the agent's CLI is installed (prerequisite check)
 *   - assemble the env payload that the acp-host reads (ACP_AGENT_*)
 *   - apply any agent-specific permission preamble (e.g. OpenCode wants a
 *     small opencode.json with permission: { bash: 'ask' } when tier !== full)
 *
 * The host knows none of this; it just executes the recipe.
 */

export type AcpToolPermissionTier = 'none' | 'safe' | 'full'

export interface AcpRecipe {
  /** Stable name used in spawn requests (`acpAgent: 'opencode'`). */
  name: string
  /** Human-readable label for logs / dashboards. */
  label: string
  /** argv to spawn the agent's ACP server. Resolved relative to PATH. */
  cmd: string[]
  /** prerequisite-check helper -- returns the resolved binary or null when
   *  not installed. The sentinel uses this to fail fast with a helpful
   *  install hint instead of letting the spawn die. */
  resolveBin: () => string | null
  /** Build any agent-specific files (e.g. an opencode.json carrying the
   *  permission preamble) and return env additions + a cleanup callback.
   *  Called lazily by the sentinel right before spawn. */
  prepare?: (input: PrepareInput) => PreparedRecipe
}

export interface PrepareInput {
  conversationId: string
  cwd: string
  toolPermission: AcpToolPermissionTier
}

export interface PreparedRecipe {
  /** Env additions to layer on top of the base ACP_AGENT_* env. */
  env: Record<string, string>
  /** Cleanup hook -- called when the conversation ends. Best-effort. */
  cleanup?: () => void
}

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Read the user's global opencode.json (model, mcp servers, provider config)
 * so we can merge our permission overlay on top instead of replacing it.
 *
 * Returns an empty object when the file is missing or unparseable -- the
 * caller treats "no user config" the same as "user has nothing to inherit".
 */
function readUserOpenCodeConfig(): Record<string, unknown> {
  // OpenCode reads `~/.config/opencode/opencode.json` by default
  // (XDG_CONFIG_HOME/opencode/opencode.json on Linux). We use the simple
  // path -- macOS users don't typically set XDG_CONFIG_HOME and the file
  // path matches what `opencode config` writes.
  const path = join(homedir(), '.config', 'opencode', 'opencode.json')
  try {
    const text = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Missing / unparseable -- treat as empty.
  }
  return {}
}

/**
 * OpenCode recipe. Merges the user's global ~/.config/opencode/opencode.json
 * with a permission overlay derived from the tier, writes the merged config
 * to a per-conversation temp dir, and points OpenCode at it via OPENCODE_CONFIG.
 *
 * The merge preserves the user's model selection, MCP servers, provider
 * config, and any other settings -- they show up as `currentValue` in the
 * `session/new` configOptions response so the dashboard / host respects them.
 *
 * For tier='full' we skip the overlay entirely. OpenCode reads the user's
 * config directly via its default search path; nothing for us to do.
 */
export const OPENCODE_RECIPE: AcpRecipe = {
  name: 'opencode',
  label: 'OpenCode',
  cmd: ['opencode', 'acp'],
  resolveBin: () => Bun.which('opencode'),
  prepare: ({ conversationId, toolPermission }) => {
    if (toolPermission === 'full') {
      // Full tier wants no permission prompts at all -- skip the overlay.
      // OpenCode reads the user's ~/.config/opencode/opencode.json directly.
      const empty: Record<string, string> = {}
      return { env: empty }
    }
    const dir = join(tmpdir(), 'acp-host', conversationId)
    try { mkdirSync(dir, { recursive: true }) } catch {}
    const path = join(dir, 'opencode.json')
    const userConfig = readUserOpenCodeConfig()
    // Permission overlay: 'ask' on mutating tools so OpenCode emits
    // session/request_permission. The host's tier-driven decidePermission()
    // answers those requests. Merge (don't replace) any existing permission
    // block in the user's config so they can still tighten beyond our default.
    const userPerm = (userConfig.permission && typeof userConfig.permission === 'object'
      ? userConfig.permission
      : {}) as Record<string, unknown>
    const merged = {
      ...userConfig,
      $schema: 'https://opencode.ai/config.json',
      permission: {
        ...userPerm,
        bash: 'ask',
        edit: 'ask',
        write: 'ask',
        patch: 'ask',
        multiedit: 'ask',
      },
    }
    writeFileSync(path, JSON.stringify(merged, null, 2), 'utf8')
    return {
      // OPENCODE_CONFIG points at our merged file. We deliberately do NOT
      // set OPENCODE_DISABLE_PROJECT_CONFIG: the user's project-level
      // opencode.json (in the cwd) can still apply on top -- consistent
      // with how OpenCode normally layers config.
      env: { OPENCODE_CONFIG: path },
      cleanup: () => {
        try { rmSync(dir, { recursive: true, force: true }) } catch {}
      },
    }
  },
}

const RECIPES = new Map<string, AcpRecipe>([[OPENCODE_RECIPE.name, OPENCODE_RECIPE]])

export function getAcpRecipe(name: string): AcpRecipe | null {
  return RECIPES.get(name) ?? null
}

/** All registered recipes (e.g. for sentinel diagnostic endpoints). */
export function listAcpRecipes(): AcpRecipe[] {
  return [...RECIPES.values()]
}
