/**
 * HTTP routes for period recaps.
 *
 *   GET  /api/recaps                    list (filtered by permission)
 *   GET  /api/recaps/:id                full doc as JSON
 *   GET  /api/recaps/:id/markdown       text/markdown download
 *   GET  /api/recaps/:id/logs           log entries JSON
 *   POST /api/recaps/:id/share          create polymorphic share token
 *   GET  /r/:token                      pretty share-viewer URL (redirects)
 *
 * Permission model (decision 19 in plan-recap.md):
 *   - per-project recaps  -> require chat:read on the recap's project_uri
 *   - cross-project recap -> creator-only (or admin)
 *   - share tokens for recaps don't grant any project access; the viewer route
 *     reads the recap's stored markdown directly.
 */

import { Hono } from 'hono'
import { getAuthenticatedUser } from '../auth-routes'
import type { ConversationStore } from '../conversation-store'
import { getRecapOrchestrator } from '../recap-orchestrator'
import { createShare, validateShare } from '../shares'
import type { RouteHelpers } from './shared'

const CROSS_PROJECT = '*'

interface ShareCreateBody {
  expiresIn?: number
  expiresAt?: number
  label?: string
}

function badRequest(message: string) {
  return { error: message }
}

function notFound() {
  return { error: 'recap not found' }
}

function canRead(req: Request, helpers: RouteHelpers, projectUri: string, createdBy: string | undefined): boolean {
  if (helpers.httpIsAdmin(req)) return true
  if (projectUri === CROSS_PROJECT) {
    const user = getAuthenticatedUser(req)
    return Boolean(user && createdBy && user === createdBy)
  }
  return helpers.httpHasPermission(req, 'chat:read', projectUri)
}

