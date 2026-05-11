import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchLaunchProfiles, putLaunchProfiles } from './api'

const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('fetchLaunchProfiles', () => {
  it('returns the profiles field on 200', async () => {
    const profiles = [{ id: 'lp_abc', name: 'A', spawn: {}, createdAt: 1, updatedAt: 1 }]
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse(200, { profiles }))
    expect(await fetchLaunchProfiles()).toEqual(profiles)
  })

  it('throws on non-2xx', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }))
    await expect(fetchLaunchProfiles()).rejects.toThrow(/500/)
  })
})

describe('putLaunchProfiles', () => {
  it('returns ok on 200 and forwards the canonical profiles', async () => {
    const profiles = [{ id: 'lp_abc', name: 'A', spawn: {}, createdAt: 1, updatedAt: 1 }]
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse(200, { ok: true, profiles }))
    const out = await putLaunchProfiles(profiles)
    expect(out.ok).toBe(true)
    expect(out.profiles).toEqual(profiles)
  })

  it('returns ok: false on 400 and surfaces the error', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse(400, { error: 'duplicate name: Opus' }))
    const out = await putLaunchProfiles([])
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/duplicate/)
  })

  it('synthesizes an error message when the server returns no JSON', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('not json', { status: 503 }))
    const out = await putLaunchProfiles([])
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/503/)
  })
})
