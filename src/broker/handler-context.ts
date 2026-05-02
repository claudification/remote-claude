/**
 * Handler context: passed to every WS message handler.
 * Provides access to conversation state, utilities, and the calling connection.
 */

import type { ServerWebSocket } from 'bun'
import type { ProjectSettings } from '../shared/protocol'
import type { ConversationStore } from './conversation-store'
import type { Permission, UserGrant } from './permissions'
import type { StoreDriver } from './store/types'

export interface WsData {
  sessionId?: string
  conversationId?: string
  isControlPanel?: boolean
  isSentinel?: boolean
  sentinelId?: string
  sentinelAlias?: string
  userName?: string
  authToken?: string
  grants?: UserGrant[]
  // Share (guest) access
  isShare?: boolean
  shareToken?: string
  hideUserInput?: boolean
}

/** Thrown by guard methods (requireBenevolent, requireAgent, etc.) */
export class GuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuardError'
  }
}

export interface HandlerContext {
  /** The WebSocket connection that sent this message */
  ws: ServerWebSocket<WsData>
  /** Conversation store (read/write conversation state) */
  conversations: ConversationStore
  /** Unified StoreDriver (SQLite-backed domain stores: costs, kv, transcripts, etc.) */
  store: StoreDriver
  /** Resolved caller session (from ws.data.sessionId) */
  caller?: ReturnType<ConversationStore['getConversation']>
  /** Caller's project settings */
  callerSettings?: ProjectSettings | null
  /** Verbose logging flag */
  verbose: boolean

  /** Send a JSON response back to the caller */
  reply(msg: Record<string, unknown>): void
  /** Broadcast a JSON message to all dashboard subscribers */
  broadcast(msg: Record<string, unknown>): void
  /** Broadcast a JSON message only to subscribers with chat:read for the given project */
  broadcastScoped(msg: Record<string, unknown>, project: string): void
  /** Web push notifications */
  push: {
    configured: boolean
    sendToAll(payload: {
      title: string
      body: string
      sessionId?: string
      sessionProject?: string
      tag?: string
      data?: Record<string, unknown>
    }): void
  }
  /** WebAuthn origins (for meta ack) */
  origins: string[]
  /** Get the sentinel WebSocket (if connected) */
  getSentinel(): ServerWebSocket<unknown> | undefined
  /** Get persisted links for a project */
  getLinksForProject(project: string): Array<{ projectA: string; projectB: string }>
  /** Get project settings for a project */
  getProjectSettings(project: string): ProjectSettings | null
  /** Set project settings for a project */
  setProjectSettings(project: string, update: Partial<ProjectSettings>): void
  /** Get all project settings */
  getAllProjectSettings(): Record<string, ProjectSettings>

  /** Contextual logger -- auto-prefixes with session/wrapper info */
  log: {
    info(msg: string): void
    error(msg: string, err?: unknown): void
    debug(msg: string): void
  }

  /** Persisted link operations (project-pair based, survives restarts) */
  links: {
    find(projectA: string, projectB: string): boolean
    add(projectA: string, projectB: string): void
    remove(projectA: string, projectB: string): void
    touch(projectA: string, projectB: string): void
  }
  /** Log an inter-conversation message for history */
  logMessage(entry: {
    ts: number
    from: { sessionId: string; conversationId?: string; project: string; name: string }
    to: { sessionId: string; project: string; name: string }
    intent: string
    conversationId: string
    preview: string
    fullLength: number
  }): void

  /** Address book: per-caller stable routing IDs */
  addressBook: {
    getOrAssign(callerProject: string, targetProject: string, targetName: string): string
    resolve(callerProject: string, localId: string): string | undefined
  }
  /** Persistent message queue for offline delivery */
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

  /** Guard: throws GuardError if caller is not benevolent */
  requireBenevolent(): void
  /** Guard: throws GuardError if no sentinel connected */
  requireSentinel(): ServerWebSocket<unknown>
  /** Guard: throws GuardError if caller has no session */
  requireConversation(): NonNullable<ReturnType<ConversationStore['getConversation']>>
  /**
   * Guard: throws GuardError if dashboard user lacks the required permission
   * for the given project. Wrappers/sentinels bypass all permission checks.
   */
  requirePermission(permission: Permission, project?: string): void
}

// biome-ignore lint/suspicious/noExplicitAny: WS JSON data is untyped at the parse boundary
export type MessageData = Record<string, any>

export type MessageHandler = (ctx: HandlerContext, data: MessageData) => void | Promise<void>

/** Create a log prefix from WS connection data */
export function logPrefix(ws: { data: WsData }): string {
  const id = ws.data.sessionId?.slice(0, 8)
  if (ws.data.isSentinel) return '[sentinel]'
  if (ws.data.isControlPanel) return `[dash${ws.data.userName ? `:${ws.data.userName}` : ''}]`
  return id ? `[${id}]` : '[unknown]'
}
