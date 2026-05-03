import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryDriver } from '../memory/driver'
import { createSqliteDriver } from '../sqlite/driver'
import type { StoreDriver, TranscriptEntryInput } from '../types'

function makeTranscriptEntry(
  type: string,
  uuid?: string,
  overrides: Partial<TranscriptEntryInput> = {},
): TranscriptEntryInput {
  return {
    type,
    uuid: uuid ?? crypto.randomUUID(),
    content: { text: `entry-${type}` },
    timestamp: Date.now(),
    ...overrides,
  }
}

function runStoreTests(name: string, createDriver: () => StoreDriver) {
  describe(`StoreDriver: ${name}`, () => {
    let store: StoreDriver

    beforeEach(() => {
      store = createDriver()
      store.init()
    })

    // -----------------------------------------------------------------
    // SessionStore
    // -----------------------------------------------------------------

    describe('sessions', () => {
      it('create + get returns the conversation', () => {
        store.sessions.create({
          id: 'sess-1',
          scope: 'project-a',
          agentType: 'claude',
        })
        const session = store.sessions.get('sess-1')
        expect(session).not.toBeNull()
        expect(session!.id).toBe('sess-1')
        expect(session!.scope).toBe('project-a')
        expect(session!.agentType).toBe('claude')
        expect(session!.status).toBe('active')
      })

      it('update patches only specified fields', () => {
        store.sessions.create({
          id: 'sess-patch',
          scope: 'scope-1',
          agentType: 'claude',
        })
        store.sessions.update('sess-patch', { title: 'Updated Title' })
        const session = store.sessions.get('sess-patch')!
        expect(session.title).toBe('Updated Title')
        expect(session.scope).toBe('scope-1')
        expect(session.agentType).toBe('claude')
      })

      it('delete removes the conversation', () => {
        store.sessions.create({ id: 'sess-del', scope: 's', agentType: 'claude' })
        store.sessions.delete('sess-del')
        expect(store.sessions.get('sess-del')).toBeNull()
      })

      it('get returns null for missing ID', () => {
        expect(store.sessions.get('nonexistent')).toBeNull()
      })

      it('list with status filter', () => {
        store.sessions.create({ id: 's1', scope: 'p', agentType: 'claude' })
        store.sessions.create({ id: 's2', scope: 'p', agentType: 'claude' })
        store.sessions.update('s2', { status: 'ended' })

        const active = store.sessions.list({ status: ['active'] })
        expect(active.map(s => s.id)).toContain('s1')
        expect(active.map(s => s.id)).not.toContain('s2')

        const ended = store.sessions.list({ status: ['ended'] })
        expect(ended.map(s => s.id)).toContain('s2')
        expect(ended.map(s => s.id)).not.toContain('s1')
      })

      it('listByScope returns only conversations for given scope', () => {
        store.sessions.create({ id: 'sa', scope: 'alpha', agentType: 'claude' })
        store.sessions.create({ id: 'sb', scope: 'beta', agentType: 'claude' })
        store.sessions.create({ id: 'sc', scope: 'alpha', agentType: 'claude' })

        const alpha = store.sessions.listByScope('alpha')
        expect(alpha.map(s => s.id)).toContain('sa')
        expect(alpha.map(s => s.id)).toContain('sc')
        expect(alpha.map(s => s.id)).not.toContain('sb')
      })

      it('listByScope with status filter', () => {
        store.sessions.create({ id: 'sf1', scope: 'proj', agentType: 'claude' })
        store.sessions.create({ id: 'sf2', scope: 'proj', agentType: 'claude' })
        store.sessions.update('sf2', { status: 'ended' })

        const active = store.sessions.listByScope('proj', { status: ['active'] })
        expect(active.map(s => s.id)).toContain('sf1')
        expect(active.map(s => s.id)).not.toContain('sf2')
      })

      it('updateStats merges stats', () => {
        store.sessions.create({ id: 'stats-1', scope: 's', agentType: 'claude' })
        store.sessions.updateStats('stats-1', { inputTokens: 100, outputTokens: 50 })
        store.sessions.updateStats('stats-1', { inputTokens: 200, toolCalls: 3 })

        const session = store.sessions.get('stats-1')!
        expect(session.stats).toBeDefined()
        expect(session.stats!.inputTokens).toBe(200)
        expect(session.stats!.outputTokens).toBe(50)
        expect(session.stats!.toolCalls).toBe(3)
      })
    })

    // -----------------------------------------------------------------
    // TranscriptStore
    // -----------------------------------------------------------------

    describe('transcripts', () => {
      const SESSION = 'tx-sess'
      const EPOCH = 'epoch-1'

      beforeEach(() => {
        store.sessions.create({ id: SESSION, scope: 'p', agentType: 'claude' })
      })

      it('append + getLatest returns entries in order', () => {
        const entries = [
          makeTranscriptEntry('user', 'u1', { timestamp: 1000 }),
          makeTranscriptEntry('assistant', 'u2', { timestamp: 2000 }),
          makeTranscriptEntry('user', 'u3', { timestamp: 3000 }),
        ]
        store.transcripts.append(SESSION, EPOCH, entries)

        const latest = store.transcripts.getLatest(SESSION, 10)
        expect(latest).toHaveLength(3)
        expect(latest[0].type).toBe('user')
        expect(latest[2].type).toBe('user')
        expect(latest[2].uuid).toBe('u3')
      })

      it('append assigns sequential session_seq values', () => {
        store.transcripts.append(SESSION, EPOCH, [
          makeTranscriptEntry('user', 'a1'),
          makeTranscriptEntry('assistant', 'a2'),
        ])
        store.transcripts.append(SESSION, EPOCH, [makeTranscriptEntry('user', 'a3')])

        const all = store.transcripts.getLatest(SESSION, 10)
        const seqs = all.map(e => e.sessionSeq)
        expect(seqs).toEqual([1, 2, 3])
      })

      it('getPage with cursor-based pagination (forward)', () => {
        const entries = Array.from({ length: 10 }, (_, i) =>
          makeTranscriptEntry('user', `pg-${i}`, { timestamp: 1000 + i }),
        )
        store.transcripts.append(SESSION, EPOCH, entries)

        const page1 = store.transcripts.getPage(SESSION, { limit: 3, direction: 'forward' })
        expect(page1.entries).toHaveLength(3)
        expect(page1.nextCursor).not.toBeNull()

        const page2 = store.transcripts.getPage(SESSION, {
          cursor: page1.nextCursor!,
          limit: 3,
          direction: 'forward',
        })
        expect(page2.entries).toHaveLength(3)
        expect(page2.entries[0].uuid).not.toBe(page1.entries[0].uuid)
      })

      it('getSinceSeq returns entries after given seq', () => {
        store.transcripts.append(SESSION, EPOCH, [
          makeTranscriptEntry('user', 'ss-1'),
          makeTranscriptEntry('assistant', 'ss-2'),
          makeTranscriptEntry('user', 'ss-3'),
        ])

        const result = store.transcripts.getSinceSeq(SESSION, 1)
        expect(result.entries).toHaveLength(2)
        expect(result.entries[0].sessionSeq).toBe(2)
        expect(result.entries[1].sessionSeq).toBe(3)
        expect(result.lastSeq).toBe(3)
      })

      it('getLastSeq returns 0 for empty conversation', () => {
        expect(store.transcripts.getLastSeq(SESSION)).toBe(0)
      })

      it('getLastSeq returns max seq after appending', () => {
        store.transcripts.append(SESSION, EPOCH, [
          makeTranscriptEntry('user', 'lq-1'),
          makeTranscriptEntry('assistant', 'lq-2'),
        ])
        expect(store.transcripts.getLastSeq(SESSION)).toBe(2)
      })

      it('find with type filter', () => {
        store.transcripts.append(SESSION, EPOCH, [
          makeTranscriptEntry('user', 'ft-1'),
          makeTranscriptEntry('assistant', 'ft-2'),
          makeTranscriptEntry('user', 'ft-3'),
          makeTranscriptEntry('tool_result', 'ft-4'),
        ])

        const users = store.transcripts.find(SESSION, { types: ['user'] })
        expect(users).toHaveLength(2)
        expect(users.every(e => e.type === 'user')).toBe(true)
      })

      it('count with agentId filter', () => {
        store.transcripts.append(SESSION, EPOCH, [
          makeTranscriptEntry('user', 'ca-1', { agentId: 'agent-x' }),
          makeTranscriptEntry('assistant', 'ca-2', { agentId: 'agent-x' }),
          makeTranscriptEntry('user', 'ca-3', { agentId: 'agent-y' }),
        ])

        const totalCount = store.transcripts.count(SESSION)
        expect(totalCount).toBe(3)

        const agentXCount = store.transcripts.count(SESSION, 'agent-x')
        expect(agentXCount).toBe(2)
      })

      it('pruneOlderThan removes old entries', () => {
        const old = Date.now() - 100_000
        const recent = Date.now()

        store.transcripts.append(SESSION, EPOCH, [
          makeTranscriptEntry('user', 'pr-1', { timestamp: old }),
          makeTranscriptEntry('assistant', 'pr-2', { timestamp: recent }),
        ])

        const pruned = store.transcripts.pruneOlderThan(Date.now() - 50_000)
        expect(pruned).toBeGreaterThanOrEqual(1)

        const remaining = store.transcripts.getLatest(SESSION, 10)
        expect(remaining).toHaveLength(1)
        expect(remaining[0].uuid).toBe('pr-2')
      })

      it('append is idempotent on (ccSessionId, uuid)', () => {
        const entry = makeTranscriptEntry('user', 'idem-1')
        store.transcripts.append(SESSION, EPOCH, [entry])
        store.transcripts.append(SESSION, EPOCH, [entry])

        const all = store.transcripts.getLatest(SESSION, 10)
        expect(all).toHaveLength(1)
      })
    })

    // -----------------------------------------------------------------
    // EventStore
    // -----------------------------------------------------------------

    describe('events', () => {
      const SESSION = 'ev-sess'

      beforeEach(() => {
        store.sessions.create({ id: SESSION, scope: 'p', agentType: 'claude' })
      })

      it('append + getForConversation returns events', () => {
        store.events.append(SESSION, { type: 'SessionStart', data: { model: 'opus' } })
        store.events.append(SESSION, { type: 'Stop' })

        const events = store.events.getForConversation(SESSION)
        expect(events).toHaveLength(2)
        expect(events[0].type).toBe('SessionStart')
        expect(events[1].type).toBe('Stop')
      })

      it('getForConversation with type filter', () => {
        store.events.append(SESSION, { type: 'SessionStart' })
        store.events.append(SESSION, { type: 'UserPromptSubmit' })
        store.events.append(SESSION, { type: 'Stop' })

        const stops = store.events.getForConversation(SESSION, { types: ['Stop'] })
        expect(stops).toHaveLength(1)
        expect(stops[0].type).toBe('Stop')
      })

      it('getForConversation with limit', () => {
        for (let i = 0; i < 10; i++) {
          store.events.append(SESSION, { type: 'tick', data: { i } })
        }
        const limited = store.events.getForConversation(SESSION, { limit: 3 })
        expect(limited).toHaveLength(3)
      })

      it('pruneOlderThan removes old events', () => {
        store.events.append(SESSION, { type: 'old' })
        const cutoff = Date.now() + 1000
        const pruned = store.events.pruneOlderThan(cutoff)
        expect(pruned).toBeGreaterThanOrEqual(1)

        const remaining = store.events.getForConversation(SESSION)
        expect(remaining).toHaveLength(0)
      })
    })

    // -----------------------------------------------------------------
    // KVStore
    // -----------------------------------------------------------------

    describe('kv', () => {
      it('set + get roundtrip', () => {
        store.kv.set('config:theme', { dark: true, accent: 'blue' })
        const val = store.kv.get<{ dark: boolean; accent: string }>('config:theme')
        expect(val).toEqual({ dark: true, accent: 'blue' })
      })

      it('get returns null for missing key', () => {
        expect(store.kv.get('nonexistent')).toBeNull()
      })

      it('delete removes key', () => {
        store.kv.set('temp', 42)
        expect(store.kv.delete('temp')).toBe(true)
        expect(store.kv.get('temp')).toBeNull()
      })

      it('delete returns false for missing key', () => {
        expect(store.kv.delete('ghost')).toBe(false)
      })

      it('keys(prefix) filters by prefix', () => {
        store.kv.set('config:theme', 'dark')
        store.kv.set('config:lang', 'en')
        store.kv.set('session:active', true)

        const configKeys = store.kv.keys('config:')
        expect(configKeys).toContain('config:theme')
        expect(configKeys).toContain('config:lang')
        expect(configKeys).not.toContain('session:active')
      })

      it('keys() with no prefix returns all keys', () => {
        store.kv.set('a', 1)
        store.kv.set('b', 2)
        const all = store.kv.keys()
        expect(all).toContain('a')
        expect(all).toContain('b')
      })

      it('set overwrites existing value', () => {
        store.kv.set('counter', 1)
        store.kv.set('counter', 2)
        expect(store.kv.get('counter')).toBe(2)
      })
    })

    // -----------------------------------------------------------------
    // MessageStore
    // -----------------------------------------------------------------

    describe('messages', () => {
      it('enqueue + dequeueFor delivers messages', () => {
        store.messages.enqueue({
          fromScope: 'project-a',
          toScope: 'project-b',
          content: 'hello',
          expiresAt: Date.now() + 60_000,
        })

        const msgs = store.messages.dequeueFor('project-b')
        expect(msgs).toHaveLength(1)
        expect(msgs[0].content).toBe('hello')
        expect(msgs[0].fromScope).toBe('project-a')
      })

      it('dequeue marks as delivered (no double delivery)', () => {
        store.messages.enqueue({
          fromScope: 'a',
          toScope: 'b',
          content: 'once',
          expiresAt: Date.now() + 60_000,
        })

        const first = store.messages.dequeueFor('b')
        expect(first).toHaveLength(1)

        const second = store.messages.dequeueFor('b')
        expect(second).toHaveLength(0)
      })

      it('log + queryLog', () => {
        store.messages.log({
          fromScope: 'a',
          toScope: 'b',
          content: 'logged message',
          createdAt: Date.now(),
        })

        const entries = store.messages.queryLog({ scope: 'a' })
        expect(entries).toHaveLength(1)
        expect(entries[0].content).toBe('logged message')
      })

      it('queryLog with conversationId filter', () => {
        store.messages.log({
          fromScope: 'a',
          toScope: 'b',
          conversationId: 'conv-1',
          content: 'msg-1',
          createdAt: Date.now(),
        })
        store.messages.log({
          fromScope: 'a',
          toScope: 'b',
          conversationId: 'conv-2',
          content: 'msg-2',
          createdAt: Date.now(),
        })

        const conv1 = store.messages.queryLog({ conversationId: 'conv-1' })
        expect(conv1).toHaveLength(1)
        expect(conv1[0].content).toBe('msg-1')
      })

      it('pruneExpired removes expired messages', () => {
        store.messages.enqueue({
          fromScope: 'a',
          toScope: 'b',
          content: 'expired',
          expiresAt: Date.now() - 1000,
        })
        store.messages.enqueue({
          fromScope: 'a',
          toScope: 'b',
          content: 'fresh',
          expiresAt: Date.now() + 60_000,
        })

        const pruned = store.messages.pruneExpired()
        expect(pruned).toBeGreaterThanOrEqual(1)

        const remaining = store.messages.dequeueFor('b')
        expect(remaining).toHaveLength(1)
        expect(remaining[0].content).toBe('fresh')
      })
    })

    // -----------------------------------------------------------------
    // ShareStore
    // -----------------------------------------------------------------

    describe('shares', () => {
      it('create + get', () => {
        const share = store.shares.create({
          token: 'tok-1',
          conversationId: 'sess-1',
          permissions: { read: true },
          expiresAt: Date.now() + 60_000,
        })
        expect(share.token).toBe('tok-1')
        expect(share.viewerCount).toBe(0)

        const fetched = store.shares.get('tok-1')
        expect(fetched).not.toBeNull()
        expect(fetched!.conversationId).toBe('sess-1')
      })

      it('get returns null for missing token', () => {
        expect(store.shares.get('ghost-token')).toBeNull()
      })

      it('getForConversation', () => {
        store.shares.create({
          token: 'ts-1',
          conversationId: 'shared-sess',
          permissions: { read: true },
          expiresAt: Date.now() + 60_000,
        })
        store.shares.create({
          token: 'ts-2',
          conversationId: 'shared-sess',
          permissions: { read: true, write: true },
          expiresAt: Date.now() + 60_000,
        })
        store.shares.create({
          token: 'ts-3',
          conversationId: 'other-sess',
          permissions: { read: true },
          expiresAt: Date.now() + 60_000,
        })

        const shares = store.shares.getForConversation('shared-sess')
        expect(shares).toHaveLength(2)
        expect(shares.map(s => s.token).sort()).toEqual(['ts-1', 'ts-2'])
      })

      it('incrementViewerCount', () => {
        store.shares.create({
          token: 'vc-tok',
          conversationId: 's',
          permissions: {},
          expiresAt: Date.now() + 60_000,
        })
        store.shares.incrementViewerCount('vc-tok')
        store.shares.incrementViewerCount('vc-tok')

        const share = store.shares.get('vc-tok')!
        expect(share.viewerCount).toBe(2)
      })

      it('delete removes share', () => {
        store.shares.create({
          token: 'del-tok',
          conversationId: 's',
          permissions: {},
          expiresAt: Date.now() + 60_000,
        })
        expect(store.shares.delete('del-tok')).toBe(true)
        expect(store.shares.get('del-tok')).toBeNull()
      })

      it('deleteExpired removes expired shares', () => {
        store.shares.create({
          token: 'expired-tok',
          conversationId: 's',
          permissions: {},
          expiresAt: Date.now() - 1000,
        })
        store.shares.create({
          token: 'fresh-tok',
          conversationId: 's',
          permissions: {},
          expiresAt: Date.now() + 60_000,
        })

        const pruned = store.shares.deleteExpired()
        expect(pruned).toBeGreaterThanOrEqual(1)
        expect(store.shares.get('expired-tok')).toBeNull()
        expect(store.shares.get('fresh-tok')).not.toBeNull()
      })
    })

    // -----------------------------------------------------------------
    // AddressBookStore
    // -----------------------------------------------------------------

    describe('addressBook', () => {
      it('set + resolve', () => {
        store.addressBook.set('owner-1', 'mybuddy', 'target-scope')
        const resolved = store.addressBook.resolve('owner-1', 'mybuddy')
        expect(resolved).toBe('target-scope')
      })

      it('resolve returns null for missing', () => {
        expect(store.addressBook.resolve('nobody', 'nothing')).toBeNull()
      })

      it('listForScope', () => {
        store.addressBook.set('owner-a', 'slug-1', 'target-1')
        store.addressBook.set('owner-a', 'slug-2', 'target-2')
        store.addressBook.set('owner-b', 'slug-3', 'target-3')

        const entries = store.addressBook.listForScope('owner-a')
        expect(entries).toHaveLength(2)
        expect(entries.map(e => e.slug).sort()).toEqual(['slug-1', 'slug-2'])
      })

      it('findByTarget', () => {
        store.addressBook.set('owner-x', 'alias-1', 'shared-target')
        store.addressBook.set('owner-y', 'alias-2', 'shared-target')
        store.addressBook.set('owner-z', 'alias-3', 'other-target')

        const found = store.addressBook.findByTarget('shared-target')
        expect(found).toHaveLength(2)
        expect(found.every(e => e.targetScope === 'shared-target')).toBe(true)
      })

      it('delete removes entry', () => {
        store.addressBook.set('o', 's', 't')
        expect(store.addressBook.delete('o', 's')).toBe(true)
        expect(store.addressBook.resolve('o', 's')).toBeNull()
      })

      it('set overwrites existing slug', () => {
        store.addressBook.set('owner', 'slug', 'target-old')
        store.addressBook.set('owner', 'slug', 'target-new')
        expect(store.addressBook.resolve('owner', 'slug')).toBe('target-new')
      })
    })

    // -----------------------------------------------------------------
    // ScopeLinkStore
    // -----------------------------------------------------------------

    describe('scopeLinks', () => {
      it('link + getStatus returns active', () => {
        store.scopeLinks.link('scope-a', 'scope-b')
        expect(store.scopeLinks.getStatus('scope-a', 'scope-b')).toBe('active')
      })

      it('getStatus is bidirectional', () => {
        store.scopeLinks.link('left', 'right')
        expect(store.scopeLinks.getStatus('right', 'left')).toBe('active')
      })

      it('getStatus returns null for unlinked scopes', () => {
        expect(store.scopeLinks.getStatus('x', 'y')).toBeNull()
      })

      it('unlink removes the link', () => {
        store.scopeLinks.link('a', 'b')
        store.scopeLinks.unlink('a', 'b')
        expect(store.scopeLinks.getStatus('a', 'b')).toBeNull()
      })

      it('setStatus changes status', () => {
        store.scopeLinks.link('s1', 's2')
        store.scopeLinks.setStatus('s1', 's2', 'blocked')
        expect(store.scopeLinks.getStatus('s1', 's2')).toBe('blocked')
      })

      it('setStatus is bidirectional', () => {
        store.scopeLinks.link('s3', 's4')
        store.scopeLinks.setStatus('s4', 's3', 'pending')
        expect(store.scopeLinks.getStatus('s3', 's4')).toBe('pending')
      })

      it('listLinksFor returns all links for a scope', () => {
        store.scopeLinks.link('hub', 'spoke-1')
        store.scopeLinks.link('hub', 'spoke-2')
        store.scopeLinks.link('other', 'spoke-3')

        const links = store.scopeLinks.listLinksFor('hub')
        expect(links).toHaveLength(2)
        const peers = links.map(l => (l.scopeA === 'hub' ? l.scopeB : l.scopeA))
        expect(peers.sort()).toEqual(['spoke-1', 'spoke-2'])
      })

      it('listLinksFor returns links where scope is on either side', () => {
        store.scopeLinks.link('alpha', 'beta')
        const fromBeta = store.scopeLinks.listLinksFor('beta')
        expect(fromBeta).toHaveLength(1)
      })
    })

    // -----------------------------------------------------------------
    // TaskStore
    // -----------------------------------------------------------------

    describe('tasks', () => {
      it('upsert + getForConversation', () => {
        store.tasks.upsert('task-sess', {
          id: 't1',
          conversationId: 'task-sess',
          kind: 'task',
          status: 'pending',
          name: 'Do stuff',
          createdAt: Date.now(),
        })

        const tasks = store.tasks.getForConversation('task-sess')
        expect(tasks).toHaveLength(1)
        expect(tasks[0].id).toBe('t1')
        expect(tasks[0].status).toBe('pending')
      })

      it('upsert updates existing task', () => {
        const now = Date.now()
        store.tasks.upsert('ts', {
          id: 'u1',
          conversationId: 'ts',
          kind: 'task',
          status: 'pending',
          createdAt: now,
        })
        store.tasks.upsert('ts', {
          id: 'u1',
          conversationId: 'ts',
          kind: 'task',
          status: 'completed',
          createdAt: now,
          updatedAt: now + 1000,
        })

        const tasks = store.tasks.getForConversation('ts')
        expect(tasks).toHaveLength(1)
        expect(tasks[0].status).toBe('completed')
      })

      it('getForConversation with kind filter', () => {
        const now = Date.now()
        store.tasks.upsert('ks', {
          id: 'k1',
          conversationId: 'ks',
          kind: 'task',
          status: 'pending',
          createdAt: now,
        })
        store.tasks.upsert('ks', {
          id: 'k2',
          conversationId: 'ks',
          kind: 'bg_task',
          status: 'running',
          createdAt: now,
        })

        const tasks = store.tasks.getForConversation('ks', 'task')
        expect(tasks).toHaveLength(1)
        expect(tasks[0].id).toBe('k1')
      })

      it('delete removes a specific task', () => {
        store.tasks.upsert('ds', {
          id: 'd1',
          conversationId: 'ds',
          kind: 'task',
          status: 'pending',
          createdAt: Date.now(),
        })
        expect(store.tasks.delete('ds', 'd1')).toBe(true)
        expect(store.tasks.getForConversation('ds')).toHaveLength(0)
      })

      it('delete returns false for missing task', () => {
        expect(store.tasks.delete('ds', 'ghost')).toBe(false)
      })

      it('deleteForConversation removes all tasks for conversation', () => {
        const now = Date.now()
        store.tasks.upsert('bulk', {
          id: 'b1',
          conversationId: 'bulk',
          kind: 'task',
          status: 'a',
          createdAt: now,
        })
        store.tasks.upsert('bulk', {
          id: 'b2',
          conversationId: 'bulk',
          kind: 'task',
          status: 'b',
          createdAt: now,
        })

        const deleted = store.tasks.deleteForConversation('bulk')
        expect(deleted).toBe(2)
        expect(store.tasks.getForConversation('bulk')).toHaveLength(0)
      })
    })

    // -----------------------------------------------------------------
    // CostStore
    // -----------------------------------------------------------------

    describe('costs', () => {
      function baseTurn(overrides: Partial<import('../types').TurnRecord> = {}): import('../types').TurnRecord {
        return {
          timestamp: Date.now(),
          conversationId: 's1',
          projectUri: 'claude://default/proj-a',
          account: 'alice@example.com',
          orgId: 'org-1',
          model: 'claude-opus-4',
          inputTokens: 100,
          outputTokens: 200,
          cacheReadTokens: 50,
          cacheWriteTokens: 25,
          costUsd: 0.05,
          exactCost: true,
          ...overrides,
        }
      }

      it('recordTurn + queryTurns round-trips', () => {
        store.costs.recordTurn(baseTurn({ timestamp: 1_700_000_000_000 }))
        const { rows, total } = store.costs.queryTurns({})
        expect(total).toBe(1)
        expect(rows[0].conversationId).toBe('s1')
        expect(rows[0].projectUri).toBe('claude://default/proj-a')
        expect(rows[0].inputTokens).toBe(100)
        expect(rows[0].exactCost).toBe(true)
      })

      it('queryTurns sorts by timestamp descending', () => {
        store.costs.recordTurn(baseTurn({ timestamp: 1000, conversationId: 'a' }))
        store.costs.recordTurn(baseTurn({ timestamp: 3000, conversationId: 'c' }))
        store.costs.recordTurn(baseTurn({ timestamp: 2000, conversationId: 'b' }))
        const { rows } = store.costs.queryTurns({})
        expect(rows.map(r => r.conversationId)).toEqual(['c', 'b', 'a'])
      })

      it('queryTurns filters by projectUri / account / model / timestamp', () => {
        store.costs.recordTurn(baseTurn({ timestamp: 1000, projectUri: 'p1', model: 'opus-4' }))
        store.costs.recordTurn(baseTurn({ timestamp: 2000, projectUri: 'p2', model: 'sonnet-4' }))
        store.costs.recordTurn(baseTurn({ timestamp: 3000, projectUri: 'p1', model: 'opus-4' }))

        expect(store.costs.queryTurns({ projectUri: 'p1' }).total).toBe(2)
        expect(store.costs.queryTurns({ model: 'sonnet' }).total).toBe(1)
        expect(store.costs.queryTurns({ from: 1500, to: 2500 }).total).toBe(1)
      })

      it('queryTurns respects limit + offset', () => {
        for (let i = 0; i < 5; i++) {
          store.costs.recordTurn(baseTurn({ timestamp: 1000 + i * 100 }))
        }
        const page1 = store.costs.queryTurns({ limit: 2 })
        const page2 = store.costs.queryTurns({ limit: 2, offset: 2 })
        expect(page1.rows).toHaveLength(2)
        expect(page2.rows).toHaveLength(2)
        expect(page1.rows[0].timestamp).not.toBe(page2.rows[0].timestamp)
        expect(page1.total).toBe(5)
      })

      it('recordTurnFromCumulatives records first turn as full cumulative', () => {
        const ok = store.costs.recordTurnFromCumulatives({
          timestamp: 1000,
          conversationId: 'cum1',
          projectUri: 'proj',
          account: '',
          orgId: '',
          model: 'opus',
          totalInputTokens: 500,
          totalOutputTokens: 1000,
          totalCacheRead: 200,
          totalCacheWrite: 100,
          totalCostUsd: 0.1,
          exactCost: true,
        })
        expect(ok).toBe(true)
        const { rows } = store.costs.queryTurns({})
        expect(rows).toHaveLength(1)
        expect(rows[0].inputTokens).toBe(500)
        expect(rows[0].costUsd).toBeCloseTo(0.1)
      })

      it('recordTurnFromCumulatives subsequent call records delta only', () => {
        store.costs.recordTurnFromCumulatives({
          timestamp: 1000,
          conversationId: 'cum2',
          projectUri: 'p',
          account: '',
          orgId: '',
          model: 'm',
          totalInputTokens: 100,
          totalOutputTokens: 200,
          totalCacheRead: 0,
          totalCacheWrite: 0,
          totalCostUsd: 0.05,
          exactCost: true,
        })
        store.costs.recordTurnFromCumulatives({
          timestamp: 2000,
          conversationId: 'cum2',
          projectUri: 'p',
          account: '',
          orgId: '',
          model: 'm',
          totalInputTokens: 150,
          totalOutputTokens: 300,
          totalCacheRead: 0,
          totalCacheWrite: 0,
          totalCostUsd: 0.08,
          exactCost: true,
        })
        const { rows, total } = store.costs.queryTurns({ projectUri: 'p' })
        expect(total).toBe(2)
        // Sorted DESC: index 0 is the delta, index 1 is the initial
        expect(rows[0].inputTokens).toBe(50)
        expect(rows[0].outputTokens).toBe(100)
        expect(rows[0].costUsd).toBeCloseTo(0.03)
      })

      it('recordTurnFromCumulatives skips when no token delta', () => {
        const args = {
          timestamp: 1000,
          conversationId: 'same',
          projectUri: 'p',
          account: '',
          orgId: '',
          model: 'm',
          totalInputTokens: 100,
          totalOutputTokens: 200,
          totalCacheRead: 0,
          totalCacheWrite: 0,
          totalCostUsd: 0.05,
          exactCost: true,
        }
        store.costs.recordTurnFromCumulatives(args)
        const second = store.costs.recordTurnFromCumulatives({ ...args, timestamp: 2000 })
        expect(second).toBe(false)
        expect(store.costs.queryTurns({}).total).toBe(1)
      })

      it('querySummary aggregates correctly within period', () => {
        const now = Date.now()
        const hourAgo = now - 60 * 60 * 1000
        store.costs.recordTurn(baseTurn({ timestamp: hourAgo, projectUri: 'px', model: 'opus', costUsd: 0.1 }))
        store.costs.recordTurn(baseTurn({ timestamp: hourAgo, projectUri: 'py', model: 'opus', costUsd: 0.2 }))
        store.costs.recordTurn(baseTurn({ timestamp: hourAgo, projectUri: 'px', model: 'sonnet', costUsd: 0.05 }))

        const summary = store.costs.querySummary('24h')
        expect(summary.period).toBe('24h')
        expect(summary.totalTurns).toBe(3)
        expect(summary.totalCostUsd).toBeCloseTo(0.35)
        expect(summary.topProjects[0].projectUri).toBe('py')
        expect(summary.topProjects[0].costUsd).toBeCloseTo(0.2)
        expect(summary.topModels[0].model).toBe('opus')
      })

      it('querySummary respects period cutoff', () => {
        const now = Date.now()
        store.costs.recordTurn(baseTurn({ timestamp: now, costUsd: 0.1 }))
        store.costs.recordTurn(baseTurn({ timestamp: now - 10 * 24 * 60 * 60 * 1000, costUsd: 1.0 }))

        const day = store.costs.querySummary('24h')
        const month = store.costs.querySummary('30d')
        expect(day.totalTurns).toBe(1)
        expect(month.totalTurns).toBe(2)
      })

      it('queryHourly excludes current hour, aggregates completed hours', () => {
        // Anchor to top-of-hour two hours ago so adding minutes never crosses into the current hour
        const twoHoursAgoHour = new Date(Date.now() - 2 * 60 * 60 * 1000)
        twoHoursAgoHour.setMinutes(0, 0, 0)
        const hourBase = twoHoursAgoHour.getTime()

        store.costs.recordTurn(baseTurn({ timestamp: hourBase, model: 'opus', costUsd: 0.1 }))
        store.costs.recordTurn(baseTurn({ timestamp: hourBase + 60_000, model: 'opus', costUsd: 0.2 }))
        store.costs.recordTurn(baseTurn({ timestamp: hourBase + 60 * 60 * 1000, model: 'opus', costUsd: 0.3 }))

        const hours = store.costs.queryHourly({})
        expect(hours.length).toBeGreaterThanOrEqual(2)
        const total = hours.reduce((s, h) => s + h.costUsd, 0)
        expect(total).toBeCloseTo(0.6)
      })

      it('queryHourly groupBy=day merges hour buckets into days', () => {
        // All within one day, one account+model combo
        const midnight = new Date()
        midnight.setUTCHours(0, 0, 0, 0)
        const day = midnight.getTime()

        store.costs.recordTurn(baseTurn({ timestamp: day + 1 * 60 * 60 * 1000, costUsd: 0.1 }))
        store.costs.recordTurn(baseTurn({ timestamp: day + 3 * 60 * 60 * 1000, costUsd: 0.2 }))
        store.costs.recordTurn(baseTurn({ timestamp: day + 5 * 60 * 60 * 1000, costUsd: 0.3 }))

        const days = store.costs.queryHourly({ groupBy: 'day' })
        const today = days.find(d => d.hour === new Date(day).toISOString().slice(0, 10))
        expect(today).toBeDefined()
        expect(today!.costUsd).toBeCloseTo(0.6)
      })

      it('pruneOlderThan deletes old turns + hourly rows', () => {
        const now = Date.now()
        store.costs.recordTurn(baseTurn({ timestamp: now - 40 * 24 * 60 * 60 * 1000 }))
        store.costs.recordTurn(baseTurn({ timestamp: now - 1 * 24 * 60 * 60 * 1000 }))

        // Materialize hourly by issuing a query
        store.costs.queryHourly({})

        const deleted = store.costs.pruneOlderThan(now - 30 * 24 * 60 * 60 * 1000)
        expect(deleted.turns).toBe(1)
        expect(store.costs.queryTurns({}).total).toBe(1)
      })
    })
  })
}

// -----------------------------------------------------------------
// Wire up drivers
// -----------------------------------------------------------------

runStoreTests('MemoryDriver', () => createMemoryDriver())

runStoreTests('SqliteDriver', () =>
  createSqliteDriver({ type: 'sqlite', dataDir: mkdtempSync(join(tmpdir(), 'store-test-')) }),
)
