import { DuplicateEntry, SessionNotFound } from '../errors'
import type {
  AddressBookStore,
  AddressEntry,
  EnqueueMessage,
  EventInput,
  EventRecord,
  EventStore,
  KVStore,
  MessageLogEntry,
  MessageStore,
  QueuedMessage,
  ScopeLink,
  ScopeLinkStore,
  SearchHit,
  SessionCreate,
  SessionFilter,
  SessionPatch,
  SessionRecord,
  SessionStats,
  SessionStore,
  SessionSummaryRecord,
  ShareCreate,
  ShareRecord,
  ShareStore,
  StoreDriver,
  TaskRecord,
  TaskStore,
  TranscriptEntryRecord,
  TranscriptStore,
} from '../types'

let _nextId = 1
function nextId(): number {
  return _nextId++
}

function linkKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`
}

function toSummary(s: SessionRecord): SessionSummaryRecord {
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

function createSessionStore(): SessionStore {
  const sessions = new Map<string, SessionRecord>()

  return {
    get(id) {
      return sessions.get(id) ?? null
    },

    create(input: SessionCreate) {
      if (sessions.has(input.id)) {
        throw new DuplicateEntry(`Session already exists: ${input.id}`)
      }
      const rec: SessionRecord = {
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
      sessions.set(input.id, rec)
      return rec
    },

    update(id, patch: SessionPatch) {
      const s = sessions.get(id)
      if (!s) throw new SessionNotFound(id)
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) (s as unknown as Record<string, unknown>)[k] = v
      }
    },

    delete(id) {
      sessions.delete(id)
    },

    list(filter?: SessionFilter) {
      let results = [...sessions.values()]
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
      let results = [...sessions.values()].filter(s => s.scope === scope)
      const statuses = filter?.status
      if (statuses?.length) results = results.filter(s => statuses.includes(s.status))
      results.sort((a, b) => b.createdAt - a.createdAt)
      return results.map(toSummary)
    },

    updateStats(id, stats: Partial<SessionStats>) {
      const s = sessions.get(id)
      if (!s) throw new SessionNotFound(id)
      s.stats = { ...s.stats, ...stats }
    },
  }
}

function createTranscriptStore(): TranscriptStore {
  const entries = new Map<string, TranscriptEntryRecord[]>()
  const seqCounters = new Map<string, number>()

  function getEntries(sessionId: string): TranscriptEntryRecord[] {
    let arr = entries.get(sessionId)
    if (!arr) {
      arr = []
      entries.set(sessionId, arr)
    }
    return arr
  }

  function nextSeq(sessionId: string): number {
    const cur = seqCounters.get(sessionId) ?? 0
    const next = cur + 1
    seqCounters.set(sessionId, next)
    return next
  }

  return {
    append(sessionId, syncEpoch, inputEntries) {
      const arr = getEntries(sessionId)
      for (const e of inputEntries) {
        if (arr.some(x => x.uuid === e.uuid)) continue
        arr.push({
          id: nextId(),
          sessionId,
          sessionSeq: nextSeq(sessionId),
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

    getPage(sessionId, opts) {
      let arr = getEntries(sessionId)
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

    getLatest(sessionId, limit, agentId) {
      let arr = getEntries(sessionId)
      if (agentId !== undefined) {
        arr = arr.filter(e => (agentId === null ? !e.agentId : e.agentId === agentId))
      }
      return arr.slice(-limit)
    },

    getSinceSeq(sessionId, sinceSeq, limit) {
      const arr = getEntries(sessionId)
      const maxSeq = seqCounters.get(sessionId) ?? 0
      const gap = sinceSeq > 0 && !arr.some(e => e.sessionSeq === sinceSeq)
      const filtered = arr.filter(e => e.sessionSeq > sinceSeq)
      const sliced = limit ? filtered.slice(0, limit) : filtered
      return {
        entries: sliced,
        lastSeq: sliced.length > 0 ? sliced[sliced.length - 1].sessionSeq : maxSeq,
        gap,
      }
    },

    getLastSeq(sessionId) {
      return seqCounters.get(sessionId) ?? 0
    },

    find(sessionId, filter) {
      let arr = getEntries(sessionId)
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
      const q = query.toLowerCase()
      const hits: SearchHit[] = []
      for (const [sessionId, arr] of entries) {
        if (opts?.scope) {
          continue // no scope info in transcript entries; caller should pre-filter
        }
        for (const e of arr) {
          const text = JSON.stringify(e.content).toLowerCase()
          const idx = text.indexOf(q)
          if (idx !== -1) {
            const start = Math.max(0, idx - 40)
            const end = Math.min(text.length, idx + q.length + 40)
            hits.push({
              sessionId,
              entryId: e.id,
              snippet: text.slice(start, end),
              score: 1,
              createdAt: e.timestamp,
            })
          }
        }
      }
      hits.sort((a, b) => b.createdAt - a.createdAt)
      return hits.slice(0, opts?.limit ?? 50)
    },

    count(sessionId, agentId) {
      let arr = getEntries(sessionId)
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
  }
}

function createEventStore(): EventStore {
  const events = new Map<string, EventRecord[]>()

  return {
    append(sessionId, event: EventInput) {
      let arr = events.get(sessionId)
      if (!arr) {
        arr = []
        events.set(sessionId, arr)
      }
      arr.push({
        id: nextId(),
        sessionId,
        type: event.type,
        data: event.data,
        createdAt: Date.now(),
      })
    },

    getForSession(sessionId, opts) {
      let arr = events.get(sessionId) ?? []
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
        fromSessionId: msg.fromSessionId,
        content: msg.content,
        intent: msg.intent,
        conversationId: msg.conversationId,
        createdAt: Date.now(),
        expiresAt: msg.expiresAt,
      })
    },

    dequeueFor(scope) {
      const now = Date.now()
      const matching: QueuedMessage[] = []
      const remaining: (typeof queue)[number][] = []
      for (const m of queue) {
        if (m.toScope === scope && m.expiresAt > now) {
          matching.push({
            id: m.id,
            fromScope: m.fromScope,
            toScope: m.toScope,
            fromSessionId: m.fromSessionId,
            content: m.content,
            intent: m.intent,
            conversationId: m.conversationId,
            createdAt: m.createdAt,
          })
        } else if (m.toScope !== scope) {
          remaining.push(m)
        }
      }
      queue.length = 0
      queue.push(...remaining)
      return matching
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
      results.sort((a, b) => b.createdAt - a.createdAt)
      if (opts?.limit) results = results.slice(0, opts.limit)
      return results
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
        sessionId: input.sessionId,
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

    getForSession(sessionId) {
      return [...shares.values()].filter(s => s.sessionId === sessionId)
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

  function getSession(sessionId: string): Map<string, TaskRecord> {
    let m = tasks.get(sessionId)
    if (!m) {
      m = new Map()
      tasks.set(sessionId, m)
    }
    return m
  }

  return {
    upsert(sessionId, task) {
      getSession(sessionId).set(task.id, { ...task, sessionId })
    },

    getForSession(sessionId, kind?) {
      const m = tasks.get(sessionId)
      if (!m) return []
      let results = [...m.values()]
      if (kind) results = results.filter(t => t.kind === kind)
      return results
    },

    delete(sessionId, taskId) {
      return tasks.get(sessionId)?.delete(taskId) ?? false
    },

    deleteForSession(sessionId) {
      const m = tasks.get(sessionId)
      if (!m) return 0
      const count = m.size
      tasks.delete(sessionId)
      return count
    },
  }
}

export function createMemoryDriver(): StoreDriver {
  return {
    sessions: createSessionStore(),
    transcripts: createTranscriptStore(),
    events: createEventStore(),
    kv: createKVStore(),
    messages: createMessageStore(),
    shares: createShareStore(),
    addressBook: createAddressBookStore(),
    scopeLinks: createScopeLinkStore(),
    tasks: createTaskStore(),
    init() {},
    close() {},
    compact() {},
  }
}
