/**
 * HTTP routes for per-user launch profiles.
 *
 *   GET  /api/launch-profiles  -> LaunchProfile[]
 *   PUT  /api/launch-profiles  -> body is the full array; returns { ok, profiles }
 *
 * Both require an authenticated user (any role). Server validates the schema
 * and rejects malformed payloads with 400.
 */

import { Hono } from 'hono'
import { getAuthenticatedUser } from '../auth-routes'
import type { ConversationStore } from '../conversation-store'
import type { StoreDriver } from '../store/types'
import { broadcastLaunchProfilesUpdated } from './broadcast'
import { getLaunchProfilesOrSeed, saveLaunchProfiles } from './storage'

export function createLaunchProfilesRouter(store: StoreDriver, conversationStore: ConversationStore): Hono {
  const app = new Hono()

  app.get('/api/launch-profiles', c => {
    const userName = getAuthenticatedUser(c.req.raw)
    if (!userName) return c.json({ error: 'Not authenticated' }, 401)
    const profiles = getLaunchProfilesOrSeed(store.kv, userName)
    return c.json({ profiles })
  })

  app.put('/api/launch-profiles', async c => {
    const userName = getAuthenticatedUser(c.req.raw)
    if (!userName) return c.json({ error: 'Not authenticated' }, 401)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const profiles = extractProfilesPayload(body)
    if (profiles === undefined) {
      return c.json({ error: 'Expected { profiles: LaunchProfile[] } or LaunchProfile[]' }, 400)
    }

    const res = saveLaunchProfiles(store.kv, userName, profiles)
    if (!res.ok || !res.profiles) {
      return c.json({ error: res.error ?? 'Invalid profile list' }, 400)
    }

    broadcastLaunchProfilesUpdated(conversationStore.getSubscribers(), userName, res.profiles)
    return c.json({ ok: true, profiles: res.profiles })
  })

  return app
}

function extractProfilesPayload(body: unknown): unknown {
  if (Array.isArray(body)) return body
  if (body && typeof body === 'object' && 'profiles' in body) {
    return (body as { profiles: unknown }).profiles
  }
  return undefined
}
