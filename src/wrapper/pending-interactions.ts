/**
 * Thin helpers over ctx.outstandingInteractions -- the registry of user-facing
 * interactions (permission_request / ask_question / dialog_show / plan_approval)
 * whose response is held in concentrator memory. The wrapper keeps the
 * authoritative copy so a concentrator restart can't strand CC/MCP.
 *
 * Usage:
 *   sendInteraction(ctx, 'plan_approval', requestId, payload)     // store + send
 *   clearInteraction(ctx, id)                                     // on response
 *   replayInteractions(ctx)                                       // on (re)connect
 */

import type { WrapperMessage } from '../shared/protocol'
import type { OutstandingInteraction, WrapperContext } from './wrapper-context'

/**
 * Register an outstanding interaction and send it to the concentrator.
 * wsClient.send() auto-queues if disconnected, so no isConnected gate.
 */
export function sendInteraction(
  ctx: WrapperContext,
  kind: OutstandingInteraction['kind'],
  id: string,
  payload: WrapperMessage,
): void {
  ctx.outstandingInteractions.set(id, { kind, id, payload, createdAt: Date.now() })
  ctx.wsClient?.send(payload)
}

/** Clear an interaction once the user has responded (or it was dismissed/timed out). */
export function clearInteraction(ctx: WrapperContext, id: string): void {
  ctx.outstandingInteractions.delete(id)
}

/**
 * Re-send every outstanding interaction. Called from onConnected so that a
 * concentrator restart between request and response is a non-event.
 * Concentrator handlers are idempotent (keyed by sessionId + requestId/toolUseId),
 * so a spurious replay after a dashboard-only reconnect is harmless.
 */
export function replayInteractions(ctx: WrapperContext): void {
  if (ctx.outstandingInteractions.size === 0) return
  for (const { kind, id, payload } of ctx.outstandingInteractions.values()) {
    ctx.wsClient?.send(payload)
    ctx.diag(kind, `Replayed on reconnect (${id.slice(0, 8)})`)
  }
}

/** How many interactions are still waiting on a user response. */
export function countInteractions(ctx: WrapperContext): number {
  return ctx.outstandingInteractions.size
}
