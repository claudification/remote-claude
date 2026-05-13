/**
 * Shared route helpers -- permission checks and common utilities
 * used by all route sub-modules.
 */

import type { Conversation, TeamInfo } from '../../shared/protocol'
import { getUser } from '../auth'
import { getAuthenticatedUser, resolveAuth } from '../auth-routes'
import type { ConversationStore } from '../conversation-store'
import { type Permission, resolvePermissions, type UserGrant } from '../permissions'
import { shareToGrants, validateShare } from '../shares'

// ─── Route context (shared deps across sub-routers) ────────────────────

export interface RouteHelpers {
  resolveHttpGrants(req: Request): UserGrant[] | null
  httpHasPermission(req: Request, permission: Permission, project: string, conversationId?: string): boolean
  httpIsAdmin(req: Request, project?: string): boolean
  filterConversationsByHttpGrants<T extends { project: string; id: string }>(req: Request, conversations: T[]): T[]
  /** Returns the conversationId a share token is scoped to (if any). When set,
   *  the caller MUST only be allowed to touch that one conversation. */
  shareScopedConversationId(req: Request): string | null
}

export function createRouteHelpers(_rclaudeSecret?: string): RouteHelpers {
  function resolveHttpGrants(req: Request): UserGrant[] | null {
    // Bearer token with admin or sentinel secret = admin-level access
    const authHeader = req.headers.get('authorization')
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (bearer) {
      const auth = resolveAuth(bearer)
      if (auth.role !== 'none') return null
    }

    // Cookie auth = user grants
    const userName = getAuthenticatedUser(req)
    if (userName) {
      const user = getUser(userName)
      return user?.grants || []
    }

    // Share token auth
    const url = new URL(req.url)
    const shareToken = url.searchParams.get('share')
    if (shareToken) {
      const share = validateShare(shareToken)
      if (share) return shareToGrants(share)
    }

    return [] // no auth = no access
  }

  function shareScopedConversationId(req: Request): string | null {
    const authHeader = req.headers.get('authorization')
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (bearer) {
      const auth = resolveAuth(bearer)
      // Admin bearer auth bypasses share scoping.
      if (auth.role !== 'none') return null
    }
    // Cookie-authenticated users are not share viewers.
    if (getAuthenticatedUser(req)) return null
    const url = new URL(req.url)
    const shareToken = url.searchParams.get('share')
    if (!shareToken) return null
    const share = validateShare(shareToken)
    if (!share) return null
    return share.conversationId ?? null
  }

  function httpHasPermission(req: Request, permission: Permission, project: string, conversationId?: string): boolean {
    const grants = resolveHttpGrants(req)
    if (grants === null) return true // admin
    const { permissions } = resolvePermissions(grants, project)
    if (!permissions.has(permission)) return false
    // Per-conversation share scope: a share bound to conversation A must
    // never grant access to conversation B even though both live in the
    // same project URI.
    const restrictTo = shareScopedConversationId(req)
    if (restrictTo && conversationId && conversationId !== restrictTo) return false
    return true
  }

  function httpIsAdmin(req: Request, project = '*'): boolean {
    const grants = resolveHttpGrants(req)
    if (grants === null) return true // bearer token
    const { isAdmin } = resolvePermissions(grants, project)
    return isAdmin
  }

  function filterConversationsByHttpGrants<T extends { project: string; id: string }>(
    req: Request,
    conversations: T[],
  ): T[] {
    const grants = resolveHttpGrants(req)
    const restrictTo = shareScopedConversationId(req)
    let result = conversations
    if (grants !== null) {
      result = result.filter(s => {
        const { permissions } = resolvePermissions(grants, s.project)
        return permissions.has('chat:read')
      })
    }
    if (restrictTo) {
      result = result.filter(s => s.id === restrictTo)
    }
    return result
  }

  return {
    resolveHttpGrants,
    httpHasPermission,
    httpIsAdmin,
    filterConversationsByHttpGrants,
    shareScopedConversationId,
  }
}

// ─── Conversation overview helper ──────────────────────────────────────

export interface ConversationOverview {
  id: string
  project: string
  model?: string
  status: Conversation['status']
  connectionIds: string[]
  startedAt: number
  lastActivity: number
  eventCount: number
  activeSubagentCount: number
  totalSubagentCount: number
  team?: TeamInfo
  summary?: string
  title?: string
  agentName?: string
  prLinks?: Conversation['prLinks']
  lastEvent?: { hookEvent: string; timestamp: number }
}

export function conversationToOverview(conv: Conversation, conversationStore: ConversationStore): ConversationOverview {
  const lastEvent = conv.events[conv.events.length - 1]
  return {
    id: conv.id,
    project: conv.project,
    model: conv.model,
    status: conv.status,
    connectionIds: conversationStore.getConnectionIds(conv.id),
    startedAt: conv.startedAt,
    lastActivity: conv.lastActivity,
    eventCount: conv.events.length,
    activeSubagentCount: conv.subagents.filter(a => a.status === 'running').length,
    totalSubagentCount: conv.subagents.length,
    team: conv.team,
    summary: conv.summary,
    title: conv.title,
    agentName: conv.agentName,
    prLinks: conv.prLinks,
    lastEvent: lastEvent ? { hookEvent: lastEvent.hookEvent, timestamp: lastEvent.timestamp } : undefined,
  }
}

// ─── Broadcast helper ──────────────────────────────────────────────────

export function broadcastToSubscribers(conversationStore: ConversationStore, message: Record<string, unknown>) {
  const json = JSON.stringify(message)
  for (const ws of conversationStore.getSubscribers()) {
    try {
      ws.send(json)
    } catch {
      /* dead socket */
    }
  }
}
