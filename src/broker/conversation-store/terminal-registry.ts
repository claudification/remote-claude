/**
 * Terminal viewer registry.
 * Tracks which dashboard WebSocket connections are viewing each PTY terminal.
 * Keyed by conversationId (one PTY per rclaude instance).
 * Thin wrapper over ViewerRegistry for backwards-compatible API.
 */

import type { ServerWebSocket } from 'bun'
import { createViewerRegistry } from './viewer-registry'

export interface TerminalRegistry {
  addTerminalViewer: (conversationId: string, ws: ServerWebSocket<unknown>) => void
  getTerminalViewers: (conversationId: string) => Set<ServerWebSocket<unknown>>
  removeTerminalViewer: (conversationId: string, ws: ServerWebSocket<unknown>) => void
  removeTerminalViewerBySocket: (ws: ServerWebSocket<unknown>) => void
  hasTerminalViewers: (conversationId: string) => boolean
}

export function createTerminalRegistry(): TerminalRegistry {
  const registry = createViewerRegistry()

  return {
    addTerminalViewer: registry.add,
    getTerminalViewers: registry.get,
    removeTerminalViewer: registry.remove,
    removeTerminalViewerBySocket: registry.removeBySocket,
    hasTerminalViewers: registry.has,
  }
}
