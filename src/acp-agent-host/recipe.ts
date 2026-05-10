/**
 * Per-agent recipe parsing for the generic ACP host.
 *
 * The sentinel owns the recipe table and forwards a recipe to the host via
 * env vars when it spawns the binary. The host is agent-agnostic; the recipe
 * is the only thing that varies per backend (opencode / codex / gemini / ...).
 *
 * Recipe shape (env vars set by the sentinel):
 *
 *   ACP_AGENT_NAME            "opencode" | "codex" | ...   (informational)
 *   ACP_AGENT_CMD_JSON        '["opencode","acp"]'         (argv to spawn)
 *   ACP_AGENT_MCP_NAME        "claudwerk"                  (server name in mcpServers; default 'claudwerk')
 *   ACP_AGENT_INITIAL_MODEL   provider/model id            (set via session/set_config_option after session/new)
 *   ACP_TOOL_PERMISSION       "none" | "safe" | "full"     (drives request_permission answers)
 *
 * Plus the standard host-shared envs (RCLAUDE_BROKER, RCLAUDE_SECRET,
 * RCLAUDE_CONVERSATION_ID, RCLAUDE_INITIAL_PROMPT_FILE, ...).
 *
 * The ACP recipe purposefully does NOT carry MCP URL/secret -- those derive
 * from RCLAUDE_BROKER / RCLAUDE_SECRET, same as the OpenCode-NDJSON path.
 *
 * No agent-specific knowledge in this file; it just parses what the sentinel
 * sets. The recipe REGISTRY (which agents map to which cmd) lives in
 * src/sentinel/acp-recipes.ts.
 */

export type AcpToolPermissionTier = 'none' | 'safe' | 'full'

export interface AcpRecipe {
  agentName: string
  agentCmd: string[]
  /** MCP server name used when wiring the broker MCP into the ACP session.
   *  Defaults to 'claudwerk' to match the Claude / OpenCode-NDJSON paths. */
  mcpServerName: string
  /** If set, the host calls session/set_config_option { configId: 'model' }
   *  after session/new to switch models. Maps to the "model" configOption
   *  every ACP-speaking agent we care about exposes. */
  initialModel: string | null
  toolPermission: AcpToolPermissionTier
}

export interface ParsedHostConfig {
  recipe: AcpRecipe
  brokerUrl: string
  brokerSecret: string | undefined
  conversationId: string
  cwd: string
  initialPromptFile: string | null
  conversationTitle: string | null
  conversationDescription: string | null
  /** Existing ACP session id, if the conversation is being resumed. The host
   *  calls session/load instead of session/new when set. */
  resumeSessionId: string | null
  debug: boolean
}

export class RecipeParseError extends Error {}

function normalizeTier(value: unknown): AcpToolPermissionTier {
  if (value === 'none' || value === 'safe' || value === 'full') return value
  return 'safe'
}

/** Parse an `ACP_AGENT_CMD_JSON` value. Accepts JSON array of strings. */
export function parseAgentCmd(json: string | undefined): string[] {
  if (!json) throw new RecipeParseError('ACP_AGENT_CMD_JSON is required')
  let arr: unknown
  try {
    arr = JSON.parse(json)
  } catch (e) {
    throw new RecipeParseError(`ACP_AGENT_CMD_JSON: invalid JSON (${(e as Error).message})`)
  }
  if (!Array.isArray(arr) || arr.length === 0 || arr.some(x => typeof x !== 'string' || !x)) {
    throw new RecipeParseError(`ACP_AGENT_CMD_JSON: expected non-empty array of non-empty strings, got ${json}`)
  }
  return arr as string[]
}

export function parseRecipe(env: Record<string, string | undefined>): AcpRecipe {
  const agentName = env.ACP_AGENT_NAME?.trim() || 'unknown'
  const agentCmd = parseAgentCmd(env.ACP_AGENT_CMD_JSON)
  const mcpServerName = env.ACP_AGENT_MCP_NAME?.trim() || 'claudwerk'
  const initialModel = env.ACP_AGENT_INITIAL_MODEL?.trim() || null
  const toolPermission = normalizeTier(env.ACP_TOOL_PERMISSION)
  return { agentName, agentCmd, mcpServerName, initialModel, toolPermission }
}

export function parseHostConfig(env: Record<string, string | undefined>, defaultBroker: string): ParsedHostConfig {
  const conversationId = env.RCLAUDE_CONVERSATION_ID
  if (!conversationId) throw new RecipeParseError('RCLAUDE_CONVERSATION_ID is required')
  return {
    recipe: parseRecipe(env),
    brokerUrl: env.RCLAUDE_BROKER || defaultBroker,
    brokerSecret: env.RCLAUDE_SECRET,
    conversationId,
    cwd: env.RCLAUDE_CWD || env.PWD || '.',
    initialPromptFile: env.RCLAUDE_INITIAL_PROMPT_FILE || null,
    conversationTitle: env.CLAUDWERK_CONVERSATION_NAME || null,
    conversationDescription: env.CLAUDWERK_CONVERSATION_DESCRIPTION || null,
    resumeSessionId: env.ACP_RESUME_SESSION_ID || null,
    debug: !!env.ACP_HOST_DEBUG,
  }
}
