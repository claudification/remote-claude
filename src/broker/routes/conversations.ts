/**
 * Conversation routes -- /conversations/*
 */

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { extractProjectLabel, parseProjectUri } from '../../shared/project-uri'
import type { SendInput } from '../../shared/protocol'
import { resolveSpawnConfig } from '../../shared/spawn-defaults'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { filterDisplayEntries } from '../../shared/transcript-filter'
import { slugify } from '../address-book'
import type { ConversationStore } from '../conversation-store'
import { getGlobalSettings } from '../global-settings'
import { getProjectSettings } from '../project-settings'
import { validateShare } from '../shares'
import { processImagesInEntry } from './blob-store'
import type { RouteHelpers } from './shared'
import { broadcastToSubscribers, conversationToOverview } from './shared'

export function createConversationsRouter(conversationStore: ConversationStore, helpers: RouteHelpers): Hono {
  const { httpHasPermission, httpIsAdmin, filterConversationsByHttpGrants } = helpers
  const app = new Hono()

  app.get('/conversations', c => {
    const activeOnly = c.req.query('active') === 'true'
    const sessions = activeOnly ? conversationStore.getActiveConversations() : conversationStore.getAllConversations()
    const filtered = filterConversationsByHttpGrants(c.req.raw, sessions)
    return c.json(filtered.map(s => conversationToOverview(s, conversationStore)))
  })

  app.get('/conversations/:id', c => {
    const session = conversationStore.getConversation(c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.project)) return c.json({ error: 'Forbidden' }, 403)
    return c.json(conversationToOverview(session, conversationStore))
  })

  app.get('/conversations/:id/events', c => {
    const sessionId = c.req.param('id')
    const session = conversationStore.getConversation(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.project)) return c.json({ error: 'Forbidden' }, 403)
    const limit = parseInt(c.req.query('limit') || '0', 10)
    const since = parseInt(c.req.query('since') || '0', 10)
    const events = conversationStore.getConversationEvents(sessionId, limit || undefined, since || undefined)
    return c.json(events)
  })

  app.get('/conversations/:id/subagents', c => {
    const session = conversationStore.getConversation(c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.project)) return c.json({ error: 'Forbidden' }, 403)
    return c.json(session.subagents)
  })

  // Transcript fetch.
  //
  // Two modes:
  //   1. Full: no `sinceSeq` query param -- returns last `limit` entries.
  //   2. Delta: `?sinceSeq=N` -- returns only entries with seq > N. Used by
  //      the dashboard to catch up on missed entries after a sync_check
  //      flags the session as stale, without refetching the whole transcript.
  //
  // Response shape (both modes): `{ entries, lastSeq, gap }`.
  //   - `lastSeq`: the largest seq currently in cache (0 if empty). Client
  //     stores this as its `lastAppliedSeq` after applying entries.
  //   - `gap`: true when delta mode requested more than cache can provide
  //     (i.e. oldest-seq-in-cache > sinceSeq+1, because MAX_TRANSCRIPT_ENTRIES
  //     evicted older entries). Client treats gap=true as "replace, don't
  //     append" -- otherwise the client's transcript would have a hole
  //     between its last applied seq and the oldest returned seq.
  app.get('/conversations/:id/transcript', c => {
    const sessionId = c.req.param('id')
    const session = conversationStore.getConversation(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.project)) return c.json({ error: 'Forbidden' }, 403)
    const limit = parseInt(c.req.query('limit') || '20', 10)
    const filter = c.req.query('filter')
    const sinceSeqRaw = c.req.query('sinceSeq')
    const sinceSeq = sinceSeqRaw !== undefined ? parseInt(sinceSeqRaw, 10) : undefined
    if (!conversationStore.hasTranscriptCache(sessionId)) {
      console.log(`[${sessionId.slice(0, 8)}] GET transcript limit=${limit} filter=${filter || 'none'} -> 404 no-cache`)
      return c.json({ error: 'No transcript in cache (rclaude not streaming yet?)' }, 404)
    }

    const allEntries = conversationStore.getTranscriptEntries(sessionId)
    const cacheSize = allEntries.length
    const lastSeq = allEntries.length > 0 ? (allEntries[allEntries.length - 1].seq ?? 0) : 0

    let entries: typeof allEntries
    let gap = false
    if (sinceSeq !== undefined && !Number.isNaN(sinceSeq)) {
      // Delta mode: entries with seq > sinceSeq.
      // `allEntries` is seq-ordered (append-only stamping), so filter suffices.
      entries = allEntries.filter(e => (e.seq ?? 0) > sinceSeq)
      // Gap detection: if the client's last-seen seq is older than anything we
      // still have in cache, they're missing entries we already evicted.
      const oldestSeq = allEntries.length > 0 ? (allEntries[0].seq ?? 0) : 0
      if (sinceSeq > 0 && oldestSeq > sinceSeq + 1) gap = true
      if (filter === 'display') entries = filterDisplayEntries(entries, limit)
      else if (limit && entries.length > limit) entries = entries.slice(-limit)
    } else {
      // Full mode (legacy): last N entries.
      entries = filter === 'display' ? filterDisplayEntries(allEntries, limit) : allEntries.slice(-limit)
    }

    // Filter user entries for share viewers with hideUserInput
    const shareToken = new URL(c.req.raw.url).searchParams.get('share')
    if (shareToken) {
      const share = validateShare(shareToken)
      if (share?.hideUserInput) {
        entries = entries.filter(e => (e as { type?: string }).type !== 'user')
      }
    }

    const mode = sinceSeq !== undefined ? `delta(sinceSeq=${sinceSeq}${gap ? ' GAP' : ''})` : `full(limit=${limit})`
    console.log(
      `[${sessionId.slice(0, 8)}] GET transcript ${mode} filter=${filter || 'none'} -> ${entries.length}/${cacheSize} entries lastSeq=${lastSeq}`,
    )
    return c.json({
      entries: entries.map(e => processImagesInEntry(e as Record<string, unknown>)),
      lastSeq,
      gap,
    })
  })

  app.get('/conversations/:id/subagents/:agentId/transcript', c => {
    const sessionId = c.req.param('id')
    const agentId = c.req.param('agentId')
    const session = conversationStore.getConversation(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.project)) return c.json({ error: 'Forbidden' }, 403)
    const limit = parseInt(c.req.query('limit') || '100', 10)
    if (!conversationStore.hasSubagentTranscriptCache(sessionId, agentId)) {
      return c.json({ error: 'No subagent transcript in cache' }, 404)
    }
    const entries = conversationStore.getSubagentTranscriptEntries(sessionId, agentId, limit)
    return c.json(entries.map(e => processImagesInEntry(e as Record<string, unknown>)))
  })

  app.get('/conversations/:id/diag', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const sessionId = c.req.param('id')
    const session = conversationStore.getConversation(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    return c.json({
      id: sessionId,
      project: session.project,
      model: session.model,
      status: session.status,
      ccSessionIds: conversationStore.getCcSessionIds(sessionId),
      capabilities: session.capabilities,
      version: session.version,
      buildTime: session.buildTime,
      startedAt: session.startedAt,
      lastActivity: session.lastActivity,
      compacting: session.compacting,
      compactedAt: session.compactedAt,
      eventCount: session.events.length,
      transcriptCacheEntries: conversationStore.getTranscriptEntries(sessionId).length,
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

  app.get('/conversations/:id/tasks', c => {
    const session = conversationStore.getConversation(c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.project)) return c.json({ error: 'Forbidden' }, 403)
    return c.json({ tasks: session.tasks, archivedTasks: session.archivedTasks })
  })

  app.post('/conversations/:id/input', async c => {
    const sessionId = c.req.param('id')
    const session = conversationStore.getConversation(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat', session.project)) return c.json({ error: 'Forbidden' }, 403)
    if (session.status === 'ended') return c.json({ error: 'Session has ended' }, 400)

    const ws = conversationStore.getConversationSocket(sessionId)
    if (!ws) return c.json({ error: 'Session not connected' }, 400)

    const body = await c.req.json<{ input: string; crDelay?: number }>()
    if (!body.input || typeof body.input !== 'string') return c.json({ error: 'Missing input field' }, 400)

    const inputMsg: SendInput = {
      type: 'input',
      conversationId: sessionId,
      input: body.input,
      ...(typeof body.crDelay === 'number' && body.crDelay > 0 && { crDelay: body.crDelay }),
    }
    ws.send(JSON.stringify(inputMsg))
    return c.json({ success: true })
  })

  app.post('/conversations/:id/revive', async c => {
    if (!httpHasPermission(c.req.raw, 'spawn', '*'))
      return c.json({ error: 'Forbidden: spawn permission required' }, 403)
    const sessionId = c.req.param('id')
    const session = conversationStore.getConversation(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (session.status === 'active') return c.json({ error: 'Session is already active' }, 400)

    // If called with X-Caller-Session header, check benevolent trust
    const callerSessionId = c.req.header('X-Caller-Session')
    if (callerSessionId) {
      const callerSess = conversationStore.getConversation(callerSessionId)
      const callerTrust = callerSess?.project ? getProjectSettings(callerSess.project)?.trustLevel : undefined
      if (callerTrust !== 'benevolent') {
        return c.json({ error: 'Requires benevolent trust level' }, 403)
      }
    }

    const sentinel = conversationStore.getSentinel()
    if (!sentinel) return c.json({ error: 'No sentinel connected' }, 503)

    const conversationId = randomUUID()
    const lc = session.launchConfig // stored launch config from original spawn
    const name =
      session.title ||
      getProjectSettings(session.project)?.label ||
      extractProjectLabel(session.project) ||
      sessionId.slice(0, 8)
    // Resolve defaults: launch config > project > global > undefined
    const projSettings = getProjectSettings(session.project)
    const globalSettings = getGlobalSettings()
    const sessionPath = parseProjectUri(session.project).path
    const resolved = resolveSpawnConfig(
      {
        cwd: sessionPath,
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

    sentinel.send(
      JSON.stringify({
        type: 'revive',
        sessionId,
        project: session.project,
        conversationId,
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
      conversationStore
        .addRendezvous(conversationId, callerSessionId, session.project, 'revive')
        .then(revived => {
          const callerWs = conversationStore.getConversationSocket(callerSessionId)
          if (callerWs) {
            callerWs.send(
              JSON.stringify({
                type: 'revive_ready',
                sessionId: revived.id,
                project: revived.project,
                conversationId,
                session: revived,
              }),
            )
          }
        })
        .catch(err => {
          const callerWs = conversationStore.getConversationSocket(callerSessionId)
          if (callerWs) {
            callerWs.send(
              JSON.stringify({
                type: 'revive_timeout',
                conversationId,
                sessionId,
                project: session.project,
                error: typeof err === 'string' ? err : 'Revive rendezvous timed out',
              }),
            )
          }
        })
    }

    return c.json({ success: true, name, message: 'Revive command sent to sentinel', conversationId }, 202)
  })

  app.get('/conversations/by-slug/:slug', c => {
    const slug = c.req.param('slug')
    const all = conversationStore.getAllConversations()
    const filtered = filterConversationsByHttpGrants(c.req.raw, all)
    const match = filtered.find(s => {
      if (s.title && slugify(s.title) === slug) return true
      const dirname = extractProjectLabel(s.project)
      if (dirname && slugify(dirname) === slug) return true
      return slugify(s.id.slice(0, 8)) === slug
    })
    if (!match) return c.json({ error: 'Session not found' }, 404)
    return c.json(conversationToOverview(match, conversationStore))
  })

  app.get('/api/share-resolve/:token', c => {
    const share = validateShare(c.req.param('token'))
    if (!share) return c.json({ error: 'Invalid or expired share' }, 404)
    const sessions = sessionStore.getAllSessions().filter(s => s.project === share.sessionCwd)
    sessions.sort((a, b) => b.lastActivity - a.lastActivity)
    const best = sessions[0]
    return c.json({
      project: share.sessionCwd,
      sessionId: best?.id || null,
    })
  })

  app.delete('/conversations/:id', c => {
    if (!httpHasPermission(c.req.raw, 'settings', '*')) return c.json({ error: 'Forbidden' }, 403)
    const sessionId = c.req.param('id')
    const session = conversationStore.getConversation(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (session.status !== 'ended') return c.json({ error: 'Only ended sessions can be dismissed' }, 400)
    conversationStore.removeConversation(sessionId)
    broadcastToSubscribers(conversationStore, { type: 'conversation_dismissed', sessionId })
    return c.json({ success: true })
  })

  return app
}
