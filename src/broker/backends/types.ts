/**
 * ConversationBackend -- abstraction for different agent backends.
 *
 * Each backend (Claude/CC, Chat API, future OpenCode/Pi/Codex) implements
 * this interface. The broker dispatches through resolveBackend() instead
 * of scattering `if (agentHostType === 'xxx')` checks.
 */

import type { SubscriptionChannel } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import type { KVStore } from '../store/types'

export interface InputResult {
  ok: boolean
  error?: string
}

export interface BackendDeps {
  conversationStore: ConversationStore
  kv: KVStore
  broadcastScoped?: (msg: Record<string, unknown>, project: string) => void
  broadcastToChannel?: (channel: SubscriptionChannel, conversationId: string, msg: Record<string, unknown>) => void
}

export interface ConversationBackend {
  readonly type: string
  readonly requiresAgentSocket: boolean
  handleInput(conversationId: string, input: string, deps: BackendDeps): Promise<InputResult>
}
