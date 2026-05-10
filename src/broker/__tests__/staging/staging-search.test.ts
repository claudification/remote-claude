/**
 * Staging FTS5 search + sliding context window tests.
 *
 * End-to-end against a real broker:
 *   - Seed transcript entries via WebSocket
 *   - Search via HTTP /api/search (FTS5 query syntax, project glob, types,
 *     conversation filter, pagination, per-hit window context)
 *   - Slide context via HTTP /api/transcript-window
 *   - Verify the FTS index is live (triggers fire on each transcript_entries
 *     insert -- new rows are immediately searchable)
 */

import { afterEach, describe, expect, it } from 'bun:test'
import {
  cleanup,
  connectAgentHost,
  getBrokerSecret,
  httpGet,
  type LiveWs,
  sleep,
  testId,
  waitForMessage,
} from './staging-harness'

const STAGING_AVAILABLE = !!(process.env.STAGING_BROKER_URL && process.env.STAGING_SECRET)
const run = STAGING_AVAILABLE ? describe : describe.skip

afterEach(() => {
  cleanup()
})

// ─── helpers ──────────────────────────────────────────────────────

// CC session IDs are internal to the agent host -- the broker routes by
// the canonical convId. This harness models the post-rekey-kill protocol
// where transcript entries flow over WS keyed by convId.
async function bootConversation(agent: LiveWs, project: string): Promise<{ convId: string; ccSessionId: string }> {
  const convId = testId('conv-search')
  const ccSessionId = testId('cc')

  agent.send({
    type: 'agent_host_boot',
    conversationId: convId,
    project,
    capabilities: [],
    claudeArgs: [],
    startedAt: Date.now(),
  })
  await sleep(100)

  agent.send({
    type: 'conversation_promote',
    conversationId: convId,
    ccSessionId,
    source: 'staging-search-test',
  })
  await sleep(100)

  agent.send({
    type: 'meta',
    conversationId: convId,
    ccSessionId,
    project,
    cwd: project.replace(/^claude:\/\/[^/]*/, ''),
    startedAt: Date.now(),
  })
  await waitForMessage(agent, 'ack')

  return { convId, ccSessionId }
}

interface TranscriptInput {
  type: string
  text: string
}

function makeEntries(items: TranscriptInput[]): Array<Record<string, unknown>> {
  return items.map(item => ({
    type: item.type,
    uuid: crypto.randomUUID(),
    message: { role: item.type === 'assistant' ? 'assistant' : 'user', content: item.text },
    timestamp: new Date().toISOString(),
  }))
}

async function seedTranscript(agent: LiveWs, convId: string, items: TranscriptInput[]): Promise<void> {
  agent.send({
    type: 'transcript_entries',
    conversationId: convId,
    entries: makeEntries(items),
    isInitial: false,
  })
  // Give the broker a moment to handle the WS message and write to SQLite.
  await sleep(300)
}

interface SearchHit {
  id: number
  conversationId: string
  seq: number
  type: string
  content: Record<string, unknown>
  rank: number
  snippet: string
  conversation?: { id: string; project?: string; title?: string }
  window?: Array<{ id: number; seq: number; type: string }>
}

interface SearchResponse {
  hits: SearchHit[]
  total: number
  query: string
  limit: number
  offset: number
}

async function search(query: string, params: Record<string, string | number> = {}): Promise<SearchResponse> {
  const qs = new URLSearchParams({ q: query })
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v))
  const res = await httpGet(`/api/search?${qs}`, { bearer: getBrokerSecret() })
  expect(res.status).toBe(200)
  return (await res.json()) as SearchResponse
}

interface WindowResponse {
  entries: Array<{ id: number; seq: number; type: string; content: Record<string, unknown> }>
  conversation: { id: string; project?: string }
}

async function getWindow(conversationId: string, params: Record<string, string | number>): Promise<WindowResponse> {
  const qs = new URLSearchParams({ conversation: conversationId })
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v))
  const res = await httpGet(`/api/transcript-window?${qs}`, { bearer: getBrokerSecret() })
  expect(res.status).toBe(200)
  return (await res.json()) as WindowResponse
}

