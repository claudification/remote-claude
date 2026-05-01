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
  httpHasPermission(req: Request, permission: Permission, project: string): boolean
  httpIsAdmin(req: Request, project?: string): boolean
  filterSessionsByHttpGrants<T extends { project: string }>(req: Request, sessions: T[]): T[]
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

  function httpHasPermission(req: Request, permission: Permission, project: string): boolean {
    const grants = resolveHttpGrants(req)
    if (grants === null) return true // admin
    const { permissions } = resolvePermissions(grants, project)
    return permissions.has(permission)
  }

  function httpIsAdmin(req: Request, project = '*'): boolean {
    const grants = resolveHttpGrants(req)
    if (grants === null) return true // bearer token
    const { isAdmin } = resolvePermissions(grants, project)
    return isAdmin
  }

  function filterSessionsByHttpGrants<T extends { project: string }>(req: Request, sessions: T[]): T[] {
    const grants = resolveHttpGrants(req)
    if (grants === null) return sessions // admin sees all
    return sessions.filter(s => {
      const { permissions } = resolvePermissions(grants, s.project)
      return permissions.has('chat:read')
    })
  }

  return { resolveHttpGrants, httpHasPermission, httpIsAdmin, filterSessionsByHttpGrants }
}

// ─── Session overview helper ───────────────────────────────────────────

export interface SessionOverview {
  id: string
  project: string
  model?: string
  status: Conversation['status']
  conversationIds: string[]
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

export function sessionToOverview(session: Conversation, conversationStore: ConversationStore): SessionOverview {
  const lastEvent = session.events[session.events.length - 1]
  return {
    id: session.id,
    project: session.project,
    model: session.model,
    status: session.status,
    conversationIds: conversationStore.getConversationIds(session.id),
    startedAt: session.startedAt,
    lastActivity: session.lastActivity,
    eventCount: session.events.length,
    activeSubagentCount: session.subagents.filter(a => a.status === 'running').length,
    totalSubagentCount: session.subagents.length,
    team: session.team,
    summary: session.summary,
    title: session.title,
    agentName: session.agentName,
    prLinks: session.prLinks,
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
