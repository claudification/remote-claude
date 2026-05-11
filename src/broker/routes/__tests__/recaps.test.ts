/**
 * Tests for /api/recaps/* + /r/:token + /shared/public/recap/:token routes.
 *
 * Spins up a real SQLite store in a temp dir (FTS5 + recap tables need
 * the file-based driver, not memory). Initialises the recap orchestrator
 * singleton with no-op broadcaster. Seeds rows directly via the store
 * instead of running the LLM pipeline.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { setRclaudeSecret } from '../../auth-routes'
import { type ConversationStore, createConversationStore } from '../../conversation-store'
import { initRecapOrchestrator } from '../../recap-orchestrator'
import { initShares } from '../../shares'
import { createSqliteDriver } from '../../store/sqlite/driver'
import type { StoreDriver } from '../../store/types'
import { createRecapsRouter } from '../recaps'
import { createRouteHelpers, type RouteHelpers } from '../shared'

const SECRET = 'test-secret-recap-routes'

let tmp: string
let store: StoreDriver
let conversationStore: ConversationStore
let helpers: RouteHelpers
let app: Hono

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${SECRET}` }
}

function jsonHeaders(): Record<string, string> {
  return { ...adminHeaders(), 'Content-Type': 'application/json' }
}

function setup() {
  tmp = mkdtempSync(join(tmpdir(), 'recap-route-test-'))
  store = createSqliteDriver({ type: 'sqlite', dataDir: tmp })
  store.init()
  conversationStore = createConversationStore({ store, enablePersistence: false })
  setRclaudeSecret(SECRET)
  helpers = createRouteHelpers(SECRET)
  initShares({ kv: store.kv, skipTimers: true })

  initRecapOrchestrator({
    cacheDir: tmp,
    brokerStore: store,
    broadcaster: { broadcast: () => {} },
  })

  app = new Hono()
  app.route('/', createRecapsRouter(conversationStore, helpers))
}

function teardown() {
  store.close()
  rmSync(tmp, { recursive: true, force: true })
}

beforeEach(setup)
afterEach(teardown)

function seedRecap(opts: {
  id: string
  projectUri: string
  status?: 'queued' | 'gathering' | 'rendering' | 'done' | 'failed' | 'cancelled'
  markdown?: string
  title?: string
  subtitle?: string
  createdBy?: string
}) {
  const orch = initRecapOrchestrator({
    cacheDir: tmp,
    brokerStore: store,
    broadcaster: { broadcast: () => {} },
  })
  orch.store.insert({
    id: opts.id,
    projectUri: opts.projectUri,
    periodLabel: 'last_7',
    periodStart: 1715000000000,
    periodEnd: 1715600000000,
    timeZone: 'UTC',
    signalsJson: '[]',
    signalsHash: 'abc',
    createdAt: 1715600000000,
    createdBy: opts.createdBy,
  })
  orch.store.update(opts.id, {
    status: opts.status ?? 'done',
    markdown: opts.markdown ?? '# Sample recap\n\nbody',
    title: opts.title ?? 'Sample',
    subtitle: opts.subtitle ?? 'sub',
    completedAt: 1715600000000,
    progress: 100,
    model: 'anthropic/claude-haiku-4.5',
    inputChars: 100,
    inputTokens: 50,
    outputTokens: 25,
    llmCostUsd: 0.0123,
  })
}

describe('GET /api/recaps', () => {
  test('admin sees all recaps', async () => {
    seedRecap({ id: 'recap_a', projectUri: 'claude://default/p/one' })
    seedRecap({ id: 'recap_b', projectUri: 'claude://default/p/two' })
    const res = await app.request('/api/recaps', { headers: adminHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { recaps: Array<{ id: string }> }
    expect(body.recaps.map(r => r.id).sort()).toEqual(['recap_a', 'recap_b'])
  })

  test('cross-project recaps hidden from non-admins', async () => {
    seedRecap({ id: 'recap_x', projectUri: '*' })
    const res = await app.request('/api/recaps')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { recaps: unknown[] }
    expect(body.recaps).toEqual([])
  })

  test('respects ?projectUri filter', async () => {
    seedRecap({ id: 'recap_a', projectUri: 'claude://default/p/one' })
    seedRecap({ id: 'recap_b', projectUri: 'claude://default/p/two' })
    const res = await app.request('/api/recaps?projectUri=' + encodeURIComponent('claude://default/p/one'), {
      headers: adminHeaders(),
    })
    const body = (await res.json()) as { recaps: Array<{ id: string }> }
    expect(body.recaps.map(r => r.id)).toEqual(['recap_a'])
  })
})

describe('GET /api/recaps/:id', () => {
  test('returns full doc to admin', async () => {
    seedRecap({ id: 'recap_a', projectUri: 'claude://default/p' })
    const res = await app.request('/api/recaps/recap_a', { headers: adminHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { recap: { recapId: string; markdown: string } }
    expect(body.recap.recapId).toBe('recap_a')
    expect(body.recap.markdown).toContain('Sample recap')
  })

  test('404 when missing', async () => {
    const res = await app.request('/api/recaps/recap_missing', { headers: adminHeaders() })
    expect(res.status).toBe(404)
  })

  test('403 when user lacks chat:read on project', async () => {
    seedRecap({ id: 'recap_a', projectUri: 'claude://default/p' })
    const res = await app.request('/api/recaps/recap_a')
    expect(res.status).toBe(403)
  })
})

describe('GET /api/recaps/:id/markdown', () => {
  test('no Accept header: renders markdown as HTML', async () => {
    seedRecap({ id: 'recap_a', projectUri: 'claude://default/projects/foo', markdown: '# Hi\nBody' })
    const res = await app.request('/api/recaps/recap_a/markdown', { headers: adminHeaders() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('<h1')
    expect(body).toContain('Hi')
  })

  test('Accept: text/html: renders markdown as HTML', async () => {
    seedRecap({ id: 'recap_b', projectUri: 'claude://default/projects/foo', markdown: '# Test\n\nBody' })
    const res = await app.request('/api/recaps/recap_b/markdown', {
      headers: { ...adminHeaders(), accept: 'text/html' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('<h1')
    expect(body).toContain('Test')
  })

  test('Accept: */*: renders markdown as HTML', async () => {
    seedRecap({ id: 'recap_c', projectUri: 'claude://default/projects/foo', markdown: '# Star\n' })
    const res = await app.request('/api/recaps/recap_c/markdown', {
      headers: { ...adminHeaders(), accept: '*/*' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<h1')
  })

  test('Accept: text/markdown: returns raw markdown without rendering', async () => {
    seedRecap({ id: 'recap_d', projectUri: 'claude://default/projects/foo', markdown: '# Hi\n' })
    const res = await app.request('/api/recaps/recap_d/markdown', {
      headers: { ...adminHeaders(), accept: 'text/markdown' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    expect(res.headers.get('content-disposition')).toBeNull()
    expect(await res.text()).toBe('# Hi\n')
  })

  test('Accept: text/plain: returns raw markdown without rendering', async () => {
    seedRecap({ id: 'recap_e', projectUri: 'claude://default/projects/foo', markdown: '# Plain\n' })
    const res = await app.request('/api/recaps/recap_e/markdown', {
      headers: { ...adminHeaders(), accept: 'text/plain' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    expect(res.headers.get('content-disposition')).toBeNull()
    expect(await res.text()).toBe('# Plain\n')
  })

  test('other Accept header: returns as attachment download', async () => {
    seedRecap({ id: 'recap_f', projectUri: 'claude://default/projects/foo', markdown: '# Download\n' })
    const res = await app.request('/api/recaps/recap_f/markdown', {
      headers: { ...adminHeaders(), accept: 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    const disp = res.headers.get('content-disposition') || ''
    expect(disp).toContain('attachment')
    expect(disp).toMatch(/recap-foo-last_7-\d{4}-\d{2}-\d{2}\.md/)
  })

  test('409 when recap is not done', async () => {
    seedRecap({ id: 'recap_pending', projectUri: 'claude://default/p', status: 'gathering', markdown: undefined })
    const res = await app.request('/api/recaps/recap_pending/markdown', { headers: adminHeaders() })
    expect(res.status).toBe(409)
  })

  test('403 without permission', async () => {
    seedRecap({ id: 'recap_a', projectUri: 'claude://default/p' })
    const res = await app.request('/api/recaps/recap_a/markdown')
    expect(res.status).toBe(403)
  })
})

describe('GET /api/recaps/:id/logs', () => {
  test('returns empty logs when none recorded', async () => {
    seedRecap({ id: 'recap_a', projectUri: 'claude://default/p' })
    const res = await app.request('/api/recaps/recap_a/logs', { headers: adminHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { logs: unknown[] }
    expect(Array.isArray(body.logs)).toBe(true)
  })

  test('403 without permission', async () => {
    seedRecap({ id: 'recap_a', projectUri: 'claude://default/p' })
    const res = await app.request('/api/recaps/recap_a/logs')
    expect(res.status).toBe(403)
  })
})

describe('POST /api/recaps/:id/share', () => {
  test('admin can mint a share token; share is targetKind=recap with no permissions', async () => {
    seedRecap({ id: 'recap_a', projectUri: 'claude://default/p', title: 'My Recap' })
    const res = await app.request('/api/recaps/recap_a/share', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; targetKind: string; targetId: string; shareUrl: string }
    expect(body.token.length).toBeGreaterThan(20)
    expect(body.targetKind).toBe('recap')
    expect(body.targetId).toBe('recap_a')
    expect(body.shareUrl).toContain(`/r/${body.token}`)
  })

  test('honours expiresIn override', async () => {
    seedRecap({ id: 'recap_a', projectUri: 'claude://default/p' })
    const res = await app.request('/api/recaps/recap_a/share', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ expiresIn: 3600_000 }),
    })
    const body = (await res.json()) as { expiresAt: number }
    const skew = Math.abs(body.expiresAt - (Date.now() + 3600_000))
    expect(skew).toBeLessThan(2000)
  })

  test('409 when recap is not done', async () => {
    seedRecap({ id: 'recap_p', projectUri: 'claude://default/p', status: 'rendering', markdown: undefined })
    const res = await app.request('/api/recaps/recap_p/share', {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    })
    expect(res.status).toBe(409)
  })

  test('403 without permission', async () => {
    seedRecap({ id: 'recap_a', projectUri: 'claude://default/p' })
    const res = await app.request('/api/recaps/recap_a/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(403)
  })

  test('404 for unknown recap', async () => {
    const res = await app.request('/api/recaps/recap_missing/share', {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    })
    expect(res.status).toBe(404)
  })
})

describe('GET /shared/public/recap/:token', () => {
  test('public token returns recap markdown + safe metadata', async () => {
    seedRecap({ id: 'recap_a', projectUri: 'claude://default/p', title: 'My Recap', subtitle: 'Phase 4' })
    const created = await app.request('/api/recaps/recap_a/share', {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    })
    const { token } = (await created.json()) as { token: string }

    // Fetch with NO auth -- the token IS the auth.
    // Explicit JSON accept: route defaults to HTML for browsers; tests use the API shape.
    const res = await app.request(`/shared/public/recap/${token}`, {
      headers: { accept: 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.recapId).toBe('recap_a')
    expect(body.title).toBe('My Recap')
    expect(body.subtitle).toBe('Phase 4')
    expect(body.markdown).toContain('Sample recap')
    expect(body).not.toHaveProperty('createdBy')
    expect(body).not.toHaveProperty('projectUri')
  })

  test('404 on invalid token', async () => {
    const res = await app.request('/api/share/recap/notatoken')
    expect(res.status).toBe(404)
  })

  test('400 when token is for a non-recap kind', async () => {
    // Mint a conversation-kind share via the underlying createShare()
    const { createShare } = await import('../../shares')
    const share = createShare({
      project: 'claude://default/p',
      expiresAt: Date.now() + 3600_000,
      createdBy: 'tester',
      // explicit conversation kind
      targetKind: 'conversation',
      targetId: 'conv_x',
    })
    const res = await app.request(`/shared/public/recap/${share.token}`)
    expect(res.status).toBe(400)
  })
})

describe('GET /r/:token', () => {
  test('redirects to canonical /shared/public/recap/:token endpoint', async () => {
    const res = await app.request('/r/abc123')
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') || ''
    expect(loc).toBe('/shared/public/recap/abc123')
  })
})
