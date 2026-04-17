/**
 * Spawn routes -- /api/spawn, /api/dirs
 */

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { ListDirsResult } from '../../shared/protocol'
import { mapProjectTrust, type SpawnCallerContext } from '../../shared/spawn-permissions'
import { spawnRequestSchema } from '../../shared/spawn-schema'
import { getGlobalSettings } from '../global-settings'
import { getProjectSettings } from '../project-settings'
import type { SessionStore } from '../session-store'
import { dispatchSpawn } from '../spawn-dispatch'
import type { RouteHelpers } from './shared'

export function createSpawnRouter(sessionStore: SessionStore, helpers: RouteHelpers): Hono {
  const { httpHasPermission } = helpers
  const app = new Hono()

  // ─── Spawn ─────────────────────────────────────────────────────────
  app.post('/api/spawn', async c => {
    if (!httpHasPermission(c.req.raw, 'spawn', '*'))
      return c.json({ error: 'Forbidden: spawn permission required' }, 403)

    const parsed = spawnRequestSchema.safeParse(await c.req.json())
    if (!parsed.success) {
      return c.json({ error: parsed.error.message, issues: parsed.error.issues }, 400)
    }
    const body = parsed.data

    // Build caller context for the unified permission gate. MCP callers
    // identify themselves via X-Caller-Session; everything else is dashboard HTTP.
    const callerSessionId = c.req.header('X-Caller-Session')
    const callerSess = callerSessionId ? sessionStore.getSession(callerSessionId) : null
    const callerCwd = callerSess?.cwd ?? null
    const callerTrust = callerCwd ? mapProjectTrust(getProjectSettings(callerCwd)?.trustLevel) : 'trusted'
    const callerContext: SpawnCallerContext = {
      kind: callerSessionId ? 'mcp' : 'http',
      hasSpawnPermission: true, // already validated by httpHasPermission above
      trustLevel: callerTrust,
      cwd: callerCwd,
    }

    const result = await dispatchSpawn(body, {
      sessions: sessionStore,
      getProjectSettings,
      getGlobalSettings,
      callerContext,
      rendezvousCallerSessionId: callerSessionId ?? null,
    })

    if (!result.ok) {
      const status = (result.statusCode ?? 500) as 400 | 403 | 500 | 503
      return c.json({ error: result.error }, status)
    }
    return c.json({ success: true, wrapperId: result.wrapperId, jobId: result.jobId, tmuxSession: result.tmuxSession })
  })

  // ─── Directory listing (agent relay) ───────────────────────────────
  app.get('/api/dirs', async c => {
    if (!httpHasPermission(c.req.raw, 'spawn', '*'))
      return c.json({ error: 'Forbidden: spawn permission required' }, 403)
    const agent = sessionStore.getAgent()
    if (!agent) return c.json({ error: 'No host agent connected' }, 503)

    const dirPath = c.req.query('path') || '/'
    const requestId = randomUUID()

    const result = await new Promise<ListDirsResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        sessionStore.removeDirListener(requestId)
        reject(new Error('Directory listing timed out (5s)'))
      }, 5000)

      sessionStore.addDirListener(requestId, msg => {
        clearTimeout(timeout)
        resolve(msg as ListDirsResult)
      })

      agent.send(JSON.stringify({ type: 'list_dirs', requestId, path: dirPath }))
    })

    if (result.error) return c.json({ error: result.error }, 400)
    return c.json({ path: dirPath, dirs: result.dirs })
  })

  return app
}