// ─── /api/search basics ──────────────────────────────────────────

run('search: basic queries', () => {
  it('returns 400 with no query', async () => {
    const res = await httpGet('/api/search', { bearer: getBrokerSecret() })
    expect(res.status).toBe(400)
  })

  it('returns 400 with empty query', async () => {
    const res = await httpGet('/api/search?q=', { bearer: getBrokerSecret() })
    expect(res.status).toBe(400)
  })

  it('finds a single seeded entry by bareword', async () => {
    const agent = await connectAgentHost()
    const { convId } = await bootConversation(agent, 'claude:///tmp/staging-search-basic')
    const marker = `unique-marker-${crypto.randomUUID().slice(0, 8)}`
    await seedTranscript(agent, convId, [{ type: 'user', text: `before ${marker} after` }])

    const result = await search(marker)
    expect(result.hits.length).toBeGreaterThanOrEqual(1)
    const hit = result.hits[0]
    expect(hit.snippet.toLowerCase()).toContain(marker.toLowerCase())
    expect(hit.conversation?.id).toBeDefined()
  })

  it('returns no hits for a non-matching query', async () => {
    const result = await search(`absolutely-no-such-token-${crypto.randomUUID()}`)
    expect(result.hits.length).toBe(0)
  })

  it('snippet wraps the match in <mark> tags', async () => {
    const agent = await connectAgentHost()
    const { convId } = await bootConversation(agent, 'claude:///tmp/staging-search-snippet')
    const tok = `xtoken${crypto.randomUUID().slice(0, 8)}`
    await seedTranscript(agent, convId, [{ type: 'user', text: `hello ${tok} world` }])

    const result = await search(tok)
    expect(result.hits.length).toBeGreaterThanOrEqual(1)
    expect(result.hits[0].snippet).toContain('<mark>')
    expect(result.hits[0].snippet).toContain('</mark>')
  })
})

// ─── filters ─────────────────────────────────────────────────────

run('search: filters', () => {
  it('conversationId filter limits to one conversation', async () => {
    const agent = await connectAgentHost()
    const a = await bootConversation(agent, 'claude:///tmp/staging-conv-filter-a')
    const b = await bootConversation(agent, 'claude:///tmp/staging-conv-filter-b')

    const tok = `convfilter${crypto.randomUUID().slice(0, 8)}`
    await seedTranscript(agent, a.convId, [{ type: 'user', text: `${tok} from A` }])
    await seedTranscript(agent, b.convId, [{ type: 'user', text: `${tok} from B` }])

    // Both visible without filter
    const all = await search(tok)
    expect(all.hits.length).toBeGreaterThanOrEqual(2)

    // Only A when filtering
    const justA = await search(tok, { conversation: a.convId })
    expect(justA.hits.length).toBeGreaterThanOrEqual(1)
    expect(justA.hits.every(h => h.conversationId === a.convId)).toBe(true)
  })

  it('project glob filter (prefix/*) limits to subtree', async () => {
    const agent = await connectAgentHost()
    const inside = await bootConversation(agent, 'claude:///tmp/staging-proj-glob/inside')
    const outside = await bootConversation(agent, 'claude:///tmp/staging-other-tree/outside')

    const tok = `projglob${crypto.randomUUID().slice(0, 8)}`
    await seedTranscript(agent, inside.convId, [{ type: 'user', text: `${tok} inside subtree` }])
    await seedTranscript(agent, outside.convId, [{ type: 'user', text: `${tok} outside subtree` }])

    const result = await search(tok, { project: 'claude:///tmp/staging-proj-glob/*' })
    expect(result.hits.length).toBeGreaterThanOrEqual(1)
    // Note: the broker may rewrite empty-authority URIs to claude://default/...,
    // so we assert the conversationId rather than the project string.
    const ids = new Set(result.hits.map(h => h.conversationId))
    expect(ids.has(inside.convId)).toBe(true)
    expect(ids.has(outside.convId)).toBe(false)
  })

  it('type filter limits by transcript entry type', async () => {
    const agent = await connectAgentHost()
    const { convId } = await bootConversation(agent, 'claude:///tmp/staging-type-filter')

    const tok = `typefilter${crypto.randomUUID().slice(0, 8)}`
    await seedTranscript(agent, convId, [
      { type: 'user', text: `${tok} as user` },
      { type: 'assistant', text: `${tok} as assistant` },
    ])

    const userOnly = await search(tok, { type: 'user' })
    expect(userOnly.hits.length).toBeGreaterThanOrEqual(1)
    expect(userOnly.hits.every(h => h.type === 'user')).toBe(true)

    const both = await search(tok, { type: 'user,assistant' })
    expect(both.hits.length).toBeGreaterThanOrEqual(2)
  })
})

