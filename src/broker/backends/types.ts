/**
 * ConversationBackend -- abstraction for different agent backends.
 *
 * Each backend (Claude/CC, Chat API, Hermes, OpenCode, future Codex/Pi)
 * implements this interface. The broker dispatches through resolveBackend()
 * instead of scattering `if (agentHostType === 'xxx')` checks.
 *
 * See `.claude/docs/plan-pluggable-backends.md` for the full design.
 */

import type { ProjectSettings, SubscriptionChannel } from '../../shared/protocol'
import type { SpawnCallerContext } from '../../shared/spawn-permissions'
import type { SpawnRequest } from '../../shared/spawn-schema'
import type { ConversationStore } from '../conversation-store'
import type { GlobalSettings } from '../global-settings'
import type { KVStore } from '../store/types'

export interface InputResult {
  ok: boolean
  error?: string
  /** Tell the caller to forward input over the conversation socket instead of
   *  having the backend handle it directly. Used by the Claude backend. */
  useSocket?: boolean
}

export interface BackendDeps {
  conversationStore: ConversationStore
  kv: KVStore
  broadcastScoped?: (msg: Record<string, unknown>, project: string) => void
  broadcastToChannel?: (channel: SubscriptionChannel, conversationId: string, msg: Record<string, unknown>) => void
}

/**
 * Dependencies available during spawn dispatch. Backends that need sentinel
 * routing (claude, opencode) consume `conversationStore.getSentinel()` etc.
 *
 * Intentionally does NOT extend BackendDeps -- spawn doesn't need broadcast
 * helpers or kv (those are for runtime input handling). Backends that need
 * KV at spawn time can read it via the store driver passed at construction.
 */
export interface SpawnDeps {
  conversationStore: ConversationStore
  getProjectSettings: (project: string) => ProjectSettings | null
  getGlobalSettings: () => GlobalSettings
  callerContext: SpawnCallerContext
  rendezvousCallerConversationId?: string | null
}

export type SpawnResult =
  | { ok: true; conversationId: string; jobId: string; tmuxSession?: string }
  | { ok: false; error: string; statusCode?: number }

export interface ConversationBackend {
  /** Stable type tag stored on Conversation.agentHostType. */
  readonly type: string

  /** URI scheme this backend owns (e.g. 'claude', 'chat', 'hermes', 'opencode'). */
  readonly scheme?: string

  /** True if this backend requires a per-conversation agent host WebSocket
   *  (Claude, OpenCode). False for HTTP-proxy backends (Chat API) and
   *  gateway-socket backends (Hermes). */
  readonly requiresAgentSocket: boolean

  /**
   * Handle user input for this conversation. For socket-based backends, this
   * may return { ok: false, useSocket: true } to tell the caller to forward
   * input over the conversation socket instead.
   */
  handleInput(conversationId: string, input: string, deps: BackendDeps): Promise<InputResult>

  /**
   * Optional: dispatch a spawn request for this backend. When defined, the
   * unified `dispatchSpawn` resolves the backend by `req.backend` (or scheme)
   * and delegates here. When undefined, the legacy Claude path is used.
   */
  spawn?(req: SpawnRequest, deps: SpawnDeps): Promise<SpawnResult>
}
