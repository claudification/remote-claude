/**
 * Generic viewer registry.
 * Tracks which dashboard WebSocket connections are viewing a named resource.
 * Keyed by an opaque string (conversationId for terminal/json-stream).
 * Used by both terminal PTY and raw JSON stream viewers.
 */

import type { ServerWebSocket } from 'bun'

const EMPTY_SET: Set<ServerWebSocket<unknown>> = new Set()

export interface ViewerRegistry {
  add: (key: string, ws: ServerWebSocket<unknown>) => void
  get: (key: string) => Set<ServerWebSocket<unknown>>
  remove: (key: string, ws: ServerWebSocket<unknown>) => void
  removeBySocket: (ws: ServerWebSocket<unknown>) => void
  has: (key: string) => boolean
}

export function createViewerRegistry(): ViewerRegistry {
  const viewers = new Map<string, Set<ServerWebSocket<unknown>>>()

  function add(key: string, ws: ServerWebSocket<unknown>): void {
    let set = viewers.get(key)
    if (!set) {
      set = new Set()
      viewers.set(key, set)
    }
    set.add(ws)
  }

  function get(key: string): Set<ServerWebSocket<unknown>> {
    return viewers.get(key) || EMPTY_SET
  }

  function remove(key: string, ws: ServerWebSocket<unknown>): void {
    const set = viewers.get(key)
    if (set) {
      set.delete(ws)
      if (set.size === 0) viewers.delete(key)
    }
  }

  function removeBySocket(ws: ServerWebSocket<unknown>): void {
    for (const [key, set] of viewers) {
      set.delete(ws)
      if (set.size === 0) viewers.delete(key)
    }
  }

  function has(key: string): boolean {
    const set = viewers.get(key)
    return !!set && set.size > 0
  }

  return { add, get, remove, removeBySocket, has }
}