// ─── FTS5 syntax ─────────────────────────────────────────────────

run('search: FTS5 syntax', () => {
  it('AND operator requires both terms', async () => {
    const agent = await connectAgentHost()
    const { convId } = await bootConversation(agent, 'claude:///tmp/staging-fts-and')
    const a = `tokA${crypto.randomUUID().slice(0, 8)}`
    const b = `tokB${crypto.randomUUID().slice(0, 8)}`
    await seedTranscript(agent, convId, [
      { type: 'user', text: `only ${a} alone` },
      { type: 'user', text: `pair ${a} and ${b} together` },
      { type: 'user', text: `only ${b} alone` },
    ])

    const result = await search(`${a} AND ${b}`)
    expect(result.hits.length).toBe(1)
    const text = JSON.stringify(result.hits[0].content).toLowerCase()
    expect(text).toContain(a.toLowerCase())
    expect(text).toContain(b.toLowerCase())
  })

  it('prefix matching (*)', async () => {
    const agent = await connectAgentHost()
    const { convId } = await bootConversation(agent, 'claude:///tmp/staging-fts-prefix')
    const stem = `pref${crypto.randomUUID().slice(0, 6)}`
    await seedTranscript(agent, convId, [
      { type: 'user', text: `${stem}ication is happening` },
      { type: 'user', text: `${stem}ate the data` },
      { type: 'user', text: `unrelated word` },
    ])

    const result = await search(`${stem}*`)
    expect(result.hits.length).toBeGreaterThanOrEqual(2)
  })

  it('multi-word casual query auto-quotes (no syntax error)', async () => {
    const agent = await connectAgentHost()
    const { convId } = await bootConversation(agent, 'claude:///tmp/staging-fts-multi')
    const tok = `phrase${crypto.randomUUID().slice(0, 8)}`
    await seedTranscript(agent, convId, [{ type: 'user', text: `the ${tok} casual phrase here` }])

    // Casual multi-word query with hyphen-flavored token; must not 400.
    const result = await search(`${tok} casual phrase`)
    expect(result.hits.length).toBeGreaterThanOrEqual(1)
  })
})

// ─── pagination + ranking ────────────────────────────────────────

run('search: pagination', () => {
  it('limit + offset paginate without overlap', async () => {
    const agent = await connectAgentHost()
    const { convId } = await bootConversation(agent, 'claude:///tmp/staging-pagination')
    const tok = `paginate${crypto.randomUUID().slice(0, 8)}`
    await seedTranscript(
      agent,
      convId,
      Array.from({ length: 12 }, (_, i) => ({ type: 'user', text: `${tok} entry-${i}` })),
    )

    const a = await search(tok, { limit: 5, offset: 0 })
    const b = await search(tok, { limit: 5, offset: 5 })
    expect(a.hits.length).toBe(5)
    expect(b.hits.length).toBeLessThanOrEqual(5)

    const aIds = new Set(a.hits.map(h => h.id))
    for (const hit of b.hits) {
      expect(aIds.has(hit.id)).toBe(false)
    }
  })

  it('limit caps at 100', async () => {
    const result = await search('a', { limit: 1000 })
    expect(result.hits.length).toBeLessThanOrEqual(100)
  })
})

// ─── window context ─────────────────────────────────────────────

