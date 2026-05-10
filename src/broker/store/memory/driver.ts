import { normalizeProjectUri } from '../../../shared/project-uri'
import { ConversationNotFound, DuplicateEntry } from '../errors'
import type {
  AddressBookStore,
  AddressEntry,
  ConversationCreate,
  ConversationFilter,
  ConversationPatch,
  ConversationRecord,
  ConversationStats,
  ConversationStore,
  ConversationSummaryRecord,
  CostPeriod,
  CostStore,
  CostSummary,
  CumulativeTurnInput,
  EnqueueMessage,
  EventInput,
  EventRecord,
  EventStore,
  HourlyFilter,
  HourlyRow,
  KVStore,
  MessageLogEntry,
  MessageStore,
  QueuedMessage,
  ScopeLink,
  ScopeLinkStore,
  SearchHit,
  ShareCreate,
  ShareRecord,
  ShareStore,
  StoreDriver,
  TaskQuery,
  TaskRecord,
  TaskStore,
  TranscriptEntryRecord,
  TranscriptStore,
  TurnFilter,
  TurnRecord,
} from '../types'

function normalizeUri(uri: string): string {
  if (!uri) return uri
  try {
    return normalizeProjectUri(uri)
  } catch {
    return uri
  }
}

let _nextId = 1
function nextId(): number {
  return _nextId++
}

function linkKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`
}

function toSummary(s: ConversationRecord): ConversationSummaryRecord {
  return {
    id: s.id,
    scope: s.scope,
    agentType: s.agentType,
    status: s.status,
    model: s.model,
    title: s.title,
    label: s.label,
    icon: s.icon,
    color: s.color,
    createdAt: s.createdAt,
    endedAt: s.endedAt,
    lastActivity: s.lastActivity,
  }
}

function createConversationStore(): ConversationStore {
  const conversations = new Map<string, ConversationRecord>()

  return {
    get(id) {
      return conversations.get(id) ?? null
    },

    create(input: ConversationCreate) {
      if (conversations.has(input.id)) {
        throw new DuplicateEntry(`Session already exists: ${input.id}`)
      }
      const rec: ConversationRecord = {
        id: input.id,
        scope: input.scope,
        agentType: input.agentType,
        agentVersion: input.agentVersion,
        title: input.title,
        model: input.model,
        status: 'active',
        createdAt: input.createdAt ?? Date.now(),
        meta: input.meta,
      }
      conversations.set(input.id, rec)
      return rec
    },

    update(id, patch: ConversationPatch) {
      const s = conversations.get(id)
      if (!s) throw new ConversationNotFound(id)
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) (s as unknown as Record<string, unknown>)[k] = v
      }
    },

    delete(id) {
      conversations.delete(id)
    },

    list(filter?: ConversationFilter) {
      let results = [...conversations.values()]
      if (filter?.scope) results = results.filter(s => s.scope === filter.scope)
      const statuses = filter?.status
      if (statuses?.length) results = results.filter(s => statuses.includes(s.status))
      if (filter?.agentType) results = results.filter(s => s.agentType === filter.agentType)
      results.sort((a, b) => b.createdAt - a.createdAt)
      const offset = filter?.offset ?? 0
      const limit = filter?.limit ?? results.length
      return results.slice(offset, offset + limit).map(toSummary)
    },

    listByScope(scope, filter) {
      let results = [...conversations.values()].filter(s => s.scope === scope)
      const statuses = filter?.status
      if (statuses?.length) results = results.filter(s => statuses.includes(s.status))
      results.sort((a, b) => b.createdAt - a.createdAt)
      return results.map(toSummary)
    },

    updateStats(id, stats: Partial<ConversationStats>) {
      const s = conversations.get(id)
      if (!s) throw new ConversationNotFound(id)
      s.stats = { ...s.stats, ...stats }
    },
  }
}

function createTranscriptStore(): TranscriptStore {
  const entries = new Map<string, TranscriptEntryRecord[]>()
  const seqCounters = new Map<string, number>()

  function getEntries(conversationId: string): TranscriptEntryRecord[] {
    let arr = entries.get(conversationId)
    if (!arr) {
      arr = []
      entries.set(conversationId, arr)
    }
    return arr
  }

  function nextSeq(conversationId: string): number {
    const cur = seqCounters.get(conversationId) ?? 0
    const next = cur + 1
    seqCounters.set(conversationId, next)
    return next
  }

  return {
    append(conversationId, syncEpoch, inputEntries) {
      const arr = getEntries(conversationId)
      for (const e of inputEntries) {
        if (arr.some(x => x.uuid === e.uuid)) continue
        arr.push({
          id: nextId(),
          conversationId,
          seq: nextSeq(conversationId),
          syncEpoch,
          type: e.type,
          subtype: e.subtype,
          agentId: e.agentId,
          uuid: e.uuid,
          content: e.content,
          timestamp: e.timestamp,
          ingestedAt: Date.now(),
        })
      }
    },

    getPage(conversationId, opts) {
      let arr = getEntries(conversationId)
      if (opts.agentId !== undefined) {
        arr = arr.filter(e => (opts.agentId === null ? !e.agentId : e.agentId === opts.agentId))
      }
      const totalCount = arr.length
      const limit = opts.limit ?? 50
      const direction = opts.direction ?? 'forward'

      let startIdx: number
      if (opts.cursor != null) {
        const cursorIdx = arr.findIndex(e => e.id === opts.cursor)
        startIdx = cursorIdx === -1 ? 0 : direction === 'forward' ? cursorIdx + 1 : Math.max(0, cursorIdx - limit)
      } else {
        startIdx = direction === 'forward' ? 0 : Math.max(0, arr.length - limit)
      }

      const page = arr.slice(startIdx, startIdx + limit)
      const lastIdx = startIdx + page.length

      return {
        entries: page,
        nextCursor: lastIdx < arr.length ? arr[lastIdx].id : null,
        prevCursor: startIdx > 0 ? arr[startIdx - 1].id : null,
        totalCount,
      }
    },

    getLatest(conversationId, limit, agentId) {
      let arr = getEntries(conversationId)
      if (agentId !== undefined) {
        arr = arr.filter(e => (agentId === null ? !e.agentId : e.agentId === agentId))
      }
      return arr.slice(-limit)
    },

    getSinceSeq(conversationId, sinceSeq, limit) {
      const arr = getEntries(conversationId)
      const maxSeq = seqCounters.get(conversationId) ?? 0
      const gap = sinceSeq > 0 && !arr.some(e => e.seq === sinceSeq)
      const filtered = arr.filter(e => e.seq > sinceSeq)
      const sliced = limit ? filtered.slice(0, limit) : filtered
      return {
        entries: sliced,
        lastSeq: sliced.length > 0 ? sliced[sliced.length - 1].seq : maxSeq,
        gap,
      }
    },

    getLastSeq(conversationId) {
      return seqCounters.get(conversationId) ?? 0
    },

    find(conversationId, filter) {
      let arr = getEntries(conversationId)
      const { types, subtypes, after, before } = filter
      if (types?.length) arr = arr.filter(e => types.includes(e.type))
      if (subtypes?.length) arr = arr.filter(e => e.subtype != null && subtypes.includes(e.subtype))
      if (filter.agentId !== undefined) {
        arr = arr.filter(e => (filter.agentId === null ? !e.agentId : e.agentId === filter.agentId))
      }
      if (after != null) arr = arr.filter(e => e.timestamp > after)
      if (before != null) arr = arr.filter(e => e.timestamp < before)
      if (filter.limit) arr = arr.slice(0, filter.limit)
      return arr
    },

    search(query, opts) {
      const q = query.trim().toLowerCase()
      if (!q) return []
      const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100)
      const offset = Math.max(opts?.offset ?? 0, 0)
      const hits: SearchHit[] = []

      const idSet = opts?.conversationIds ? new Set(opts.conversationIds) : null
      const typeSet = opts?.types?.length ? new Set(opts.types) : null
      const sources: Array<[string, TranscriptEntryRecord[]]> = opts?.conversationId
        ? [[opts.conversationId, entries.get(opts.conversationId) ?? []]]
        : [...entries.entries()].filter(([cid]) => !idSet || idSet.has(cid))

      for (const [conversationId, arr] of sources) {
        for (const e of arr) {
          if (typeSet && !typeSet.has(e.type)) continue
          const text = JSON.stringify(e.content)
          const idx = text.toLowerCase().indexOf(q)
          if (idx === -1) continue
          const start = Math.max(0, idx - 32)
          const end = Math.min(text.length, idx + q.length + 32)
          const before = start > 0 ? '...' : ''
          const after = end < text.length ? '...' : ''
          hits.push({
            id: e.id,
            conversationId,
            seq: e.seq,
            type: e.type,
            subtype: e.subtype,
            content: e.content,
            timestamp: e.timestamp,
            rank: -1 / (text.length + 1), // shorter matches rank higher (less-negative bm25 surrogate)
            snippet: `${before}${text.slice(start, end)}${after}`,
          })
        }
      }
      hits.sort((a, b) => a.rank - b.rank)
      return hits.slice(offset, offset + limit)
    },

    getWindow(conversationId, opts) {
      const arr = entries.get(conversationId) ?? []
      const before = Math.min(Math.max(opts.before ?? 5, 0), 50)
      const after = Math.min(Math.max(opts.after ?? 5, 0), 50)

      let centerSeq: number | null = null
      if (opts.aroundSeq != null) centerSeq = opts.aroundSeq
      else if (opts.aroundId != null) {
        const found = arr.find(e => e.id === opts.aroundId)
        if (!found) return []
        centerSeq = found.seq
      }
      if (centerSeq == null) return []

      const minSeq = centerSeq - before
      const maxSeq = centerSeq + after
      return arr.filter(e => e.seq >= minSeq && e.seq <= maxSeq).sort((a, b) => a.seq - b.seq)
    },

    count(conversationId, agentId) {
      let arr = getEntries(conversationId)
      if (agentId !== undefined) {
        arr = arr.filter(e => (agentId === null ? !e.agentId : e.agentId === agentId))
      }
      return arr.length
    },

    pruneOlderThan(cutoffMs) {
      let pruned = 0
      for (const [sid, arr] of entries) {
        const before = arr.length
        const kept = arr.filter(e => e.timestamp >= cutoffMs)
        entries.set(sid, kept)
        pruned += before - kept.length
      }
      return pruned
    },

    getIndexStats() {
      let totalEntries = 0
      for (const arr of entries.values()) totalEntries += arr.length
      return {
        totalEntries,
        indexedDocs: totalEntries, // memory driver: source IS the index
        conversations: entries.size,
        isComplete: true,
      }
    },

    rebuildIndex() {
      // No-op for memory driver -- substring search reads the source directly,
      // there's no separate index to rebuild.
      let totalEntries = 0
      for (const arr of entries.values()) totalEntries += arr.length
      return { docsIndexed: totalEntries, durationMs: 0 }
    },
  }
}

function createEventStore(): EventStore {
  const events = new Map<string, EventRecord[]>()

  return {
    append(conversationId, event: EventInput) {
      let arr = events.get(conversationId)
      if (!arr) {
        arr = []
        events.set(conversationId, arr)
      }
      arr.push({
        id: nextId(),
        conversationId,
        type: event.type,
        data: event.data,
        createdAt: Date.now(),
      })
    },

    getForConversation(conversationId, opts) {
      let arr = events.get(conversationId) ?? []
      const types = opts?.types
      if (types?.length) arr = arr.filter(e => types.includes(e.type))
      const afterId = opts?.afterId
      if (afterId != null) arr = arr.filter(e => e.id > afterId)
      if (opts?.limit) arr = arr.slice(-opts.limit)
      return arr
    },

    pruneOlderThan(cutoffMs) {
      let pruned = 0
      for (const [sid, arr] of events) {
        const before = arr.length
        events.set(
          sid,
          arr.filter(e => e.createdAt >= cutoffMs),
        )
        pruned += before - (events.get(sid)?.length ?? 0)
      }
      return pruned
    },
  }
}

function createKVStore(): KVStore {
  const store = new Map<string, unknown>()

  return {
    get<T = unknown>(key: string): T | null {
      return (store.get(key) as T) ?? null
    },
    set<T = unknown>(key: string, value: T) {
      store.set(key, value)
    },
    delete(key) {
      return store.delete(key)
    },
    keys(prefix?) {
      const all = [...store.keys()]
      return prefix ? all.filter(k => k.startsWith(prefix)) : all
    },
  }
}

function createMessageStore(): MessageStore {
  const queue: (QueuedMessage & { expiresAt: number })[] = []
  const log: (MessageLogEntry & { id: number })[] = []

  return {
    enqueue(msg: EnqueueMessage) {
      queue.push({
        id: nextId(),
        fromScope: msg.fromScope,
        toScope: msg.toScope,
        fromConversationId: msg.fromConversationId,
        fromName: msg.fromName,
        targetName: msg.targetName,
        content: msg.content,
        intent: msg.intent,
        conversationId: msg.conversationId,
        createdAt: Date.now(),
        expiresAt: msg.expiresAt,
      })
    },

    dequeueFor(scope, targetName?) {
      const now = Date.now()
      const matching: QueuedMessage[] = []
      const remaining: (typeof queue)[number][] = []
      for (const m of queue) {
        if (m.toScope !== scope || m.expiresAt <= now) {
          if (m.expiresAt > now) remaining.push(m)
          continue
        }
        if (targetName && m.targetName && m.targetName !== targetName) {
          remaining.push(m)
          continue
        }
        matching.push({
          id: m.id,
          fromScope: m.fromScope,
          toScope: m.toScope,
          fromConversationId: m.fromConversationId,
          fromName: m.fromName,
          targetName: m.targetName,
          content: m.content,
          intent: m.intent,
          conversationId: m.conversationId,
          createdAt: m.createdAt,
        })
      }
      queue.length = 0
      queue.push(...remaining)
      return matching
    },

    countFor(scope) {
      const now = Date.now()
      return queue.filter(m => m.toScope === scope && m.expiresAt > now).length
    },

    log(entry) {
      log.push({ ...entry, id: entry.id ?? nextId() })
    },

    queryLog(opts) {
      let results = [...log]
      if (opts?.scope) results = results.filter(e => e.fromScope === opts.scope || e.toScope === opts.scope)
      if (opts?.conversationId) results = results.filter(e => e.conversationId === opts.conversationId)
      const afterId = opts?.afterId
      if (afterId != null) results = results.filter(e => (e.id ?? 0) > afterId)
      if (opts?.before != null) results = results.filter(e => e.createdAt < (opts.before as number))
      results.sort((a, b) => b.createdAt - a.createdAt)
      if (opts?.limit) results = results.slice(0, opts.limit)
      return results
    },

    purgeLog(scopeA, scopeB) {
      const before = log.length
      const kept = log.filter(
        e => !((e.fromScope === scopeA && e.toScope === scopeB) || (e.fromScope === scopeB && e.toScope === scopeA)),
      )
      log.length = 0
      log.push(...kept)
      return before - kept.length
    },

    compactLog(retentionMs, maxEntries) {
      const cutoff = Date.now() - retentionMs
      const before = log.length
      const kept = log.filter(e => e.createdAt >= cutoff)
      log.length = 0
      log.push(...kept)
      let removed = before - kept.length
      if (log.length > maxEntries) {
        log.sort((a, b) => b.createdAt - a.createdAt)
        const excess = log.splice(maxEntries)
        removed += excess.length
      }
      return removed
    },

    pruneExpired() {
      const now = Date.now()
      const before = queue.length
      const kept = queue.filter(m => m.expiresAt > now)
      queue.length = 0
      queue.push(...kept)
      return before - kept.length
    },
  }
}

function createShareStore(): ShareStore {
  const shares = new Map<string, ShareRecord>()

  return {
    create(input: ShareCreate) {
      if (shares.has(input.token)) {
        throw new DuplicateEntry(`Share already exists: ${input.token}`)
      }
      const rec: ShareRecord = {
        token: input.token,
        conversationId: input.conversationId,
        permissions: input.permissions,
        createdAt: Date.now(),
        expiresAt: input.expiresAt,
        viewerCount: 0,
      }
      shares.set(input.token, rec)
      return rec
    },

    get(token) {
      return shares.get(token) ?? null
    },

    getForConversation(conversationId) {
      return [...shares.values()].filter(s => s.conversationId === conversationId)
    },

    incrementViewerCount(token) {
      const s = shares.get(token)
      if (s) s.viewerCount++
    },

    delete(token) {
      return shares.delete(token)
    },

    deleteExpired() {
      const now = Date.now()
      let count = 0
      for (const [token, s] of shares) {
        if (s.expiresAt <= now) {
          shares.delete(token)
          count++
        }
      }
      return count
    },
  }
}

function createAddressBookStore(): AddressBookStore {
  const entries = new Map<string, AddressEntry>()

  function entryKey(owner: string, slug: string): string {
    return `${owner}\0${slug}`
  }

  return {
    resolve(ownerScope, slug) {
      const e = entries.get(entryKey(ownerScope, slug))
      if (e) {
        e.lastUsed = Date.now()
        return e.targetScope
      }
      return null
    },

    set(ownerScope, slug, targetScope) {
      const key = entryKey(ownerScope, slug)
      const existing = entries.get(key)
      entries.set(key, {
        ownerScope,
        slug,
        targetScope,
        createdAt: existing?.createdAt ?? Date.now(),
        lastUsed: existing?.lastUsed,
      })
    },

    delete(ownerScope, slug) {
      return entries.delete(entryKey(ownerScope, slug))
    },

    listForScope(ownerScope) {
      return [...entries.values()].filter(e => e.ownerScope === ownerScope)
    },

    findByTarget(targetScope) {
      return [...entries.values()].filter(e => e.targetScope === targetScope)
    },
  }
}

function createScopeLinkStore(): ScopeLinkStore {
  const links = new Map<string, ScopeLink>()

  return {
    link(scopeA, scopeB) {
      const key = linkKey(scopeA, scopeB)
      if (!links.has(key)) {
        links.set(key, { scopeA, scopeB, status: 'active', createdAt: Date.now() })
      }
    },

    unlink(scopeA, scopeB) {
      links.delete(linkKey(scopeA, scopeB))
    },

    getStatus(scopeA, scopeB) {
      return links.get(linkKey(scopeA, scopeB))?.status ?? null
    },

    setStatus(scopeA, scopeB, status) {
      const link = links.get(linkKey(scopeA, scopeB))
      if (link) link.status = status
    },

    listLinksFor(scope) {
      return [...links.values()].filter(l => l.scopeA === scope || l.scopeB === scope)
    },
  }
}

function createTaskStore(): TaskStore {
  const tasks = new Map<string, Map<string, TaskRecord>>()

  function getConversation(conversationId: string): Map<string, TaskRecord> {
    let m = tasks.get(conversationId)
    if (!m) {
      m = new Map()
      tasks.set(conversationId, m)
    }
    return m
  }

  return {
    upsert(conversationId, task) {
      getConversation(conversationId).set(task.id, { ...task, conversationId })
    },

    getForConversation(conversationId, query?: TaskQuery) {
      const m = tasks.get(conversationId)
      if (!m) return []
      let results = [...m.values()]
      if (query?.kind) results = results.filter(t => t.kind === query.kind)
      if (query?.archived === true) results = results.filter(t => t.archivedAt != null)
      else if (query?.archived === false) results = results.filter(t => t.archivedAt == null)
      if (query?.archivedSince != null) {
        const since = query.archivedSince
        results = results.filter(t => t.archivedAt != null && t.archivedAt >= since)
      }
      results.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0) || a.createdAt - b.createdAt)
      if (query?.limit) results = results.slice(0, Math.max(1, Math.floor(query.limit)))
      return results
    },

    delete(conversationId, taskId) {
      return tasks.get(conversationId)?.delete(taskId) ?? false
    },

    deleteForConversation(conversationId) {
      const m = tasks.get(conversationId)
      if (!m) return 0
      const count = m.size
      tasks.delete(conversationId)
      return count
    },

    pruneArchivedBefore(cutoffMs) {
      let removed = 0
      for (const m of tasks.values()) {
        for (const [id, task] of m) {
          if (task.archivedAt != null && task.archivedAt < cutoffMs) {
            m.delete(id)
            removed++
          }
        }
      }
      return removed
    },
  }
}

function hourKey(ms: number): string {
  const d = new Date(ms)
  d.setMinutes(0, 0, 0)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function periodToMs(period: CostPeriod): number {
  switch (period) {
    case '24h':
      return 24 * 60 * 60 * 1000
    case '7d':
      return 7 * 24 * 60 * 60 * 1000
    case '30d':
      return 30 * 24 * 60 * 60 * 1000
  }
}

interface MemorySnapshot {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
}

function createCostStore(): CostStore {
  const turns: TurnRecord[] = []
  const lastSnapshot = new Map<string, MemorySnapshot>()

  function filterTurns(f: Pick<TurnFilter, 'from' | 'to' | 'account' | 'model' | 'projectUri'>): TurnRecord[] {
    return turns.filter(t => {
      if (f.from && t.timestamp < f.from) return false
      if (f.to && t.timestamp > f.to) return false
      if (f.account && t.account !== f.account) return false
      if (f.model && !t.model.includes(f.model)) return false
      if (f.projectUri && t.projectUri !== f.projectUri) return false
      return true
    })
  }

  return {
    recordTurn(record) {
      turns.push({ ...record, projectUri: normalizeUri(record.projectUri) })
    },

    recordTurnFromCumulatives(params: CumulativeTurnInput) {
      const prev = lastSnapshot.get(params.conversationId) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0,
      }

      const dIn = params.totalInputTokens - prev.inputTokens
      const dOut = params.totalOutputTokens - prev.outputTokens
      const dCR = params.totalCacheRead - prev.cacheRead
      const dCW = params.totalCacheWrite - prev.cacheWrite
      const dCost = params.totalCostUsd - prev.costUsd

      if (dIn <= 0 && dOut <= 0) return false

      turns.push({
        timestamp: params.timestamp,
        conversationId: params.conversationId,
        projectUri: normalizeUri(params.projectUri),
        account: params.account,
        orgId: params.orgId,
        model: params.model,
        inputTokens: dIn,
        outputTokens: dOut,
        cacheReadTokens: dCR,
        cacheWriteTokens: dCW,
        costUsd: Math.max(0, dCost),
        exactCost: params.exactCost,
      })

      lastSnapshot.set(params.conversationId, {
        inputTokens: params.totalInputTokens,
        outputTokens: params.totalOutputTokens,
        cacheRead: params.totalCacheRead,
        cacheWrite: params.totalCacheWrite,
        costUsd: params.totalCostUsd,
      })
      return true
    },

    queryTurns(filter) {
      const matched = filterTurns(filter).sort((a, b) => b.timestamp - a.timestamp)
      const limit = Math.min(filter.limit ?? 100, 1000)
      const offset = filter.offset ?? 0
      return {
        total: matched.length,
        rows: matched.slice(offset, offset + limit).map(t => ({ ...t })),
      }
    },

    queryHourly(filter: HourlyFilter): HourlyRow[] {
      const currentHour = hourKey(Date.now())
      const relevant = filterTurns(filter).filter(t => hourKey(t.timestamp) !== currentHour)

      const buckets = new Map<string, HourlyRow>()
      for (const t of relevant) {
        const hour = hourKey(t.timestamp)
        const key = `${hour}\0${t.account}\0${t.model}\0${t.projectUri}`
        const existing = buckets.get(key)
        if (existing) {
          existing.turnCount++
          existing.inputTokens += t.inputTokens
          existing.outputTokens += t.outputTokens
          existing.cacheReadTokens += t.cacheReadTokens
          existing.cacheWriteTokens += t.cacheWriteTokens
          existing.costUsd += t.costUsd
        } else {
          buckets.set(key, {
            hour,
            account: t.account,
            model: t.model,
            projectUri: t.projectUri,
            turnCount: 1,
            inputTokens: t.inputTokens,
            outputTokens: t.outputTokens,
            cacheReadTokens: t.cacheReadTokens,
            cacheWriteTokens: t.cacheWriteTokens,
            costUsd: t.costUsd,
          })
        }
      }

      const hourly = [...buckets.values()]

      if (filter.groupBy === 'day') {
        const dayBuckets = new Map<string, HourlyRow>()
        for (const h of hourly) {
          const day = h.hour.slice(0, 10)
          const key = `${day}\0${h.account}\0${h.model}`
          const existing = dayBuckets.get(key)
          if (existing) {
            existing.turnCount += h.turnCount
            existing.inputTokens += h.inputTokens
            existing.outputTokens += h.outputTokens
            existing.cacheReadTokens += h.cacheReadTokens
            existing.cacheWriteTokens += h.cacheWriteTokens
            existing.costUsd += h.costUsd
          } else {
            dayBuckets.set(key, { ...h, hour: day })
          }
        }
        return [...dayBuckets.values()].sort((a, b) => a.hour.localeCompare(b.hour))
      }

      return hourly.sort((a, b) => a.hour.localeCompare(b.hour))
    },

    querySummary(period) {
      const cutoff = Date.now() - periodToMs(period)
      const recent = turns.filter(t => t.timestamp >= cutoff)

      const projectAgg = new Map<string, { costUsd: number; turns: number }>()
      const modelAgg = new Map<string, { costUsd: number; turns: number }>()
      let totalCost = 0
      let totalInput = 0
      let totalOutput = 0
      let totalCacheRead = 0
      let totalCacheWrite = 0

      for (const t of recent) {
        totalCost += t.costUsd
        totalInput += t.inputTokens
        totalOutput += t.outputTokens
        totalCacheRead += t.cacheReadTokens
        totalCacheWrite += t.cacheWriteTokens

        const p = projectAgg.get(t.projectUri) ?? { costUsd: 0, turns: 0 }
        p.costUsd += t.costUsd
        p.turns++
        projectAgg.set(t.projectUri, p)

        const m = modelAgg.get(t.model) ?? { costUsd: 0, turns: 0 }
        m.costUsd += t.costUsd
        m.turns++
        modelAgg.set(t.model, m)
      }

      const topProjects = [...projectAgg.entries()]
        .map(([projectUri, v]) => ({ projectUri, costUsd: v.costUsd, turns: v.turns }))
        .sort((a, b) => b.costUsd - a.costUsd)
        .slice(0, 10)

      const topModels = [...modelAgg.entries()]
        .map(([model, v]) => ({ model, costUsd: v.costUsd, turns: v.turns }))
        .sort((a, b) => b.costUsd - a.costUsd)
        .slice(0, 10)

      return {
        period,
        totalCostUsd: totalCost,
        totalTurns: recent.length,
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        totalCacheReadTokens: totalCacheRead,
        totalCacheWriteTokens: totalCacheWrite,
        topProjects,
        topModels,
      } satisfies CostSummary
    },

    pruneOlderThan(cutoffMs) {
      const before = turns.length
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].timestamp < cutoffMs) turns.splice(i, 1)
      }
      return { turns: before - turns.length, hourly: 0 }
    },
  }
}

export function createMemoryDriver(): StoreDriver {
  return {
    conversations: createConversationStore(),
    transcripts: createTranscriptStore(),
    events: createEventStore(),
    kv: createKVStore(),
    messages: createMessageStore(),
    shares: createShareStore(),
    addressBook: createAddressBookStore(),
    scopeLinks: createScopeLinkStore(),
    tasks: createTaskStore(),
    costs: createCostStore(),
    init() {},
    close() {},
    compact() {},
  }
}
