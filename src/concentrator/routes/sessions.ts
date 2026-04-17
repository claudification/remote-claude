/**
 * Session routes -- /sessions/*
 */

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { SendInput } from '../../shared/protocol'
import { resolveSpawnConfig } from '../../shared/spawn-defaults'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { getGlobalSettings } from '../global-settings'
import { getProjectSettings } from '../project-settings'
import type { SessionStore } from '../session-store'
import { validateShare } from '../shares'
import { processImagesInEntry } from './blob-store'
import type { RouteHelpers } from './shared'
import { broadcastToSubscribers, sessionToOverview } from './shared'

export function createSessionsRouter(sessionStore: SessionStore, helpers: RouteHelpers): Hono {
  const { httpHasPermission, httpIsAdmin, filterSessionsByHttpGrants } = helpers
  const app = new Hono()

  app.get('/sessions', c => {
    const activeOnly = c.req.query('active') === 'true'
    const sessions = activeOnly ? sessionStore.getActiveSessions() : sessionStore.getAllSessions()
    const filtered = filterSessionsByHttpGrants(c.req.raw, sessions)
    return c.json(filtered.map(s => sessionToOverview(s, sessionStore)))
  })

  app.get('/sessions/:id', c => {
    const session = sessionStore.getSession(c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.cwd)) return c.json({ error: 'Forbidden' }, 403)
    return c.json(sessionToOverview(session, sessionStore))
  })

  app.get('/sessions/:id/events', c => {
    const sessionId = c.req.param('id')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.cwd)) return c.json({ error: 'Forbidden' }, 403)
    const limit = parseInt(c.req.query('limit') || '0', 10)
    const since = parseInt(c.req.query('since') || '0', 10)
    const events = sessionStore.getSessionEvents(sessionId, limit || undefined, since || undefined)
    return c.json(events)
  })

  app.get('/sessions/:id/subagents', c => {
    const session = sessionStore.getSession(c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.cwd)) return c.json({ error: 'Forbidden' }, 403)
    return c.json(session.subagents)
  })

  app.get('/sessions/:id/transcript', c => {
    const sessionId = c.req.param('id')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.cwd)) return c.json({ error: 'Forbidden' }, 403)
    const limit = parseInt(c.req.query('limit') || '20', 10)
    if (!sessionStore.hasTranscriptCache(sessionId)) {
      return c.json({ error: 'No transcript in cache (rclaude not streaming yet?)' }, 404)
    }
    let entries = sessionStore.getTranscriptEntries(sessionId, limit)

    // Filter user entries for share viewers with hideUserInput
    const shareToken = new URL(c.req.raw.url).searchParams.get('share')
    if (shareToken) {
      const share = validateShare(shareToken)
      if (share?.hideUserInput) {
        entries = entries.filter(e => (e as { type?: string }).type !== 'user')
      }
    }

    return c.json(entries.map(e => processImagesInEntry(e as Record<string, unknown>)))
  })

  app.get('/sessions/:id/subagents/:agentId/transcript', c => {
    const sessionId = c.req.param('id')
    const agentId = c.req.param('agentId')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.cwd)) return c.json({ error: 'Forbidden' }, 403)
    const limit = parseInt(c.req.query('limit') || '100', 10)
    if (!sessionStore.hasSubagentTranscriptCache(sessionId, agentId)) {
      return c.json({ error: 'No subagent transcript in cache' }, 404)
    }
    const entries = sessionStore.getSubagentTranscriptEntries(sessionId, agentId, limit)
    return c.json(entries.map(e => processImagesInEntry(e as Record<string, unknown>)))
  })

  app.get('/sessions/:id/diag', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const sessionId = c.req.param('id')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    return c.json({
      id: sessionId,
      cwd: session.cwd,
      model: session.model,
      status: session.status,
      wrapperIds: sessionStore.getWrapperIds(sessionId),
      capabilities: session.capabilities,
      version: session.version,
      buildTime: session.buildTime,
      startedAt: session.startedAt,
      lastActivity: session.lastActivity,
      compacting: session.compacting,
      compactedAt: session.compactedAt,
      eventCount: session.events.length,
      transcriptCacheEntries: sessionStore.getTranscriptEntries(sessionId).length,
      subagents: session.subagents,
      tasks: session.tasks,
      bgTasks: session.bgTasks,
      teammates: session.teammates,
      team: session.team,
      args: session.args,
      sessionInfo: (session as unknown as Record<string, unknown>).sessionInfo,
      diagLog: session.diagLog,
    })
  })

  app.get('/sessions/:id/tasks', c => {
    const session = sessionStore.getSession(c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.cwd)) return c.json({ error: 'Forbidden' }, 403)
    return c.json({ tasks: session.tasks, archivedTasks: session.archivedTasks })
  })

  app.post('/sessions/:id/input', async c => {
    const sessionId = c.req.param('id')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat', session.cwd)) return c.json({ error: 'Forbidden' }, 403)
    if (session.status === 'ended') return c.json({ error: 'Session has ended' }, 400)

    const ws = sessionStore.getSessionSocket(sessionId)
    if (!ws) return c.json({ error: 'Session not connected' }, 400)

    const body = await c.req.json<{ input: string; crDelay?: number }>()
    if (!body.input || typeof body.input !== 'string') return c.json({ error: 'Missing input field' }, 400)

    const inputMsg: SendInput = {
      type: 'input',
      sessionId,
      input: body.input,
      ...(typeof body.crDelay === 'number' && body.crDelay > 0 && { crDelay: body.crDelay }),
    }
    ws.send(JSON.stringify(inputMsg))
    return c.json({ success: true })
  })

  app.post('/sessions/:id/revive', async c => {
    if (!httpHasPermission(c.req.raw, 'spawn', '*'))
      return c.json({ error: 'Forbidden: spawn permission required' }, 403)
    const sessionId = c.req.param('id')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (session.status === 'active') return c.json({ error: 'Session is already active' }, 400)

    // If called with X-Caller-Session header, check benevolent trust
    const callerSessionId = c.req.header('X-Caller-Session')
    if (callerSessionId) {
      const callerSess = sessionStore.getSession(callerSessionId)
      const callerTrust = callerSess?.cwd ? getProjectSettings(callerSess.cwd)?.trustLevel : undefined
      if (callerTrust !== 'benevolent') {
        return c.json({ error: 'Requires benevolent trust level' }, 403)
      }
    }

    const agent = sessionStore.getAgent()
    if (!agent) return c.json({ error: 'No host agent connected' }, 503)

    const wrapperId = randomUUID()
    const lc = session.launchConfig // stored launch config from original spawn
    const name =
      session.title || getProjectSettings(session.cwd)?.label || session.cwd.split('/').pop() || sessionId.slice(0, 8)
    // Resolve defaults: launch config > project > global > undefined
    const projSettings = getProjectSettings(session.cwd)
    const globalSettings = getGlobalSettings()
    const resolved = resolveSpawnConfig(
      {
        cwd: session.cwd,
        headless: lc?.headless,
        model: lc?.model as SpawnRequest['model'] | undefined,
        effort: lc?.effort as SpawnRequest['effort'] | undefined,
        bare: lc?.bare,
        repl: lc?.repl,
        permissionMode: lc?.permissionMode as SpawnRequest['permissionMode'] | undefined,
        autocompactPct: lc?.autocompactPct,
        maxBudgetUsd: lc?.maxBudgetUsd,
      },
      projSettings,
      globalSettings,
    )
    const { headless, model, effort, bare, repl, permissionMode, autocompactPct, maxBudgetUsd } = resolved

    agent.send(
      JSON.stringify({
        type: 'revive',
        sessionId,
        cwd: session.cwd,
        wrapperId,
        mode: 'resume',
        headless,
        effort,
        model,
        sessionName: session.title || undefined,
        bare: bare || undefined,
        repl: repl || undefined,
        permissionMode,
        autocompactPct: autocompactPct ?? session.autocompactPct,
        maxBudgetUsd: maxBudgetUsd ?? session.maxBudgetUsd,
        adHocWorktree: session.adHocWorktree || undefined,
        env: lc?.env || undefined,
      }),
    )

    // Register rendezvous for MCP callers
    if (callerSessionId) {
      sessionStore
        .addRendezvous(wrapperId, callerSessionId, session.cwd, 'revive')
        .then(revived => {
          const callerWs = sessionStore.getSessionSocket(callerSessionId)
          if (callerWs) {
            callerWs.send(
              JSON.stringify({
                type: 'revive_ready',
                sessionId: revived.id,
                cwd: revived.cwd,
                wrapperId,
                session: revived,
              }),
            )
          }
        })
        .catch(err => {
          const callerWs = sessionStore.getSessionSocket(callerSessionId)
          if (callerWs) {
            callerWs.send(
              JSON.stringify({
                type: 'revive_timeout',
                wrapperId,
                sessionId,
                cwd: session.cwd,
                error: typeof err === 'string' ? err : 'Revive rendezvous timed out',
              }),
            )
          }
        })
    }

    return c.json({ success: true, name, message: 'Revive command sent to agent', wrapperId }, 202)
  })

  app.delete('/sessions/:id', c => {
    if (!httpHasPermission(c.req.raw, 'settings', '*')) return c.json({ error: 'Forbidden' }, 403)
    const sessionId = c.req.param('id')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (session.status !== 'ended') return c.json({ error: 'Only ended sessions can be dismissed' }, 400)
    sessionStore.removeSession(sessionId)
    broadcastToSubscribers(sessionStore, { type: 'session_dismissed', sessionId })
    return c.json({ success: true })
  })

  return app
}
