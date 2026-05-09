/**
 * Claude (CC) backend -- the default. Requires an agent host WebSocket.
 * Input is forwarded to the agent host socket by the caller (not here).
 */

import type { ConversationBackend, InputResult } from './types'

export const claudeBackend: ConversationBackend = {
  type: 'claude',
  requiresAgentSocket: true,

  async handleInput(): Promise<InputResult> {
    return { ok: false, error: 'Claude input is handled via agent host socket, not backend proxy' }
  },
}
