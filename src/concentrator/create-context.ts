/**
 * Factory for creating HandlerContext from a WebSocket connection.
 * Wires up all dependencies so handlers only see the context interface.
 */

import type { ServerWebSocket } from 'bun'
import type { ProjectSettings } from '../shared/protocol'
import { GuardError, type HandlerContext, logPrefix, type WsData } from './handler-context'
import type { Permission } from './permissions'
import { resolvePermissions } from './permissions'
import type { SessionStore } from './session-store'

export interface ContextDeps {
  sessions: SessionStore
  verbose: boolean
  origins: string[]
  getProjectSettings(cwd: string): ProjectSettings | null
  setProjectSettings(cwd: string, update: Partial<ProjectSettings>): void
  getAllProjectSettings(): Record<string, ProjectSettings>
  pushConfigured: boolean
  pushSendToAll(payload: { title: string; body: string; sessionId?: string; tag?: string }): void
  getLinksForCwd(cwd: string): Array<{ cwdA: string; cwdB: string }>
  findLink(cwdA: string, cwdB: string): boolean
  addLink(cwdA: string, cwdB: string): void
  removeLink(cwdA: string, cwdB: string): void
  touchLink(cwdA: string, cwdB: string): void
  logMessage(entry: Parameters<import('./handler-context').HandlerContext['logMessage']>[0]): void
  addressBook: {
    getOrAssign(callerCwd: string, targetCwd: string, targetName: string): string
    resolve(callerCwd: string, localId: string): string | undefined
  }
  messageQueue: {
    enqueue(targetCwd: string, fromCwd: string, fromProject: string, message: Record<string, unknown>): void
    drain(
      targetCwd: string,
    ): Array<{ ts: number; fromCwd: string; fromProject: string; message: Record<string, unknown> }>
    getQueueSize(targetCwd: string): number
  }
}

export function createContext(ws: ServerWebSocket<WsData>, deps: ContextDeps): HandlerContext {
  const sessionId = ws.data.sessionId
  const caller = sessionId ? deps.sessions.getSession(sessionId) : undefined
  const callerSettings = caller?.cwd ? deps.getProjectSettings(caller.cwd) : null
  const prefix = logPrefix(ws)

  return {
    ws,
    sessions: deps.sessions,
    caller,
    callerSettings,
    verbose: deps.verbose,

    reply(msg) {
      ws.send(JSON.stringify(msg))
    },

    broadcast(msg) {
      const json = JSON.stringify(msg)
      for (const sub of deps.sessions.getSubscribers()) {
        try {
          sub.send(json)
        } catch {
          /* dead socket */
        }
      }
    },

    push: {
      configured: deps.pushConfigured,
      sendToAll: payload => deps.pushSendToAll(payload),
    },

    origins: deps.origins,
    getAgent: () => deps.sessions.getAgent(),
    getLinksForCwd: deps.getLinksForCwd,

    links: {
      find: (cwdA, cwdB) => deps.findLink(cwdA, cwdB),
      add: deps.addLink,
      remove: deps.removeLink,
      touch: deps.touchLink,
    },
    logMessage: deps.logMessage,
    addressBook: deps.addressBook,
    messageQueue: deps.messageQueue,
    getProjectSettings: deps.getProjectSettings,
    setProjectSettings: deps.setProjectSettings,
    getAllProjectSettings: deps.getAllProjectSettings,

    log: {
      info(msg) {
        console.log(`${prefix} ${msg}`)
      },
      error(msg, err?) {
        console.error(`${prefix} ${msg}`, err instanceof Error ? err.message : err || '')
      },
      debug(msg) {
        if (deps.verbose) console.log(`${prefix} ${msg}`)
      },
    },

    requireBenevolent() {
      if (callerSettings?.trustLevel !== 'benevolent') {
        throw new GuardError('Requires benevolent trust level')
      }
    },

    requireAgent() {
      const agent = deps.sessions.getAgent()
      if (!agent) throw new GuardError('No host agent connected')
      return agent
    },

    requireSession() {
      if (!caller) throw new GuardError('No session')
      return caller
    },

    requirePermission(permission: Permission, cwd?: string) {
      // Wrappers and agents bypass all permission checks (trusted infrastructure)
      if (!ws.data.isDashboard) return
      // No grants on WS data = legacy connection or bearer auth (treat as admin)
      const grants = ws.data.grants
      if (!grants) return
      // Use provided CWD, fall back to caller session CWD, then '*' for global checks
      const targetCwd = cwd || caller?.cwd || '*'
      const perms = resolvePermissions(grants, targetCwd)
      if (!perms.has(permission)) {
        throw new GuardError(`Permission denied: ${permission} required`)
      }
    },
  }
}
