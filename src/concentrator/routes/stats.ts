/**
 * Stats routes -- /api/stats/*, /api/analytics/*, /api/projects, /api/subscriptions
 */

import { Hono } from 'hono'
import {
  queryModelComparison as queryAnalyticsModels,
  querySummary as queryAnalyticsSummary,
  queryTimeSeries as queryAnalyticsTimeSeries,
} from '../analytics-store'
import { queryHourly, querySummary, queryTurns } from '../cost-store'
import { listProjects } from '../project-store'
import type { SessionStore } from '../session-store'
import type { RouteHelpers } from './shared'

export function createStatsRouter(sessionStore: SessionStore, helpers: RouteHelpers, serverStartTime: number): Hono {
  const { httpIsAdmin } = helpers
  const app = new Hono()

  // ─── Stats ─────────────────────────────────────────────────────────
  app.get('/api/stats', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const allSessions = sessionStore.getAllSessions()
    let active = 0
    let idle = 0
    let ended = 0
    for (const s of allSessions) {
      if (s.status === 'active') active++
      else if (s.status === 'idle') idle++
      else ended++
    }

    const diag = sessionStore.getSubscriptionsDiag()
    const traffic = sessionStore.getTrafficStats()

    return c.json({
      uptime: Math.round((Date.now() - serverStartTime) / 1000),
      sessions: { total: allSessions.length, active, idle, ended },
      connections: {
        total: diag.summary.totalSubscribers,
        legacy: diag.summary.legacySubscribers,
        v2: diag.summary.v2Subscribers,
      },
      traffic,
      channels: diag.summary.channelCounts,
    })
  })

  app.get('/api/subscriptions', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    return c.json(sessionStore.getSubscriptionsDiag())
  })

  // ─── Cost reporting ─────────────────────────────────────────────────

  app.get('/api/stats/turns', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const q = c.req.query()
    return c.json(
      queryTurns({
        from: q.from ? Number(q.from) : undefined,
        to: q.to ? Number(q.to) : undefined,
        account: q.account || undefined,
        model: q.model || undefined,
        cwd: q.cwd || undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
      }),
    )
  })

  app.get('/api/stats/hourly', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const q = c.req.query()
    return c.json(
      queryHourly({
        from: q.from ? Number(q.from) : undefined,
        to: q.to ? Number(q.to) : undefined,
        account: q.account || undefined,
        model: q.model || undefined,
        cwd: q.cwd || undefined,
        groupBy: (q.groupBy as 'hour' | 'day') || undefined,
      }),
    )
  })

  app.get('/api/stats/summary', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const period = (c.req.query('period') || '24h') as '24h' | '7d' | '30d'
    if (!['24h', '7d', '30d'].includes(period)) {
      return c.json({ error: 'Invalid period. Use 24h, 7d, or 30d' }, 400)
    }
    return c.json(querySummary(period))
  })

  // ─── Projects ──────────────────────────────────────────────────────

  app.get('/api/projects', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    return c.json({ projects: listProjects() })
  })

  // ─── Analytics ─────────────────────────────────────────────────────

  app.get('/api/analytics/summary', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const period = (c.req.query('period') || '7d') as '24h' | '7d' | '30d' | '90d'
    const project = c.req.query('project') || undefined
    if (!['24h', '7d', '30d', '90d'].includes(period)) {
      return c.json({ error: 'Invalid period. Use 24h, 7d, 30d, or 90d' }, 400)
    }
    return c.json(queryAnalyticsSummary(period, project))
  })

  app.get('/api/analytics/timeseries', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const period = (c.req.query('period') || '7d') as '24h' | '7d' | '30d'
    const granularity = (c.req.query('granularity') || 'hour') as 'hour' | 'day'
    const project = c.req.query('project') || undefined
    if (!['24h', '7d', '30d'].includes(period)) {
      return c.json({ error: 'Invalid period. Use 24h, 7d, or 30d' }, 400)
    }
    return c.json(queryAnalyticsTimeSeries(period, granularity, project))
  })

  app.get('/api/analytics/models', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const period = (c.req.query('period') || '7d') as '24h' | '7d' | '30d' | '90d'
    const project = c.req.query('project') || undefined
    if (!['24h', '7d', '30d', '90d'].includes(period)) {
      return c.json({ error: 'Invalid period. Use 24h, 7d, 30d, or 90d' }, 400)
    }
    return c.json(queryAnalyticsModels(period, project))
  })

  return app
}
