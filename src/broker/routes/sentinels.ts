/**
 * Sentinel management routes -- /api/sentinels
 * Admin-only CRUD for sentinel hosts.
 */

import { Hono } from 'hono'
import type { ConversationStore } from '../conversation-store'
import { isValidSentinelAlias, type SentinelRegistry } from '../sentinel-registry'
import type { RouteHelpers } from './shared'

export function createSentinelRouter(
  sentinelRegistry: SentinelRegistry,
  conversationStore: ConversationStore,
  helpers: RouteHelpers,
): Hono {
  const { httpIsAdmin } = helpers
  const app = new Hono()

  // ─── Create sentinel ──────────────────────────────────────────────────
  app.post('/api/sentinels/create', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Admin access required' }, 403)

    const body = (await c.req.json()) as { alias?: string; color?: string }
    const alias = body.alias?.trim().toLowerCase()

    if (!alias) return c.json({ error: 'alias is required' }, 400)
    if (!isValidSentinelAlias(alias)) {
      return c.json({ error: 'Invalid alias: must be lowercase alphanumeric with hyphens, 1-63 chars' }, 400)
    }

    const existing = sentinelRegistry.findByAlias(alias)
    if (existing) return c.json({ error: `Alias "${alias}" already exists` }, 409)

    const record = sentinelRegistry.create({
      alias,
      color: body.color,
      generateSecret: true,
    })

    return c.json({
      sentinelId: record.sentinelId,
      sentinelSecret: record.rawSecret,
      alias: record.aliases[0],
      isDefault: record.isDefault,
      color: record.color,
    })
  })

  // ─── List sentinels ────────────────────────────────────────────────────
  app.get('/api/sentinels', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Admin access required' }, 403)

    const all = sentinelRegistry.getAll()
    const result: Array<{
      sentinelId: string
      alias: string
      aliases: string[]
      isDefault: boolean
      color?: string
      connected: boolean
      hostname?: string
      spawnRoot?: string
      createdAt: number
    }> = []

    for (const [sentinelId, record] of all) {
      const conn = conversationStore.getSentinelConnection(sentinelId)
      result.push({
        sentinelId,
        alias: record.aliases[0],
        aliases: record.aliases,
        isDefault: record.isDefault,
        color: record.color,
        connected: !!conn,
        hostname: conn?.hostname,
        spawnRoot: conn?.spawnRoot,
        createdAt: record.createdAt,
      })
    }

    return c.json(result)
  })

  // ─── Update sentinel ──────────────────────────────────────────────────
  app.post('/api/sentinels/:id', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Admin access required' }, 403)

    const sentinelId = c.req.param('id')
    const body = (await c.req.json()) as { alias?: string; isDefault?: boolean; color?: string }

    if (body.alias !== undefined) {
      const alias = body.alias.trim().toLowerCase()
      if (!isValidSentinelAlias(alias)) {
        return c.json({ error: 'Invalid alias: must be lowercase alphanumeric with hyphens, 1-63 chars' }, 400)
      }
      const existing = sentinelRegistry.findByAlias(alias)
      if (existing && existing.sentinelId !== sentinelId) {
        return c.json({ error: `Alias "${alias}" already in use` }, 409)
      }
      body.alias = alias
    }

    const updated = sentinelRegistry.update(sentinelId, body)
    if (!updated) return c.json({ error: 'Sentinel not found' }, 404)

    return c.json({
      sentinelId: updated.sentinelId,
      alias: updated.aliases[0],
      aliases: updated.aliases,
      isDefault: updated.isDefault,
      color: updated.color,
    })
  })

  // ─── Delete sentinel ──────────────────────────────────────────────────
  app.delete('/api/sentinels/:id', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Admin access required' }, 403)

    const sentinelId = c.req.param('id')
    const record = sentinelRegistry.get(sentinelId)
    if (!record) return c.json({ error: 'Sentinel not found' }, 404)

    // Disconnect sentinel if online
    const conn = conversationStore.getSentinelConnection(sentinelId)
    if (conn) {
      try {
        conn.ws.close(4403, 'Sentinel revoked')
      } catch {}
    }

    sentinelRegistry.remove(sentinelId)
    return c.json({ ok: true })
  })

  return app
}
