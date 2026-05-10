/**
 * ACP backend -- routes traffic for conversations whose agent host is the
 * generic ACP host (`bin/acp-host`). Spawn entry points for individual
 * agents (OpenCode today, Codex / Gemini in Phase C) live in their own
 * backends and tag the conversation with agentHostType='acp' +
 * agentHostMeta.acpAgent. From that point onward, this backend handles
 * lookup-time concerns (input routing, capability checks).
 *
 * The wire protocol the ACP host speaks back to the broker is identical to
 * the Claude / OpenCode-NDJSON paths (transcript_entries, conversation_promote,
 * heartbeats, terminate_conversation). The broker doesn't need to know
 * which agent is on the other end of the WS; the host translates everything
 * into Claudwerk's transcript shape.
 */

import type { ConversationBackend, InputResult, SpawnResult } from './types'

export const acpBackend: ConversationBackend = {
  type: 'acp',
  // No URI scheme -- ACP-hosted conversations carry their agent's URI scheme
  // (opencode://, codex://, gemini://). The opencode backend handles
  // opencode://; future per-agent backends will own their own.
  scheme: undefined,
  // The acp-host binary opens its own per-conversation WS.
  requiresAgentSocket: true,

  async spawn(): Promise<SpawnResult> {
    // The ACP backend isn't a spawn entry on its own. Direct spawns go
    // through the per-agent backend (e.g. opencodeBackend), which tags the
    // conversation with agentHostType='acp' and the relevant acpAgent
    // recipe key. A future generic acp:// backend (e.g. for chat-api-style
    // bring-your-own-recipe spawns) would live here.
    return {
      ok: false,
      error: 'ACP spawns must come through a per-agent backend (e.g. opencode). Direct acp:// spawn not implemented.',
      statusCode: 400,
    }
  },

  async handleInput(): Promise<InputResult> {
    // Same contract as Claude / OpenCode-NDJSON: input routes over the
    // per-conversation socket, handled by the unified send_input handler.
    return { ok: false, useSocket: true, error: 'ACP input is handled via agent host socket' }
  },
}
