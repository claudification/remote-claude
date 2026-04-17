/**
 * Shared route helpers -- permission checks and common utilities
 * used by all route sub-modules.
 */

import type { Session, TeamInfo } from '../../shared/protocol'
import { getUser } from '../auth'
import { getAuthenticatedUser } from '../auth-routes'
import { type Permission, resolvePermissions, type UserGrant } from '../permissions'
import type { SessionStore } from '../session-store'
import { shareToGrants, validateShare } from '../shares'

// ─── Route context (shared deps across sub-routers) ────────────────────

export interface RouteHelpers {
  resolveHttpGrants(req: Request): UserGrant[] | null
  httpHasPermission(req: Request, permission: Permission, cwd: string): boolean
  httpIsAdmin(req: Request, cwd?: string): boolean
  filterSessionsByHttpGrants<T extends { cwd: string }>(req: Request, sessions: T[]): T[]
}

export function createRouteHelpers(rclaudeSecret: string | undefined): RouteHelpers {
  function resolveHttpGrants(req: Request): UserGrant[] | null {
    // Bearer token with shared secret = admin, no restrictions
    const authHeader = req.headers.get('authorization')
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (rclaudeSecret && bearer && bearer === rclaudeSecret) return null

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

  function httpHasPermission(req: Request, permission: Permission, cwd: string): boolean {
    const grants = resolveHttpGrants(req)
    if (grants === null) return true // admin
    const { permissions } = resolvePermissions(grants, cwd)
    return permissions.has(permission)
  }

  function httpIsAdmin(req: Request, cwd = '*'): boolean {
    const grants = resolveHttpGrants(req)
    if (grants === null) return true // bearer token
    const { isAdmin } = resolvePermissions(grants, cwd)
    return isAdmin
  }

  function filterSessionsByHttpGrants<T extends { cwd: string }>(req: Request, sessions: T[]): T[] {
    const grants = resolveHttpGrants(req)
    if (grants === null) return sessions // admin sees all
    return sessions.filter(s => {
      const { permissions } = resolvePermissions(grants, s.cwd)
      return permissions.has('chat:read')
    })
  }

  return { resolveHttpGrants, httpHasPermission, httpIsAdmin, filterSessionsByHttpGrants }
}

// ─── Session overview helper ───────────────────────────────────────────

export interface SessionOverview {
  id: string
  cwd: string
  model?: string
  status: Session['status']
  wrapperIds: string[]
  startedAt: number
  lastActivity: number
  eventCount: number
  activeSubagentCount: number
  totalSubagentCount: number
  team?: TeamInfo
  summary?: string
  title?: string
  agentName?: string
  prLinks?: Session['prLinks']
  lastEvent?: { hookEvent: string; timestamp: number }
}

export function sessionToOverview(session: Session, sessionStore: SessionStore): SessionOverview {
  const lastEvent = session.events[session.events.length - 1]
  return {
    id: session.id,
    cwd: session.cwd,
    model: session.model,
    status: session.status,
    wrapperIds: sessionStore.getWrapperIds(session.id),
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

export function broadcastToSubscribers(sessionStore: SessionStore, message: Record<string, unknown>) {
  const json = JSON.stringify(message)
  for (const ws of sessionStore.getSubscribers()) {
    try {
      ws.send(json)
    } catch {
      /* dead socket */
    }
  }
}
