import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createAuthToken, createUser, initAuth } from '../auth'
import { type ConversationStore, createConversationStore } from '../conversation-store'
import { createMemoryDriver } from '../store/memory/driver'
import type { StoreDriver } from '../store/types'
import { createLaunchProfilesRouter } from './routes'

const COOKIE_NAME = 'cw-session'

let app: Hono
let store: StoreDriver
let conversationStore: ConversationStore
let USER_A: string
let USER_B: string
let counter = 0

function freshCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'lp-routes-test-'))
}

function asUser(name: string): { Cookie: string } {
  const token = createAuthToken(name)
  return { Cookie: `${COOKIE_NAME}=${token}` }
}

beforeEach(() => {
  initAuth({ cacheDir: freshCacheDir(), skipTimers: true })
  counter++
  USER_A = `user-a-${counter}`
  USER_B = `user-b-${counter}`
  createUser(USER_A)
  createUser(USER_B)

  store = createMemoryDriver()
  store.init()
  conversationStore = createConversationStore({ store, enablePersistence: false })

  app = new Hono()
  app.route('/', createLaunchProfilesRouter(store, conversationStore))
})

describe('GET /api/launch-profiles', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request('/api/launch-profiles')
    expect(res.status).toBe(401)
  })

  it('seeds three profiles on first load', async () => {
    const res = await app.request('/api/launch-profiles', { headers: asUser(USER_A) })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { profiles: unknown[] }
    expect(data.profiles.length).toBe(3)
  })

  it('returns the persisted list after a save', async () => {
    const res1 = await app.request('/api/launch-profiles', { headers: asUser(USER_A) })
    const data1 = (await res1.json()) as { profiles: unknown[] }
    expect(data1.profiles.length).toBe(3)
    const res2 = await app.request('/api/launch-profiles', { headers: asUser(USER_A) })
    const data2 = (await res2.json()) as { profiles: unknown[] }
    expect(data2.profiles).toEqual(data1.profiles)
  })

  it('isolates profiles per user', async () => {
    const jonasRes = await app.request('/api/launch-profiles', { headers: asUser(USER_A) })
    const jonasData = (await jonasRes.json()) as { profiles: { id: string }[] }

    const aliceRes = await app.request('/api/launch-profiles', { headers: asUser(USER_B) })
    const aliceData = (await aliceRes.json()) as { profiles: { id: string }[] }

    expect(jonasData.profiles.length).toBe(3)
    expect(aliceData.profiles.length).toBe(3)
    expect(jonasData.profiles[0]?.id).toBe(aliceData.profiles[0]?.id)
  })
})

describe('PUT /api/launch-profiles', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request('/api/launch-profiles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profiles: [] }),
    })
    expect(res.status).toBe(401)
  })

  it('saves the empty array (user emptied the list)', async () => {
    const res = await app.request('/api/launch-profiles', {
      method: 'PUT',
      headers: { ...asUser(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ profiles: [] }),
    })
    expect(res.status).toBe(200)
    const getRes = await app.request('/api/launch-profiles', { headers: asUser(USER_A) })
    const getData = (await getRes.json()) as { profiles: unknown[] }
    expect(getData.profiles).toEqual([])
  })

  it('rejects a malformed list', async () => {
    const res = await app.request('/api/launch-profiles', {
      method: 'PUT',
      headers: { ...asUser(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ profiles: [{ name: 'NoId' }] }),
    })
    expect(res.status).toBe(400)
  })

  it('accepts a bare array as well as { profiles }', async () => {
    const item = {
      id: 'lp_aaaaaaaa',
      name: 'Mine',
      spawn: { backend: 'claude' as const },
      createdAt: 1,
      updatedAt: 1,
    }
    const res = await app.request('/api/launch-profiles', {
      method: 'PUT',
      headers: { ...asUser(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify([item]),
    })
    expect(res.status).toBe(200)
  })

  it('rejects duplicate names case-insensitively', async () => {
    const items = [
      { id: 'lp_aaaaaaaa', name: 'Opus', spawn: {}, createdAt: 1, updatedAt: 1 },
      { id: 'lp_bbbbbbbb', name: 'opus', spawn: {}, createdAt: 1, updatedAt: 1 },
    ]
    const res = await app.request('/api/launch-profiles', {
      method: 'PUT',
      headers: { ...asUser(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ profiles: items }),
    })
    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: string }
    expect(data.error).toMatch(/duplicate/i)
  })

  it('rejects non-JSON bodies', async () => {
    const res = await app.request('/api/launch-profiles', {
      method: 'PUT',
      headers: { ...asUser(USER_A), 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })
})