run('search: per-hit window context', () => {
  it('windowBefore/windowAfter return surrounding entries', async () => {
    const agent = await connectAgentHost()
    const { convId } = await bootConversation(agent, 'claude:///tmp/staging-window')
    const tok = `winhit${crypto.randomUUID().slice(0, 8)}`
    // 5 before + needle + 5 after
    const entries: TranscriptInput[] = []
    for (let i = 0; i < 5; i++) entries.push({ type: 'user', text: `pre ${i}` })
    entries.push({ type: 'user', text: `the ${tok} needle` })
    for (let i = 0; i < 5; i++) entries.push({ type: 'user', text: `post ${i}` })
    await seedTranscript(agent, convId, entries)

    const result = await search(tok, { windowBefore: 2, windowAfter: 2 })
    expect(result.hits.length).toBe(1)
    const hit = result.hits[0]
    const window = hit.window
    if (!window) throw new Error('expected hit.window to be defined')
    expect(window.length).toBe(5) // 2 before + 1 hit + 2 after
    const seqs = window.map(e => e.seq).sort((a, b) => a - b)
    expect(seqs[0]).toBe(hit.seq - 2)
    expect(seqs[seqs.length - 1]).toBe(hit.seq + 2)
  })
})

// ─── /api/transcript-window ──────────────────────────────────────

run('transcript-window: sliding context', () => {
  it('returns entries centered on aroundSeq', async () => {
    const agent = await connectAgentHost()
    const { convId } = await bootConversation(agent, 'claude:///tmp/staging-slide')
    await seedTranscript(
      agent,
      convId,
      Array.from({ length: 10 }, (_, i) => ({ type: 'user', text: `slide-${i}` })),
    )

    const win = await getWindow(convId, { aroundSeq: 5, before: 2, after: 2 })
    expect(win.entries.length).toBe(5)
    const seqs = win.entries.map(e => e.seq)
    expect(seqs).toEqual([3, 4, 5, 6, 7])
    expect(win.conversation.id).toBe(convId)
  })

  it('clips at conversation boundaries', async () => {
    const agent = await connectAgentHost()
    const { convId } = await bootConversation(agent, 'claude:///tmp/staging-clip')
    await seedTranscript(
      agent,
      convId,
      Array.from({ length: 5 }, (_, i) => ({ type: 'user', text: `clip-${i}` })),
    )

    const win = await getWindow(convId, { aroundSeq: 1, before: 10, after: 0 })
    // Asking for 10 before seq 1 -- only seq 1 itself returns
    expect(win.entries.length).toBe(1)
    expect(win.entries[0].seq).toBe(1)
  })

  it('400 with neither aroundSeq nor aroundId', async () => {
    const agent = await connectAgentHost()
    const { convId } = await bootConversation(agent, 'claude:///tmp/staging-window-args')
    const res = await httpGet(`/api/transcript-window?conversation=${convId}`, { bearer: getBrokerSecret() })
    expect(res.status).toBe(400)
  })

  it('404 for unknown conversation', async () => {
    const res = await httpGet('/api/transcript-window?conversation=ghost-id&aroundSeq=1', {
      bearer: getBrokerSecret(),
    })
    expect(res.status).toBe(404)
  })
})

// ─── live-trigger sync ───────────────────────────────────────────

run('search: triggers stay live', () => {
  it('newly-appended entries are immediately searchable (no rebuild required)', async () => {
    const agent = await connectAgentHost()
    const { convId } = await bootConversation(agent, 'claude:///tmp/staging-live-trigger')

    const first = `firstwave${crypto.randomUUID().slice(0, 8)}`
    await seedTranscript(agent, convId, [{ type: 'user', text: `${first} initial` }])
    const r1 = await search(first)
    expect(r1.hits.length).toBeGreaterThanOrEqual(1)

    const second = `secondwave${crypto.randomUUID().slice(0, 8)}`
    await seedTranscript(agent, convId, [{ type: 'user', text: `${second} appended later` }])
    const r2 = await search(second)
    expect(r2.hits.length).toBeGreaterThanOrEqual(1)
  })
})
