/**
 * Terminal viewer registry.
 * Tracks which dashboard WebSocket connections are viewing each PTY terminal.
 * Keyed by wrapperId (one PTY per rclaude instance).
 */

import type { ServerWebSocket } from 'bun'

const EMPTY_VIEWER_SET: Set<ServerWebSocket<unknown>> = new Set()

export interface TerminalRegistry {
  addTerminalViewer: (wrapperId: string, ws: ServerWebSocket<unknown>) => void
  getTerminalViewers: (wrapperId: string) => Set<ServerWebSocket<unknown>>
  removeTerminalViewer: (wrapperId: string, ws: ServerWebSocket<unknown>) => void
  removeTerminalViewerBySocket: (ws: ServerWebSocket<unknown>) => void
  hasTerminalViewers: (wrapperId: string) => boolean
}

export function createTerminalRegistry(): TerminalRegistry {
  const terminalViewers = new Map<string, Set<ServerWebSocket<unknown>>>()

  function addTerminalViewer(wrapperId: string, ws: ServerWebSocket<unknown>): void {
    let viewers = terminalViewers.get(wrapperId)
    if (!viewers) {
      viewers = new Set()
      terminalViewers.set(wrapperId, viewers)
    }
    viewers.add(ws)
  }

  function getTerminalViewers(wrapperId: string): Set<ServerWebSocket<unknown>> {
    return terminalViewers.get(wrapperId) || EMPTY_VIEWER_SET
  }

  function removeTerminalViewer(wrapperId: string, ws: ServerWebSocket<unknown>): void {
    const viewers = terminalViewers.get(wrapperId)
    if (viewers) {
      viewers.delete(ws)
      if (viewers.size === 0) terminalViewers.delete(wrapperId)
    }
  }

  function removeTerminalViewerBySocket(ws: ServerWebSocket<unknown>): void {
    for (const [id, viewers] of terminalViewers) {
      viewers.delete(ws)
      if (viewers.size === 0) terminalViewers.delete(id)
    }
  }

  function hasTerminalViewers(wrapperId: string): boolean {
    const viewers = terminalViewers.get(wrapperId)
    return !!viewers && viewers.size > 0
  }

  return {
    addTerminalViewer,
    getTerminalViewers,
    removeTerminalViewer,
    removeTerminalViewerBySocket,
    hasTerminalViewers,
  }
}
