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

import { marked } from 'marked'
import { Hono } from 'hono'
import { getAuthenticatedUser } from '../auth-routes'
import type { ConversationStore } from '../conversation-store'
import { getRecapOrchestrator } from '../recap-orchestrator'
import { createShare, validateShare } from '../shares'
import type { RouteHelpers } from './shared'

const CROSS_PROJECT = '*'

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }
  return text.replace(/[&<>"']/g, (m) => map[m])
}

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
    const accept = c.req.header('accept') || ''

    // If client explicitly wants raw markdown (text/markdown or text/plain)
    if (accept.includes('text/markdown') || accept.includes('text/plain')) {
      return new Response(markdown, {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
        },
      })
    }

    // If client wants HTML or wildcard, render markdown to HTML
    if (accept.includes('text/html') || accept.includes('*/*') || !accept) {
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset=utf-8>
  <meta name=viewport content="width=device-width, initial-scale=1">
  <title>${escapeHtml(row.title || `Recap ${id.slice(0, 12)}`)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; color: #333; background: #f9f9f9; }
    .container { max-width: 48rem; margin: 0 auto; padding: 2.5rem 1.5rem; background: white; }
    h1, h2, h3, h4, h5, h6 { margin: 1.5rem 0 0.5rem; font-weight: 600; }
    h1 { font-size: 2rem; }
    h2 { font-size: 1.5rem; }
    h3 { font-size: 1.25rem; }
    p { margin: 1rem 0; }
    ul, ol { margin: 1rem 0; padding-left: 2rem; }
    li { margin: 0.5rem 0; }
    code { background: #f4f4f4; padding: 0.2rem 0.4rem; border-radius: 3px; font-family: monospace; }
    pre { background: #f4f4f4; padding: 1rem; border-radius: 5px; overflow-x: auto; margin: 1rem 0; }
    pre code { background: none; padding: 0; }
    blockquote { border-left: 4px solid #ddd; padding-left: 1rem; margin: 1rem 0; color: #666; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #ddd; padding: 0.75rem; text-align: left; }
    th { background: #f4f4f4; font-weight: 600; }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; color: #e0e0e0; }
      .container { background: #2a2a2a; }
      code { background: #333; }
      pre { background: #333; }
      table { border-color: #444; }
      th { background: #333; }
      blockquote { color: #999; }
      a { color: #66b3ff; }
    }
  </style>
</head>
<body>
  <div class=container>
    <main>${marked(markdown)}</main>
  </div>
</body>
</html>`
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
        },
      })
    }

    // Default: download as attachment
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

  // Public share viewer. No auth required -- the token IS the capability.
  // Validates targetKind === 'recap' and returns recap markdown + metadata.
  // Respects Accept header: text/html (or browser default) returns rendered HTML,
  // application/json returns JSON data, text/markdown returns raw markdown.
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

    const accept = c.req.header('accept') || ''
    const data = {
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
    }

    // If explicitly requesting raw markdown, return it without rendering
    if (accept.includes('text/markdown') || accept.includes('text/plain')) {
      return new Response(row.markdown, {
        headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      })
    }

    // Default for browsers: render as HTML
    if (accept.includes('text/html') || accept.includes('*/*') || !accept) {
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset=utf-8>
  <meta name=viewport content="width=device-width, initial-scale=1">
  <title>${escapeHtml(row.title || `Recap ${row.id.slice(0, 12)}`)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; color: #333; background: #f9f9f9; }
    .container { max-width: 48rem; margin: 0 auto; padding: 2.5rem 1.5rem; background: white; }
    h1, h2, h3, h4, h5, h6 { margin: 1.5rem 0 0.5rem; font-weight: 600; }
    h1 { font-size: 2rem; }
    h2 { font-size: 1.5rem; }
    h3 { font-size: 1.25rem; }
    p { margin: 1rem 0; }
    ul, ol { margin: 1rem 0; padding-left: 2rem; }
    li { margin: 0.5rem 0; }
    code { background: #f4f4f4; padding: 0.2rem 0.4rem; border-radius: 3px; font-family: monospace; }
    pre { background: #f4f4f4; padding: 1rem; border-radius: 5px; overflow-x: auto; margin: 1rem 0; }
    pre code { background: none; padding: 0; }
    blockquote { border-left: 4px solid #ddd; padding-left: 1rem; margin: 1rem 0; color: #666; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #ddd; padding: 0.75rem; text-align: left; }
    th { background: #f4f4f4; font-weight: 600; }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; color: #e0e0e0; }
      .container { background: #2a2a2a; }
      code { background: #333; }
      pre { background: #333; }
      table { border-color: #444; }
      th { background: #333; }
      blockquote { color: #999; }
      a { color: #66b3ff; }
    }
  </style>
</head>
<body>
  <div class=container>
    <header class="mb-6 pb-4 border-b">
      <h1>${escapeHtml(row.title || 'Recap')}</h1>
      ${row.subtitle ? `<p class="italic text-muted">${escapeHtml(row.subtitle)}</p>` : ''}
      <p class="text-sm text-muted" style="margin-top: 0.5rem; font-size: 0.875rem; color: #999;">
        ${new Date(row.periodStart).toISOString().slice(0, 10)} - ${new Date(row.periodEnd).toISOString().slice(0, 10)}
        ${row.model ? ` - ${escapeHtml(row.model)}` : ''}
        ${share.expiresAt ? ` - share expires ${new Date(share.expiresAt).toISOString().slice(0, 10)}` : ''}
      </p>
    </header>
    <main>${marked(row.markdown)}</main>
  </div>
</body>
</html>`
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    // Default: return JSON
    return c.json(data)
  })

  // Pretty shorthand redirect: /r/:token -> /shared/public/recap/:token
  app.get('/r/:token', c => {
    const token = c.req.param('token')
    return c.redirect(`/shared/public/recap/${encodeURIComponent(token)}`)
  })

  return app
}
