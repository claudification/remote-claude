/**
 * Message router: dispatches WS messages to handler functions.
 * Handlers register by message type. Guards throw GuardError
 * which the router catches and sends as error replies.
 */

import { GuardError, type HandlerContext, type MessageData, type MessageHandler } from './handler-context'

const handlers = new Map<string, MessageHandler>()

/** Register multiple handlers at once */
export function registerHandlers(map: Record<string, MessageHandler>): void {
  for (const [type, handler] of Object.entries(map)) {
    handlers.set(type, handler)
  }
}

/** Route a message to its handler. Returns true if handled. */
export function routeMessage(ctx: HandlerContext, type: string, data: MessageData): boolean {
  const handler = handlers.get(type)
  if (!handler) return false

  try {
    const result = handler(ctx, data)
    if (result instanceof Promise) {
      result.catch(err => {
        console.error(`[router] Async handler error for ${type}:`, err)
        ctx.reply({ type: `${type}_result`, ok: false, error: err instanceof Error ? err.message : 'Internal error' })
      })
    }
  } catch (err) {
    if (err instanceof GuardError) {
      ctx.reply({ type: `${type}_result`, ok: false, error: err.message })
    } else {
      console.error(`[router] Handler error for ${type}:`, err)
      ctx.reply({ type: `${type}_result`, ok: false, error: 'Internal error' })
    }
  }

  return true
}
