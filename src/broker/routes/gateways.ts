/**
 * Gateway management routes -- /api/gateways
 * Admin-only CRUD for gateway adapters.
 */

import { Hono } from 'hono'
import type { ConversationStore } from '../conversation-store'
import { type GatewayRegistry, isValidGatewayAlias } from '../gateway-registry'
import type { RouteHelpers } from './shared'

export function createGatewayRouter(
  gatewayRegistry: GatewayRegistry,
  conversationStore: ConversationStore,
  helpers: RouteHelpers,
): Hono {
  const { httpIsAdmin } = helpers
  const app = new Hono()

  app.post('/api/gateways/create', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Admin access required' }, 403)

    const body = (await c.req.json()) as { alias?: string; gatewayType?: string; label?: string }
    const alias = body.alias?.trim().toLowerCase()
    const gatewayType = body.gatewayType?.trim() || 'hermes'

    if (!alias) return c.json({ error: 'alias is required' }, 400)
    if (!isValidGatewayAlias(alias)) {
      return c.json({ error: 'Invalid alias: must be lowercase alphanumeric with hyphens, 1-63 chars' }, 400)
    }

    const existing = gatewayRegistry.findByAlias(alias)
    if (existing) return c.json({ error: `Alias "${alias}" already exists` }, 409)

    const record = gatewayRegistry.create({
      alias,
      gatewayType,
      label: body.label,
      generateSecret: true,
    })

    return c.json({
      gatewayId: record.gatewayId,
      gatewaySecret: record.rawSecret,
      alias: record.alias,
      gatewayType: record.gatewayType,
      label: record.label,
    })
  })

  app.get('/api/gateways', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Admin access required' }, 403)

    const all = gatewayRegistry.getAll()
    const result: Array<{
      gatewayId: string
      alias: string
      gatewayType: string
      label?: string
      connected: boolean
      createdAt: number
    }> = []

    for (const [gatewayId, record] of all) {
      const gwSocket = conversationStore.getGatewaySocketById(gatewayId)
      result.push({
        gatewayId,
        alias: record.alias,
        gatewayType: record.gatewayType,
        label: record.label,
        connected: !!gwSocket,
        createdAt: record.createdAt,
      })
    }

    return c.json(result)
  })

  app.delete('/api/gateways/:id', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Admin access required' }, 403)

    const gatewayId = c.req.param('id')
    const record = gatewayRegistry.get(gatewayId)
    if (!record) return c.json({ error: 'Gateway not found' }, 404)

    gatewayRegistry.remove(gatewayId)
    return c.json({ ok: true })
  })

  return app
}