function safeSlug(input: string): string {
  return (input || 'recap')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function projectSlug(projectUri: string): string {
  if (projectUri === CROSS_PROJECT) return 'all-projects'
  const tail = projectUri.split('/').filter(Boolean).pop() || 'project'
  return safeSlug(tail)
}

function buildFilename(meta: {
  projectUri: string
  periodLabel: string
  periodStart: number
  completedAt?: number
  createdAt: number
}): string {
  const slug = projectSlug(meta.projectUri)
  const stamp = new Date(meta.completedAt || meta.createdAt || meta.periodStart).toISOString().slice(0, 10)
  return `recap-${slug}-${meta.periodLabel}-${stamp}.md`
}

export function createRecapsRouter(_conversationStore: ConversationStore, helpers: RouteHelpers): Hono {
  const app = new Hono()

  app.get('/api/recaps', c => {
    const orch = getRecapOrchestrator()
    if (!orch) return c.json({ recaps: [] })

    const url = new URL(c.req.url)
    const projectUri = url.searchParams.get('projectUri') || undefined
    const status = url.searchParams.getAll('status').filter(Boolean) as Array<
      'queued' | 'gathering' | 'rendering' | 'done' | 'failed' | 'cancelled'
    >
    const limitRaw = url.searchParams.get('limit')
    const limit = limitRaw ? Math.max(1, Math.min(200, Number.parseInt(limitRaw, 10) || 50)) : 50

    const recaps = orch.list({
      projectUri,
      status: status.length > 0 ? status : undefined,
      limit,
    })

    const user = getAuthenticatedUser(c.req.raw)
    const filtered = recaps.filter(r => {
      if (helpers.httpIsAdmin(c.req.raw)) return true
      if (r.projectUri === CROSS_PROJECT) {
        // cross-project: creator-only (no createdBy in summary; orchestrator's
        // get() exposes it via row, but we don't have it on summary today).
        // Conservative: surface only to admin until creator field flows up.
        return false
      }
      return helpers.httpHasPermission(c.req.raw, 'chat:read', r.projectUri)
    })

    return c.json({ recaps: filtered, total: filtered.length, _user: user || null })
  })

  app.get('/api/recaps/:id', c => {
    const orch = getRecapOrchestrator()
    if (!orch) return c.json(notFound(), 404)
    const result = orch.get(c.req.param('id'), false)
    if (!result) return c.json(notFound(), 404)
    const row = orch.store.get(c.req.param('id'))
    if (!canRead(c.req.raw, helpers, result.recap.projectUri, row?.createdBy ?? undefined)) {
      return c.json({ error: 'forbidden' }, 403)
    }
    return c.json({ recap: result.recap })
  })

  app.get('/api/recaps/:id/markdown', c => {
    const orch = getRecapOrchestrator()
    if (!orch) return c.json(notFound(), 404)
    const id = c.req.param('id')
    const row = orch.store.get(id)
    if (!row) return c.json(notFound(), 404)
    if (!canRead(c.req.raw, helpers, row.projectUri, row.createdBy ?? undefined)) {
      return c.json({ error: 'forbidden' }, 403)
    }
    if (row.status !== 'done') return c.json({ error: 'recap not done yet' }, 409)
    const markdown = orch.getMarkdown(id)
    if (!markdown) return c.json({ error: 'recap markdown missing' }, 409)
    const filename = buildFilename({
      projectUri: row.projectUri,
      periodLabel: row.periodLabel,
      periodStart: row.periodStart,
      completedAt: row.completedAt ?? undefined,
      createdAt: row.createdAt,
    })
    return new Response(markdown, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  })

  app.get('/api/recaps/:id/logs', c => {
    const orch = getRecapOrchestrator()
    if (!orch) return c.json(notFound(), 404)
    const id = c.req.param('id')
    const row = orch.store.get(id)
    if (!row) return c.json(notFound(), 404)
    if (!canRead(c.req.raw, helpers, row.projectUri, row.createdBy ?? undefined)) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const result = orch.get(id, true)
    return c.json({ logs: result?.logs ?? [] })
  })

  app.post('/api/recaps/:id/share', async c => {
    const orch = getRecapOrchestrator()
    if (!orch) return c.json(notFound(), 404)
    const id = c.req.param('id')
    const row = orch.store.get(id)
    if (!row) return c.json(notFound(), 404)
    if (!canRead(c.req.raw, helpers, row.projectUri, row.createdBy ?? undefined)) {
      return c.json({ error: 'forbidden' }, 403)
    }
    if (row.status !== 'done' || !row.markdown) {
      return c.json(badRequest('cannot share a recap that is not done'), 409)
    }
    let body: ShareCreateBody = {}
    try {
      body = (await c.req.json<ShareCreateBody>()) ?? {}
    } catch {
      body = {}
    }
    const expiresAt =
      body.expiresAt || (body.expiresIn ? Date.now() + body.expiresIn : Date.now() + 24 * 60 * 60 * 1000)
    try {
      // Recap shares grant ZERO project permissions -- the share viewer
      // route reads the recap directly via /api/share/recap/:token. The
      // empty permissions array means a recap share token leaks nothing
      // beyond the one stored markdown document.
      const share = createShare({
        project: row.projectUri,
        expiresAt,
        createdBy: getAuthenticatedUser(c.req.raw) || row.createdBy || 'admin',
        label: body.label || row.title || `Recap ${id}`,
        permissions: [],
        targetKind: 'recap',
        targetId: id,
      })
      const origin = c.req.header('origin') || ''
      return c.json({
        token: share.token,
        expiresAt: share.expiresAt,
        shareUrl: `${origin}/r/${share.token}`,
        targetKind: 'recap',
        targetId: id,
      })
    } catch (err) {
      return c.json(badRequest((err as Error).message), 400)
    }
  })

  // Public share viewer data endpoint. No auth required -- the token IS the
  // capability. Validates targetKind === 'recap' and returns only the
  // recap's safe public surface (markdown + presentation metadata, never
  // the createdBy / project URI / underlying conversation ids).
  app.get('/shared/public/recap/:token', c => {
    const orch = getRecapOrchestrator()
    if (!orch) return c.json({ error: 'recap orchestrator not initialised' }, 503)
    const token = c.req.param('token')
    const share = validateShare(token)
    if (!share) return c.json({ error: 'invalid or expired share token' }, 404)
    if (share.targetKind !== 'recap' || !share.targetId) {
      return c.json({ error: 'token is not a recap share' }, 400)
    }
    const row = orch.store.get(share.targetId)
    if (!row || row.status !== 'done' || !row.markdown) {
      return c.json({ error: 'recap not available' }, 404)
    }
    return c.json({
      recapId: row.id,
      title: row.title,
      subtitle: row.subtitle,
      periodLabel: row.periodLabel,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      timeZone: row.timeZone,
      model: row.model,
      markdown: row.markdown,
      llmCostUsd: row.llmCostUsd,
      completedAt: row.completedAt,
      shareLabel: share.label,
      expiresAt: share.expiresAt,
    })
  })

  // Pretty shorthand redirect: /r/:token -> /?share=:token&kind=recap
  app.get('/r/:token', c => {
    const token = c.req.param('token')
    return c.redirect(`/?share=${encodeURIComponent(token)}&kind=recap`)
  })

  return app
}
