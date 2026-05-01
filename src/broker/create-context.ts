/**
 * Factory for creating HandlerContext from a WebSocket connection.
 * Wires up all dependencies so handlers only see the context interface.
 */

import type { ServerWebSocket } from 'bun'
import type { ProjectSettings } from '../shared/protocol'
import type { ConversationStore } from './conversation-store'
import { GuardError, type HandlerContext, logPrefix, type WsData } from './handler-context'
import type { Permission } from './permissions'
import { resolvePermissions } from './permissions'
import type { StoreDriver } from './store/types'

export interface ContextDeps {
  conversations: ConversationStore
  store: StoreDriver
  verbose: boolean
  origins: string[]
  getProjectSettings(project: string): ProjectSettings | null
  setProjectSettings(project: string, update: Partial<ProjectSettings>): void
  getAllProjectSettings(): Record<string, ProjectSettings>
  pushConfigured: boolean
  pushSendToAll(payload: {
    title: string
    body: string
    sessionId?: string
    sessionProject?: string
    tag?: string
  }): void
  getLinksForProject(project: string): Array<{ projectA: string; projectB: string }>
  findLink(projectA: string, projectB: string): boolean
  addLink(projectA: string, projectB: string): void
  removeLink(projectA: string, projectB: string): void
  touchLink(projectA: string, projectB: string): void
  logMessage(entry: Parameters<import('./handler-context').HandlerContext['logMessage']>[0]): void
  addressBook: {
    getOrAssign(callerProject: string, targetProject: string, targetName: string): string
    resolve(callerProject: string, localId: string): string | undefined
  }
  messageQueue: {
    enqueue(
      targetProject: string,
      senderProject: string,
      senderName: string,
      message: Record<string, unknown>,
      targetName?: string,
    ): void
    drain(
      targetProject: string,
      sessionName?: string,
    ): Array<{
      ts: number
      senderProject: string
      senderName: string
      message: Record<string, unknown>
      targetName?: string
    }>
    getQueueSize(targetProject: string): number
  }
}

export function createContext(ws: ServerWebSocket<WsData>, deps: ContextDeps): HandlerContext {
  const sessionId = ws.data.sessionId
  const caller = sessionId ? deps.conversations.getConversation(sessionId) : undefined
  const callerSettings = caller?.project ? deps.getProjectSettings(caller.project) : null
  const prefix = logPrefix(ws)

  return {
    ws,
    conversations: deps.conversations,
    store: deps.store,
    caller,
    callerSettings,
    verbose: deps.verbose,

    reply(msg) {
      ws.send(JSON.stringify(msg))
    },

    broadcast(msg) {
      const json = JSON.stringify(msg)
      for (const sub of deps.conversations.getSubscribers()) {
        try {
          sub.send(json)
        } catch {
          /* dead socket */
        }
      }
    },

    broadcastScoped(msg, project) {
      deps.conversations.broadcastConversationScoped(msg, project)
    },

    push: {
      configured: deps.pushConfigured,
      sendToAll: payload => deps.pushSendToAll(payload),
    },

    origins: deps.origins,
    getSentinel: () => deps.conversations.getSentinel(),
    getLinksForProject: deps.getLinksForProject,

    links: {
      find: (projectA, projectB) => deps.findLink(projectA, projectB),
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

    requireSentinel() {
      const sentinel = deps.conversations.getSentinel()
      if (!sentinel) throw new GuardError('No sentinel connected')
      return sentinel
    },

    requireConversation() {
      if (!caller) throw new GuardError('No conversation')
      return caller
    },

    requirePermission(permission: Permission, project?: string) {
      // Wrappers and sentinels bypass all permission checks (trusted infrastructure)
      if (!ws.data.isControlPanel) return
      // No grants on WS data = legacy connection or bearer auth (treat as admin)
      const grants = ws.data.grants
      if (!grants) return
      // Use provided project, fall back to caller session project, then '*' for global checks
      const targetProject = project || caller?.project || '*'
      const { permissions: perms, isAdmin } = resolvePermissions(grants, targetProject)
      if (!isAdmin && !perms.has(permission)) {
        throw new GuardError(`Permission denied: ${permission} required`)
      }
    },
  }
}
