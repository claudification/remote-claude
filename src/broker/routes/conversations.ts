/**
 * Conversation routes -- /conversations/*
 */

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
import type { TerminationLog } from '../termination-log'

export function createConversationsRouter(
  conversationStore: ConversationStore,
  helpers: RouteHelpers,
  terminationLog?: TerminationLog,
): Hono {
  const { httpHasPermission, httpIsAdmin, filterConversationsByHttpGrants } = helpers
  const app = new Hono()

  app.get('/conversations', c => {
    const activeOnly = c.req.query('active') === 'true'
    const conversations = activeOnly
      ? conversationStore.getActiveConversations()
      : conversationStore.getAllConversations()
    const filtered = filterConversationsByHttpGrants(c.req.raw, conversations)
    return c.json(filtered.map(s => conversationToOverview(s, conversationStore)))
  })

  app.get('/conversations/:id', c => {
    const conv = conversationStore.getConversation(c.req.param('id'))
    if (!conv) return c.json({ error: 'Conversation not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', conv.project)) return c.json({ error: 'Forbidden' }, 403)
    return c.json(conversationToOverview(conv, conversationStore))
  })

  app.get('/conversations/:id/events', c => {
    const conversationId = c.req.param('id')
    const conv = conversationStore.getConversation(conversationId)
    if (!conv) return c.json({ error: 'Conversation not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', conv.project)) return c.json({ error: 'Forbidden' }, 403)
    const limit = parseInt(c.req.query('limit') || '0', 10)
    const since = parseInt(c.req.query('since') || '0', 10)
    const events = conversationStore.getConversationEvents(conversationId, limit || undefined, since || undefined)
    return c.json(events)
  })

  app.get('/conversations/:id/subagents', c => {
    const conv = conversationStore.getConversation(c.req.param('id'))
    if (!conv) return c.json({ error: 'Conversation not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', conv.project)) return c.json({ error: 'Forbidden' }, 403)
    return c.json(conv.subagents)
  })

  // Transcript fetch.
  //
  // Two modes:
  //   1. Full: no `sinceSeq` query param -- returns last `limit` entries.
  //   2. Delta: `?sinceSeq=N` -- returns only entries with seq > N. Used by
  //      the dashboard to catch up on missed entries after a sync_check
  //      flags the conversation as stale, without refetching the whole transcript.
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
    const conversationId = c.req.param('id')
    const conv = conversationStore.getConversation(conversationId)
    if (!conv) return c.json({ error: 'Conversation not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', conv.project)) return c.json({ error: 'Forbidden' }, 403)
    const limit = parseInt(c.req.query('limit') || '20', 10)
    const filter = c.req.query('filter')
    const sinceSeqRaw = c.req.query('sinceSeq')
    const sinceSeq = sinceSeqRaw !== undefined ? parseInt(sinceSeqRaw, 10) : undefined
    let allEntries = conversationStore.getTranscriptEntries(conversationId)
    let source = 'cache'

    // Always check SQLite -- the cache may only have boot entries while
    // the store has the full transcript (e.g., after broker restart).
    const stored = conversationStore.loadTranscriptFromStore(conversationId, Math.max(limit, 500))
    if (stored && stored.length > allEntries.length) {
      allEntries = stored
      source = 'store'
    }

    if (allEntries.length === 0) {
      console.log(
        `[${conversationId.slice(0, 8)}] GET transcript limit=${limit} filter=${filter || 'none'} -> 404 no-cache no-store`,
      )
      return c.json({ error: 'No transcript available' }, 404)
    }

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
      `[${conversationId.slice(0, 8)}] GET transcript ${mode} filter=${filter || 'none'} -> ${entries.length}/${cacheSize} entries lastSeq=${lastSeq} (${source})`,
    )
    return c.json({
      entries: entries.map(e => processImagesInEntry(e as Record<string, unknown>)),
      lastSeq,
      gap,
    })
  })

  app.get('/conversations/:id/subagents/:agentId/transcript', c => {
    const conversationId = c.req.param('id')
    const agentId = c.req.param('agentId')
    const conv = conversationStore.getConversation(conversationId)
    if (!conv) return c.json({ error: 'Conversation not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', conv.project)) return c.json({ error: 'Forbidden' }, 403)
    const limit = parseInt(c.req.query('limit') || '100', 10)
    if (!conversationStore.hasSubagentTranscriptCache(conversationId, agentId)) {
      return c.json({ error: 'No subagent transcript in cache' }, 404)
    }
    const entries = conversationStore.getSubagentTranscriptEntries(conversationId, agentId, limit)
    return c.json(entries.map(e => processImagesInEntry(e as Record<string, unknown>)))
  })

  app.get('/conversations/:id/diag', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const conversationId = c.req.param('id')
    const conv = conversationStore.getConversation(conversationId)
    if (!conv) return c.json({ error: 'Conversation not found' }, 404)
    return c.json({
      id: conversationId,
      project: conv.project,
      model: conv.model,
      status: conv.status,
      connectionIds: conversationStore.getConnectionIds(conversationId),
      capabilities: conv.capabilities,
      version: conv.version,
      buildTime: conv.buildTime,
      agentHostType: conv.agentHostType,
      agentHostMeta: conv.agentHostMeta,
      startedAt: conv.startedAt,
      lastActivity: conv.lastActivity,
      compacting: conv.compacting,
      compactedAt: conv.compactedAt,
      eventCount: conv.events.length,
      transcriptCacheEntries: conversationStore.getTranscriptEntries(conversationId).length,
      subagents: conv.subagents,
      tasks: conv.tasks,
      bgTasks: conv.bgTasks,
      teammates: conv.teammates,
      team: conv.team,
      args: conv.args,
      conversationInfo: conv.conversationInfo,
      diagLog: conv.diagLog,
    })
  })

  app.get('/conversations/:id/tasks', c => {
    const conv = conversationStore.getConversation(c.req.param('id'))
    if (!conv) return c.json({ error: 'Conversation not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', conv.project)) return c.json({ error: 'Forbidden' }, 403)
    return c.json({ tasks: conv.tasks, archivedTasks: conv.archivedTasks })
  })

  // Termination history for one conversation. Returns the in-memory
  // `endedBy` field (latest) plus any NDJSON log rows so the UI can show
  // both the current badge and the historical record (revives -> ends ->
  // revives produce multiple rows over the conversation's lifetime).
  app.get('/conversations/:id/termination', c => {
    const conv = conversationStore.getConversation(c.req.param('id'))
    if (!conv) return c.json({ error: 'Conversation not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', conv.project)) return c.json({ error: 'Forbidden' }, 403)
    const history = terminationLog
      ? terminationLog.query({ conversationId: conv.id, days: 30, limit: 50 })
      : []
    return c.json({
      current: conv.endedBy ?? null,
      history,
    })
  })

  // Admin-only NDJSON termination log query. Supports filtering by source,
  // initiator, day window, and free-text grep. Returns newest-first up to
  // `limit` (default 1000). Use broker-cli for shell-friendly access.
  app.get('/api/terminations', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden' }, 403)
    if (!terminationLog) return c.json({ error: 'Termination log not configured' }, 503)
    const days = Number.parseInt(c.req.query('days') ?? '7', 10) || 7
    const limit = Number.parseInt(c.req.query('limit') ?? '1000', 10) || 1000
    const sourceParam = c.req.query('source')
    const source = sourceParam
      ? (sourceParam.split(',') as import('../../shared/protocol').TerminationSource[])
      : undefined
    const initiator = c.req.query('initiator') || undefined
    const grep = c.req.query('grep') || undefined
    const results = terminationLog.query({ days, limit, source, initiator, grep })
    return c.json({ count: results.length, records: results })
  })

  app.post('/conversations/:id/input', async c => {
    const conversationId = c.req.param('id')
    const conv = conversationStore.getConversation(conversationId)
    if (!conv) return c.json({ error: 'Conversation not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat', conv.project)) return c.json({ error: 'Forbidden' }, 403)
    if (conv.status === 'ended') return c.json({ error: 'Conversation has ended' }, 400)

    const ws = conversationStore.getConversationSocket(conversationId)
    if (!ws) return c.json({ error: 'Conversation not connected' }, 400)

    const body = await c.req.json<{ input: string; crDelay?: number }>()
    if (!body.input || typeof body.input !== 'string') return c.json({ error: 'Missing input field' }, 400)

    const inputMsg: SendInput = {
      type: 'input',
      conversationId,
      input: body.input,
      ...(typeof body.crDelay === 'number' && body.crDelay > 0 && { crDelay: body.crDelay }),
    }
    ws.send(JSON.stringify(inputMsg))
    return c.json({ success: true })
  })

  app.post('/conversations/:id/revive', async c => {
    if (!httpHasPermission(c.req.raw, 'spawn', '*'))
      return c.json({ error: 'Forbidden: spawn permission required' }, 403)
    const targetId = c.req.param('id')
    const conv = conversationStore.getConversation(targetId)
    if (!conv) return c.json({ error: 'Conversation not found' }, 404)
    if (conv.status === 'active') return c.json({ error: 'Conversation is already active' }, 400)

    // If called with X-Caller-Conversation header, check benevolent trust
    const callerConversationId = c.req.header('X-Caller-Conversation')
    if (callerConversationId) {
      const callerConv = conversationStore.getConversation(callerConversationId)
      const callerTrust = callerConv?.project ? getProjectSettings(callerConv.project)?.trustLevel : undefined
      if (callerTrust !== 'benevolent') {
        return c.json({ error: 'Requires benevolent trust level' }, 403)
      }
    }

    const sentinel = conversationStore.getSentinel()
    if (!sentinel) return c.json({ error: 'No sentinel connected' }, 503)

    // Reuse the original conversation ID so transcript + sidebar entry persist
    conversationStore.resumeConversation(targetId)

    const lc = conv.launchConfig // stored launch config from original spawn
    const name =
      conv.title || getProjectSettings(conv.project)?.label || extractProjectLabel(conv.project) || targetId.slice(0, 8)
    // Resolve defaults: launch config > project > global > undefined
    const projSettings = getProjectSettings(conv.project)
    const globalSettings = getGlobalSettings()
    const conversationPath = parseProjectUri(conv.project).path
    const resolved = resolveSpawnConfig(
      {
        cwd: conversationPath,
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

    const { buildReviveMessage } = await import('../build-revive')
    sentinel.send(
      JSON.stringify(
        buildReviveMessage(conv, targetId, {
          headless,
          effort,
          model,
          bare: bare || undefined,
          repl: repl || undefined,
          permissionMode,
          autocompactPct,
          maxBudgetUsd,
        }),
      ),
    )

    // Register rendezvous for MCP callers
    if (callerConversationId) {
      conversationStore
        .addRendezvous(targetId, callerConversationId, conv.project, 'revive')
        .then(revived => {
          const callerWs = conversationStore.getConversationSocket(callerConversationId)
          if (callerWs) {
            callerWs.send(
              JSON.stringify({
                type: 'revive_ready',
                conversationId: revived.id,
                project: revived.project,
                conversation: revived,
              }),
            )
          }
        })
        .catch(err => {
          const callerWs = conversationStore.getConversationSocket(callerConversationId)
          if (callerWs) {
            callerWs.send(
              JSON.stringify({
                type: 'revive_timeout',
                conversationId: targetId,
                project: conv.project,
                error: typeof err === 'string' ? err : 'Revive rendezvous timed out',
              }),
            )
          }
        })
    }

    return c.json({ success: true, name, message: 'Revive command sent to sentinel', conversationId: targetId }, 202)
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
    if (!match) return c.json({ error: 'Conversation not found' }, 404)
    return c.json(conversationToOverview(match, conversationStore))
  })

  app.get('/api/share-resolve/:token', c => {
    const share = validateShare(c.req.param('token'))
    if (!share) return c.json({ error: 'Invalid or expired share' }, 404)
    const conversations = conversationStore.getAllConversations().filter(s => s.project === share.project)
    conversations.sort((a, b) => b.lastActivity - a.lastActivity)
    const best = conversations[0]
    return c.json({
      project: share.project,
      conversationId: best?.id || null,
    })
  })

  app.delete('/conversations/:id', c => {
    if (!httpHasPermission(c.req.raw, 'settings', '*')) return c.json({ error: 'Forbidden' }, 403)
    const conversationId = c.req.param('id')
    const conv = conversationStore.getConversation(conversationId)
    if (!conv) return c.json({ error: 'Conversation not found' }, 404)
    if (conv.status !== 'ended') return c.json({ error: 'Only ended conversations can be dismissed' }, 400)
    conversationStore.removeConversation(conversationId)
    broadcastToSubscribers(conversationStore, { type: 'conversation_dismissed', conversationId })
    return c.json({ success: true })
  })

  return app
}
