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

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * OpenCode recipe. The agent's permission policy is governed by an
 * opencode.json the recipe writes into a per-conversation temp dir; OpenCode
 * picks it up via OPENCODE_CONFIG. The same permission strings the
 * NDJSON path uses ('ask' for tools that should hit session/request_permission)
 * apply here -- the acp-host's tier-driven decidePermission() answers those
 * requests.
 */
export const OPENCODE_RECIPE: AcpRecipe = {
  name: 'opencode',
  label: 'OpenCode',
  cmd: ['opencode', 'acp'],
  resolveBin: () => Bun.which('opencode'),
  prepare: ({ conversationId, toolPermission }) => {
    if (toolPermission === 'full') {
      // Full tier wants no permission prompts at all -- skip the preamble.
      // OpenCode runs everything; the host never sees session/request_permission.
      const empty: Record<string, string> = {}
      return { env: empty }
    }
    const dir = join(tmpdir(), 'acp-host', conversationId)
    try { mkdirSync(dir, { recursive: true }) } catch {}
    const path = join(dir, 'opencode.json')
    // Set permission: 'ask' on the mutating tools so OpenCode emits
    // session/request_permission. The host then answers per tier (safe ->
    // allow read-family, reject mutating; none -> reject all).
    writeFileSync(
      path,
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          permission: { bash: 'ask', edit: 'ask', write: 'ask', patch: 'ask', multiedit: 'ask' },
        },
        null,
        2,
      ),
      'utf8',
    )
    return {
      env: { OPENCODE_CONFIG: path, OPENCODE_DISABLE_PROJECT_CONFIG: 'true' },
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
