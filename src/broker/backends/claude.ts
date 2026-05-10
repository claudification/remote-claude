/**
 * Claude (CC) backend -- the default. Requires an agent host WebSocket.
 * Input is forwarded to the agent host socket by the caller (not here).
 */

import type { ConversationBackend, InputResult } from './types'

export const claudeBackend: ConversationBackend = {
  type: 'claude',
  scheme: 'claude',
  requiresAgentSocket: true,

  async handleInput(): Promise<InputResult> {
    // Tell the caller to forward over the conversation socket. The legacy
    // path in control-panel-actions.ts gates on requiresAgentSocket and
    // forwards there; this branch exists for callers that uniformly call
    // backend.handleInput() and need the same behaviour.
    return { ok: false, useSocket: true, error: 'Claude input is handled via agent host socket' }
  },
}
