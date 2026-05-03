/**
 * Thin helpers over ctx.outstandingInteractions -- the registry of user-facing
 * interactions (permission_request / ask_question / dialog_show / plan_approval)
 * whose response is held in broker memory. The wrapper keeps the
 * authoritative copy so a broker restart can't strand CC/MCP.
 *
 * Usage:
 *   sendInteraction(ctx, 'plan_approval', requestId, payload)     // store + send
 *   clearInteraction(ctx, id)                                     // on response
 *   replayInteractions(ctx)                                       // on (re)connect
 */

import type { AgentHostMessage } from '../shared/protocol'
import type { AgentHostContext, OutstandingInteraction } from './agent-host-context'

/**
 * Register an outstanding interaction and send it to the broker.
 * wsClient.send() auto-queues if disconnected, so no isConnected gate.
 */
export function sendInteraction(
  ctx: AgentHostContext,
  kind: OutstandingInteraction['kind'],
  id: string,
  payload: AgentHostMessage,
): void {
  ctx.outstandingInteractions.set(id, { kind, id, payload, createdAt: Date.now() })
  ctx.wsClient?.send(payload)
}

/** Clear an interaction once the user has responded (or it was dismissed/timed out). */
export function clearInteraction(ctx: AgentHostContext, id: string): void {
  ctx.outstandingInteractions.delete(id)
}

/**
 * Re-send every outstanding interaction. Called from onConnected so that a
 * broker restart between request and response is a non-event.
 * Broker handlers are idempotent (keyed by conversationId + requestId/toolUseId),
 * so a spurious replay after a dashboard-only reconnect is harmless.
 */
export function replayInteractions(ctx: AgentHostContext): void {
  if (ctx.outstandingInteractions.size === 0) return
  for (const { kind, id, payload } of ctx.outstandingInteractions.values()) {
    ctx.wsClient?.send(payload)
    ctx.diag(kind, `Replayed on reconnect (${id.slice(0, 8)})`)
  }
}

/** How many interactions are still waiting on a user response. */
export function countInteractions(ctx: AgentHostContext): number {
  return ctx.outstandingInteractions.size
}
