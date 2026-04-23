/**
 * Admin routes -- users, shares, inter-session links
 */

import { Hono } from 'hono'
import { parseProjectUri } from '../../shared/project-uri'
import {
  createAuthToken,
  createInvite,
  getAllUsers,
  getUser,
  hasServerRole,
  removeCredential,
  revokeUser,
  type ServerRole,
  setServerRoles,
  setUserGrants,
  unrevokeUser,
} from '../auth'
import { getAuthenticatedUser } from '../auth-routes'
import { purgeMessages, queryMessages } from '../inter-session-log'
import { resolvePermissionFlags } from '../permissions'
import { addPersistedLink, getPersistedLinks, removePersistedLink } from '../project-links'
import { getProjectSettings } from '../project-settings'
import type { SessionStore } from '../session-store'
import {
  createShare as createSessionShare,
  getShare as getShareByToken,
  listShares as listAllShares,
  revokeShare as revokeSessionShare,
} from '../shares'
import type { RouteHelpers } from './shared'

export function createAdminRouter(
  sessionStore: SessionStore,
  helpers: RouteHelpers,
  rclaudeSecret: string | undefined,
): Hono {
  const { httpIsAdmin } = helpers
  const app = new Hono()

  // ─── User admin (gated behind user-editor server role) ─────────────

  function requireUserEditor(c: { req: { raw: Request } }): Response | null {
    // Bearer token with shared secret = full admin access (CLI/scripts)
    const authHeader = c.req.raw.headers.get('authorization')
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (rclaudeSecret && bearerToken && bearerToken === rclaudeSecret) return null

    const userName = getAuthenticatedUser(c.req.raw)
    if (!userName)
      return c.req.raw.headers.get('accept')?.includes('json')
        ? new Response(JSON.stringify({ error: 'Not authenticated' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response('Unauthorized', { status: 401 })
    if (!hasServerRole(userName, 'user-editor')) {
      return new Response(JSON.stringify({ error: 'Forbidden: user-editor role required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return null
  }

  /** After changing grants/roles, hot-reload on live WS connections and push updated permissions + session list */
  function refreshUserPermissions(userName: string) {
    const user = getUser(userName)
    if (!user) return
    for (const ws of sessionStore.getSubscribers()) {
      if ((ws.data as { userName?: string }).userName === userName) {
        // Hot-reload grants on the live WS connection
        ;(ws.data as { grants?: unknown }).grants = user.grants
        // Push updated permissions
        const serverRoles = user.serverRoles
        const global = resolvePermissionFlags(user.grants, '*', serverRoles)
        const perSessionPerms: Record<string, ReturnType<typeof resolvePermissionFlags>> = {}
        for (const s of sessionStore.getActiveSessions()) {
          perSessionPerms[s.id] = resolvePermissionFlags(user.grants, s.project, serverRoles)
        }
        try {
          ws.send(JSON.stringify({ type: 'permissions', global, sessions: perSessionPerms }))
        } catch {}
        // Re-send filtered session list (user might gain/lose access)
        sessionStore.sendSessionsList(ws)
      }
    }
  }

  app.get('/api/users', c => {
    const block = requireUserEditor(c)
    if (block) return block
    const users = getAllUsers().map(u => ({
      name: u.name,
      createdAt: u.createdAt,
      lastUsedAt: u.lastUsedAt,
      revoked: u.revoked,
      grants: u.grants,
      serverRoles: u.serverRoles,
      credentialCount: u.credentials.length,
      credentials: u.credentials.map(c => ({
        credentialId: c.credentialId,
        registeredAt: c.registeredAt,
        counter: c.counter,
        transports: c.transports,
      })),
      pushSubscriptionCount: u.pushSubscriptions?.length || 0,
    }))
    return c.json({ users })
  })

  app.post('/api/users/invite', async c => {
    const block = requireUserEditor(c)
    if (block) return block
    const body = await c.req.json<{ name: string; grants?: unknown[]; serverRoles?: string[] }>()
    if (!body.name) return c.json({ error: 'name is required' }, 400)
    try {
      const invite = createInvite(body.name, body.grants as Parameters<typeof createInvite>[1])
      const origin = c.req.header('origin') || ''
      const inviteUrl = `${origin}/#/invite/${invite.token}`
      return c.json({ token: invite.token, expiresAt: invite.expiresAt, inviteUrl })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  app.post('/api/users/:name/grants', async c => {
    const block = requireUserEditor(c)
    if (block) return block
    const name = c.req.param('name')
    const body = await c.req.json<{ grants: unknown[] }>()
    if (!Array.isArray(body.grants)) return c.json({ error: 'grants array required' }, 400)
    if (setUserGrants(name, body.grants as Parameters<typeof setUserGrants>[1])) {
      refreshUserPermissions(name)
      return c.json({ ok: true })
    }
    return c.json({ error: 'User not found' }, 404)
  })

  app.post('/api/users/:name/server-roles', async c => {
    const block = requireUserEditor(c)
    if (block) return block
    const name = c.req.param('name')
    const body = await c.req.json<{ serverRoles: string[] }>()
    if (!Array.isArray(body.serverRoles)) return c.json({ error: 'serverRoles array required' }, 400)
    if (setServerRoles(name, body.serverRoles as ServerRole[])) {
      refreshUserPermissions(name)
      return c.json({ ok: true })
    }
    return c.json({ error: 'User not found' }, 404)
  })

  app.post('/api/users/:name/revoke', c => {
    const block = requireUserEditor(c)
    if (block) return block
    const name = c.req.param('name')
    if (revokeUser(name)) {
      // Kill active WS connections for revoked user
      for (const ws of sessionStore.getSubscribers()) {
        if ((ws.data as { userName?: string }).userName === name) {
          sessionStore.removeTerminalViewerBySocket(ws)
          sessionStore.removeJsonStreamViewerBySocket(ws)
          sessionStore.removeSubscriber(ws)
          try {
            ws.close(4401, 'User revoked')
          } catch {}
        }
      }
      return c.json({ ok: true })
    }
    return c.json({ error: 'User not found' }, 404)
  })

  app.post('/api/users/:name/unrevoke', c => {
    const block = requireUserEditor(c)
    if (block) return block
    if (unrevokeUser(c.req.param('name'))) return c.json({ ok: true })
    return c.json({ error: 'User not found' }, 404)
  })

  app.delete('/api/users/:name', c => {
    const block = requireUserEditor(c)
    if (block) return block
    const name = c.req.param('name')
    // Don't allow deleting yourself
    const caller = getAuthenticatedUser(c.req.raw)
    if (caller === name) return c.json({ error: 'Cannot delete yourself' }, 400)
    const user = getUser(name)
    if (!user) return c.json({ error: 'User not found' }, 404)
    // Revoke first (kills sessions), then we'd need a deleteUser -- for now revoke is enough
    revokeUser(name)
    return c.json({ ok: true })
  })

  app.delete('/api/users/:name/credentials/:credentialId', c => {
    const block = requireUserEditor(c)
    if (block) return block
    const name = c.req.param('name')
    const credentialId = decodeURIComponent(c.req.param('credentialId'))
    const result = removeCredential(name, credentialId)
    switch (result) {
      case 'user_not_found':
        return c.json({ error: 'User not found' }, 404)
      case 'not_found':
        return c.json({ error: 'Credential not found' }, 404)
      case 'removed_and_revoked':
        return c.json({ ok: true, revoked: true, message: 'Last passkey removed - user revoked' })
      case 'removed':
        return c.json({ ok: true, revoked: false, message: 'Passkey removed, all sessions killed' })
    }
  })

  // ─── Admin impersonation (debugging) ────────────────────────────────

  app.post('/api/admin/impersonate', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const body = await c.req.json<{ user: string }>()
    if (!body.user) return c.json({ error: 'user is required' }, 400)
    const user = getUser(body.user)
    if (!user) return c.json({ error: 'User not found' }, 404)
    if (user.revoked) return c.json({ error: 'User is revoked' }, 400)
    const token = createAuthToken(body.user)
    return c.json({ ok: true, user: body.user, token, grants: user.grants })
  })

  // ─── Session Shares ────────────────────────────────────────────────────

  app.post('/api/shares', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const body = await c.req.json<{
      sessionCwd: string
      expiresIn?: number // ms from now
      expiresAt?: number // absolute timestamp
      label?: string
      permissions?: string[]
      hideUserInput?: boolean
    }>()
    if (!body.sessionCwd) return c.json({ error: 'sessionCwd is required' }, 400)
    const expiresAt = body.expiresAt || (body.expiresIn ? Date.now() + body.expiresIn : Date.now() + 4 * 60 * 60 * 1000) // default 4h
    try {
      const share = createSessionShare({
        sessionCwd: body.sessionCwd,
        expiresAt,
        createdBy: getAuthenticatedUser(c.req.raw) || 'admin',
        label: body.label,
        permissions: body.permissions,
        hideUserInput: body.hideUserInput,
      })
      const origin = c.req.header('origin') || ''
      sessionStore.broadcastSharesUpdate()
      return c.json({
        token: share.token,
        expiresAt: share.expiresAt,
        shareUrl: `${origin}/#/share/${share.token}`,
      })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  app.get('/api/shares', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const active = listAllShares()
    // Include connected viewer count per share
    const shares = active.map(s => ({
      ...s,
      viewerCount: sessionStore.getShareViewerCount(s.token),
    }))
    return c.json({ shares })
  })

  app.get('/api/shares/:token', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const share = getShareByToken(c.req.param('token'))
    if (!share) return c.json({ error: 'Share not found' }, 404)
    return c.json({
      ...share,
      viewerCount: sessionStore.getShareViewerCount(share.token),
    })
  })

  app.delete('/api/shares/:token', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const token = c.req.param('token')
    if (revokeSessionShare(token)) {
      // Kill all WS connections authenticated with this share token
      for (const ws of sessionStore.getSubscribers()) {
        if ((ws.data as { shareToken?: string }).shareToken === token) {
          try {
            ws.send(JSON.stringify({ type: 'share_expired', reason: 'Share has been revoked' }))
            ws.close(4403, 'Share revoked')
          } catch {}
        }
      }
      sessionStore.broadcastSharesUpdate()
      return c.json({ ok: true })
    }
    return c.json({ error: 'Share not found' }, 404)
  })

  // ─── Project links ──────────────────────────────────────────────
  app.get('/api/links', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const persisted = getPersistedLinks()
    const activeSessions = sessionStore.getActiveSessions()

    const links = persisted.map(pl => {
      const sessA = activeSessions.find(s => parseProjectUri(s.project).path === pl.projectA)
      const sessB = activeSessions.find(s => parseProjectUri(s.project).path === pl.projectB)
      const nameA = getProjectSettings(pl.projectA)?.label || pl.projectA.split('/').pop() || pl.projectA
      const nameB = getProjectSettings(pl.projectB)?.label || pl.projectB.split('/').pop() || pl.projectB
      return {
        projectA: pl.projectA,
        projectB: pl.projectB,
        nameA,
        nameB,
        createdAt: pl.createdAt,
        lastUsed: pl.lastUsed,
        online: !!(sessA && sessB),
        sessionIdA: sessA?.id,
        sessionIdB: sessB?.id,
      }
    })
    return c.json({ links })
  })

  app.post('/api/links', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const body = await c.req.json<{ projectA: string; projectB: string }>()
    if (!body.projectA || !body.projectB) return c.json({ error: 'projectA and projectB required' }, 400)
    if (body.projectA === body.projectB) return c.json({ error: 'Cannot link a project to itself' }, 400)

    const link = addPersistedLink(body.projectA, body.projectB)

    // Activate the in-memory project link
    const active = sessionStore.getActiveSessions()
    const anyA = active.find(s => parseProjectUri(s.project).path === link.projectA)
    const anyB = active.find(s => parseProjectUri(s.project).path === link.projectB)
    if (anyA && anyB) sessionStore.linkProjects(anyA.id, anyB.id)

    return c.json({ ok: true, link })
  })

  app.delete('/api/links', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const body = await c.req.json<{ projectA: string; projectB: string; purgeHistory?: boolean }>()
    if (!body.projectA || !body.projectB) return c.json({ error: 'projectA and projectB required' }, 400)

    const removed = removePersistedLink(body.projectA, body.projectB)

    // Sever the in-memory project link
    sessionStore.unlinkProjects(body.projectA, body.projectB)

    let purged = 0
    if (body.purgeHistory) {
      purged = purgeMessages(body.projectA, body.projectB)
    }

    return c.json({ ok: true, removed, purged })
  })

  // ─── Inter-session message history ──────────────────────────────────
  app.get('/api/links/messages', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const projectA = c.req.query('projectA') || c.req.query('cwdA')
    const projectB = c.req.query('projectB') || c.req.query('cwdB')
    const project = c.req.query('project') || c.req.query('cwd')
    const limit = Number.parseInt(c.req.query('limit') || '50', 10)
    const beforeStr = c.req.query('before')
    const before = beforeStr ? Number.parseInt(beforeStr, 10) : undefined

    const result = queryMessages({
      projectA: projectA || undefined,
      projectB: projectB || undefined,
      project: project || undefined,
      limit,
      before,
    })
    return c.json(result)
  })

  return app
}
