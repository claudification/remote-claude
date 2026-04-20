/**
 * Terminal viewer registry.
 * Tracks which dashboard WebSocket connections are viewing each PTY terminal.
 * Keyed by wrapperId (one PTY per rclaude instance).
 * Thin wrapper over ViewerRegistry for backwards-compatible API.
 */

import type { ServerWebSocket } from 'bun'
import { createViewerRegistry } from './viewer-registry'

export interface TerminalRegistry {
  addTerminalViewer: (wrapperId: string, ws: ServerWebSocket<unknown>) => void
  getTerminalViewers: (wrapperId: string) => Set<ServerWebSocket<unknown>>
  removeTerminalViewer: (wrapperId: string, ws: ServerWebSocket<unknown>) => void
  removeTerminalViewerBySocket: (ws: ServerWebSocket<unknown>) => void
  hasTerminalViewers: (wrapperId: string) => boolean
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
