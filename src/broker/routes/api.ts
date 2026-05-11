/**
 * API routes -- push, crashes, files, transcription, settings, project-order
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { matchProjectUri, tryParseProjectUri } from '../../shared/project-uri'
import { getAuthenticatedUser } from '../auth-routes'
import type { ConversationStore } from '../conversation-store'
import { getGlobalSettings, updateGlobalSettings } from '../global-settings'
import { getModels, getModelsFetchedAt } from '../model-pricing'
import { hasPermissionAnyCwd, resolvePermissions, type UserGrant } from '../permissions'
import { getProjectOrder, type ProjectOrder, setProjectOrder } from '../project-order'
import {
  deleteProjectSettings,
  getAllProjectSettings,
  getProjectSettings,
  setProjectSettings,
} from '../project-settings'
import { addSubscription, getSubscriptionCount, isPushConfigured, removeSubscription, sendPushToAll } from '../push'
import type { StoreDriver } from '../store/types'
import { appendSharedFile, dismissSharedFile, mediaTypeToExt, readSharedFiles, storeBlobStreaming } from './blob-store'
import type { RouteHelpers } from './shared'
import { broadcastToSubscribers } from './shared'

export function createApiRouter(
  conversationStore: ConversationStore,
  store: StoreDriver,
  helpers: RouteHelpers,
  rclaudeSecret: string | undefined,
  cacheDir: string | undefined,
  blobDir: string,
  publicOrigin: string | undefined,
  vapidPublicKey: string | undefined,
): Hono {
  const { httpHasPermission, httpIsAdmin, resolveHttpGrants } = helpers
  const app = new Hono()

  // Clamp a query-string integer to [min, max], falling back to `defaultVal`
  // when the param is absent or NaN. Plain `parseInt(...) || N` corrupts 0
  // into N (because 0 is falsy) -- this helper doesn't.
  function clampInt(raw: string | null, defaultVal: number, min: number, max: number): number {
    if (raw == null || raw === '') return Math.min(Math.max(defaultVal, min), max)
    const n = parseInt(raw, 10)
    if (!Number.isFinite(n)) return Math.min(Math.max(defaultVal, min), max)
    return Math.min(Math.max(n, min), max)
  }

  // ─── Model pricing (LiteLLM) ─────────────────────────────────────
  app.get('/api/models', c => c.json({ models: getModels(), fetchedAt: getModelsFetchedAt() }))

  // ─── Server capabilities ───────────────────────────────────────────
  app.get('/api/capabilities', c => c.json({ voice: !!process.env.DEEPGRAM_API_KEY }))

  // ─── Transcript search (FTS5) ──────────────────────────────────────
  // Free-form search across conversation transcripts. Supports filtering by
  // conversation, project (exact URI or `claude://host/path/*` glob), entry
  // type, and pagination. Each hit may include a sliding window of surrounding
  // entries via windowBefore / windowAfter.
  app.get('/api/search', c => {
    const url = new URL(c.req.raw.url)
    const q = (url.searchParams.get('q') || url.searchParams.get('query') || '').trim()
    if (!q) return c.json({ error: 'Missing q parameter' }, 400)

    const conversationId = url.searchParams.get('conversation') || url.searchParams.get('conversationId') || undefined
    const projectPattern = url.searchParams.get('project') || undefined
    const typesParam = url.searchParams.get('type') || url.searchParams.get('types') || ''
    const types = typesParam
      ? typesParam
          .split(',')
          .map(t => t.trim())
          .filter(Boolean)
      : undefined
    const limit = clampInt(url.searchParams.get('limit'), 20, 1, 100)
    const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
    const windowBefore = clampInt(url.searchParams.get('windowBefore'), 0, 0, 50)
    const windowAfter = clampInt(url.searchParams.get('windowAfter'), 0, 0, 50)

    // Permission filter: collect conversations the caller can read.
    const allConversations = conversationStore.getAllConversations()
    const allowed = helpers
      .filterConversationsByHttpGrants(c.req.raw, allConversations)
      .filter(s => !conversationId || s.id === conversationId)
      .filter(s => !projectPattern || matchProjectUri(projectPattern, s.project))

    if (allowed.length === 0) return c.json({ hits: [], total: 0 })

    // If a single-conversation filter resolves to an unauthorized conversation, deny.
    if (conversationId && !allowed.some(s => s.id === conversationId)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const conversationIds = allowed.map(s => s.id)
    const convMeta = new Map(
      allowed.map(s => [s.id, { project: s.project, title: s.title, description: s.description }]),
    )

    const hits = store.transcripts.search(q, {
      conversationId: conversationId,
      conversationIds: conversationId ? undefined : conversationIds,
      types,
      limit,
      offset,
    })

    const enriched = hits.map(hit => {
      const meta = convMeta.get(hit.conversationId)
      const window =
        windowBefore > 0 || windowAfter > 0
          ? store.transcripts.getWindow(hit.conversationId, {
              aroundSeq: hit.seq,
              before: windowBefore,
              after: windowAfter,
            })
          : undefined
      return {
        ...hit,
        conversation: meta
          ? { id: hit.conversationId, project: meta.project, title: meta.title, description: meta.description }
          : { id: hit.conversationId },
        window,
      }
    })

    return c.json({ hits: enriched, total: hits.length, query: q, limit, offset })
  })

  // ─── Search-index admin (stats + manual rebuild) ──────────────────
  app.get('/api/search-index/stats', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    return c.json(store.transcripts.getIndexStats())
  })

  app.post('/api/search-index/rebuild', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const result = store.transcripts.rebuildIndex()
    return c.json(result)
  })

  // ─── Transcript context window (sliding) ───────────────────────────
  app.get('/api/transcript-window', c => {
    const url = new URL(c.req.raw.url)
    const conversationId = url.searchParams.get('conversation') || url.searchParams.get('conversationId') || ''
    if (!conversationId) return c.json({ error: 'Missing conversation' }, 400)

    const conv = conversationStore.getConversation(conversationId)
    if (!conv) return c.json({ error: 'Conversation not found' }, 404)
    if (!helpers.httpHasPermission(c.req.raw, 'chat:read', conv.project)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const aroundSeqRaw = url.searchParams.get('aroundSeq') || url.searchParams.get('seq')
    const aroundIdRaw = url.searchParams.get('aroundId') || url.searchParams.get('id')
    const aroundSeq = aroundSeqRaw ? parseInt(aroundSeqRaw, 10) : undefined
    const aroundId = aroundIdRaw ? parseInt(aroundIdRaw, 10) : undefined
    if (aroundSeq == null && aroundId == null) {
      return c.json({ error: 'Missing aroundSeq or aroundId' }, 400)
    }
    const before = clampInt(url.searchParams.get('before'), 5, 0, 50)
    const after = clampInt(url.searchParams.get('after'), 5, 0, 50)

    const entries = store.transcripts.getWindow(conversationId, { aroundSeq, aroundId, before, after })
    return c.json({
      entries,
      conversation: { id: conv.id, project: conv.project, title: conv.title, description: conv.description },
    })
  })

  // ─── Push notifications ────────────────────────────────────────────
  app.get('/api/push/vapid', c => {
    if (!vapidPublicKey) return c.json({ error: 'Push not configured' }, 503)
    return c.json({ publicKey: vapidPublicKey, subscriptions: getSubscriptionCount() })
  })

  app.post('/api/push/subscribe', async c => {
    const body = await c.req.json<{
      subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
    }>()
    if (!body.subscription?.endpoint || !body.subscription?.keys) {
      return c.json({ error: 'Invalid subscription' }, 400)
    }
    const pushUser = getAuthenticatedUser(c.req.raw)
    if (!pushUser) return c.json({ error: 'Not authenticated' }, 401)
    addSubscription(pushUser, body.subscription, c.req.header('user-agent'))
    return c.json({ success: true, total: getSubscriptionCount() })
  })

  app.post('/api/push/unsubscribe', async c => {
    const body = await c.req.json<{ endpoint: string }>()
    if (!body.endpoint) return c.json({ error: 'Missing endpoint' }, 400)
    const unsubUser = getAuthenticatedUser(c.req.raw)
    if (!unsubUser) return c.json({ error: 'Not authenticated' }, 401)
    removeSubscription(unsubUser, body.endpoint)
    return c.json({ success: true })
  })

  app.post('/api/push/send', async c => {
    // Extra auth: requires rclaude secret specifically (not just any cookie)
    const authHeader = c.req.header('authorization')
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!rclaudeSecret || !token || token.length !== rclaudeSecret.length) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(rclaudeSecret))) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    if (!isPushConfigured()) return c.json({ error: 'Push not configured (no VAPID keys)' }, 503)

    const rawBody = await c.req.text()
    if (!rawBody) return c.json({ error: 'Empty request body' }, 400)

    let body: { title: string; body: string; conversationId?: string; tag?: string }
    try {
      body = JSON.parse(rawBody)
    } catch {
      return c.json({ error: 'Invalid JSON', received: rawBody.slice(0, 200) }, 400)
    }

    if (!body.title && !body.body) return c.json({ error: 'Need title or body' }, 400)

    const result = await sendPushToAll({
      title: body.title || 'rclaude',
      body: body.body || '',
      conversationId: body.conversationId,
      tag: body.tag,
    })
    return c.json({ success: true, ...result })
  })

  // ─── Crash reports ─────────────────────────────────────────────────
  // Rate limiter for /api/crash: it's a public unauthenticated endpoint
  // (Audit M4). 10 reports per IP per 60s, 64KB max payload.
  const crashRate = new Map<string, { count: number; resetAt: number }>()
  const CRASH_LIMIT = 10
  const CRASH_WINDOW_MS = 60_000
  const CRASH_MAX_BYTES = 64 * 1024

  app.post('/api/crash', async c => {
    if (!cacheDir) return c.json({ error: 'No cache dir configured' }, 503)

    const ip =
      c.req.header('cf-connecting-ip') ||
      c.req.header('x-real-ip') ||
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      'unknown'
    const now = Date.now()
    let bucket = crashRate.get(ip)
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + CRASH_WINDOW_MS }
      crashRate.set(ip, bucket)
    }
    if (bucket.count >= CRASH_LIMIT) {
      return c.json({ error: 'Rate limited' }, 429)
    }
    bucket.count++

    // Opportunistic cleanup of expired buckets to keep the map bounded.
    if (crashRate.size > 1000) {
      for (const [k, v] of crashRate) {
        if (v.resetAt < now) crashRate.delete(k)
      }
    }

    const raw = await c.req.text()
    if (raw.length > CRASH_MAX_BYTES) {
      return c.json({ error: 'Payload too large' }, 413)
    }
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const crashDir = join(cacheDir, 'crashes')
    if (!existsSync(crashDir)) mkdirSync(crashDir, { recursive: true })

    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(crashDir, `crash-${ts}.json`)
    const report = {
      timestamp: new Date().toISOString(),
      userAgent: c.req.header('user-agent') || 'unknown',
      ...(body as Record<string, unknown>),
    }
    writeFileSync(file, JSON.stringify(report, null, 2))

    // Keep only latest 50
    const files = readdirSync(crashDir)
      .filter(f => f.startsWith('crash-') && f.endsWith('.json'))
      .sort()
    if (files.length > 50) {
      for (const old of files.slice(0, files.length - 50)) {
        try {
          unlinkSync(join(crashDir, old))
        } catch {}
      }
    }

    return c.json({ success: true, file: file.split('/').pop() })
  })

  app.get('/api/crashes', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    if (!cacheDir) return c.json([])
    const crashDir = join(cacheDir, 'crashes')
    if (!existsSync(crashDir)) return c.json([])

    const files = readdirSync(crashDir)
      .filter(f => f.startsWith('crash-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 20)
    const reports = files.map(f => {
      try {
        return JSON.parse(readFileSync(join(crashDir, f), 'utf-8'))
      } catch {
        return { file: f, error: 'parse failed' }
      }
    })
    return c.json(reports)
  })

  // ─── Project settings ──────────────────────────────────────────────
  app.get('/api/settings/projects', c => {
    const all = getAllProjectSettings()
    const grants = resolveHttpGrants(c.req.raw)
    if (!grants) return c.json(all) // admin sees all
    const filtered: Record<string, unknown> = {}
    for (const [project, settings] of Object.entries(all)) {
      const { permissions } = resolvePermissions(grants, project)
      if (permissions.has('chat:read')) filtered[project] = settings
    }
    return c.json(filtered)
  })

  app.post('/api/settings/projects', async c => {
    if (!httpHasPermission(c.req.raw, 'settings', '*'))
      return c.json({ error: 'Forbidden: settings permission required' }, 403)
    const body = await c.req.json<{
      project?: string
      cwd?: string
      settings: { label?: string; icon?: string; color?: string }
    }>()
    const project = body.project || body.cwd
    if (!project) return c.json({ error: 'Missing project' }, 400)
    setProjectSettings(project, body.settings || {})
    const allSettings = getAllProjectSettings()
    broadcastToSubscribers(conversationStore, { type: 'project_settings_updated', settings: allSettings })
    return c.json({ success: true, settings: allSettings })
  })

  app.delete('/api/settings/projects', async c => {
    if (!httpHasPermission(c.req.raw, 'settings', '*'))
      return c.json({ error: 'Forbidden: settings permission required' }, 403)
    const body = await c.req.json<{ project?: string; cwd?: string }>()
    const project = body.project || body.cwd
    if (!project) return c.json({ error: 'Missing project' }, 400)
    deleteProjectSettings(project)
    const allSettings = getAllProjectSettings()
    broadcastToSubscribers(conversationStore, { type: 'project_settings_updated', settings: allSettings })
    return c.json({ success: true, settings: allSettings })
  })

  app.post('/api/settings/projects/generate-keyterms', async c => {
    if (!httpHasPermission(c.req.raw, 'settings', '*'))
      return c.json({ error: 'Forbidden: settings permission required' }, 403)
    const openrouterKey = process.env.OPENROUTER_API_KEY
    if (!openrouterKey) return c.json({ error: 'OPENROUTER_API_KEY not configured' }, 500)

    const body = await c.req.json<{ project?: string; cwd?: string }>()
    const projectPath = body.project || body.cwd
    if (!projectPath) return c.json({ error: 'Missing project' }, 400)

    const allConversations = conversationStore.getAllConversations()
    const sessionForCwd = allConversations.find(s => {
      const parsed = tryParseProjectUri(s.project)
      return parsed?.path === projectPath && s.status === 'active'
    })
    const wrapperSocket = sessionForCwd ? conversationStore.getConversationSocket(sessionForCwd.id) : null
    if (!wrapperSocket) {
      return c.json({ error: 'No active conversation connected for this project' }, 503)
    }

    const filesToRead = [
      `${projectPath}/CLAUDE.md`,
      `${projectPath}/.claude/CLAUDE.md`,
      `${projectPath}/package.json`,
      `${projectPath}/README.md`,
    ]

    const fileContents: string[] = []
    for (const filePath of filesToRead) {
      try {
        const content = await new Promise<string | null>((resolve, reject) => {
          const requestId = randomUUID()
          const timeout = setTimeout(() => {
            conversationStore.removeFileListener(requestId)
            reject(new Error(`File read timed out (5s): ${filePath}`))
          }, 5000)

          conversationStore.addFileListener(requestId, raw => {
            clearTimeout(timeout)
            const msg = raw as { data?: string; error?: string }
            if (msg.error || !msg.data) resolve(null)
            else resolve(Buffer.from(msg.data, 'base64').toString('utf-8'))
          })

          wrapperSocket.send(JSON.stringify({ type: 'file_request', requestId, path: filePath }))
        })
        if (content) fileContents.push(`--- ${filePath} ---\n${content.slice(0, 10000)}`)
      } catch {
        // File not found or timeout
      }
    }

    if (fileContents.length === 0) {
      return c.json({ error: 'No project files found (CLAUDE.md, package.json, README.md)' }, 404)
    }

    console.log(`[keyterms] Generating keyterms for ${projectPath} from ${fileContents.length} files`)

    const llmRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openrouterKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        messages: [
          {
            role: 'system',
            content: `Extract domain-specific terms from these project files for voice transcription keyword boosting. Focus on:
- Project names, tool names, library names
- Technical terms specific to this project
- Abbreviations, acronyms, unusual spellings
- Brand names, product names
- Any term a speech-to-text engine would likely misspell

Output a JSON array of strings. Each string should be the correct spelling of one term. Include 10-30 terms, most important first. Only output the JSON array, nothing else.`,
          },
          { role: 'user', content: fileContents.join('\n\n') },
        ],
        max_tokens: 1024,
      }),
    })

    if (!llmRes.ok) {
      const err = await llmRes.text().catch(() => '')
      console.error(`[keyterms] LLM failed: ${llmRes.status} ${err.slice(0, 500)}`)
      return c.json({ error: 'Failed to generate keyterms' }, 500)
    }

    const llmData = (await llmRes.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const raw = llmData.choices?.[0]?.message?.content?.trim() || '[]'
    let keyterms: string[]
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
      keyterms = JSON.parse(cleaned)
      if (!Array.isArray(keyterms)) throw new Error('Not an array')
      keyterms = keyterms.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim())
    } catch {
      console.error(`[keyterms] Failed to parse LLM output: ${raw.slice(0, 200)}`)
      return c.json({ error: 'Failed to parse keyterms from LLM' }, 500)
    }

    console.log(`[keyterms] Generated ${keyterms.length} keyterms: ${keyterms.join(', ')}`)
    setProjectSettings(projectPath, { keyterms })
    return c.json({ keyterms, settings: getAllProjectSettings() })
  })

  // ─── Global settings ───────────────────────────────────────────────
  app.get('/api/settings', c => c.json(getGlobalSettings()))

  app.post('/api/settings', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const body = await c.req.json()
    const result = updateGlobalSettings(body)
    broadcastToSubscribers(conversationStore, { type: 'settings_updated', settings: result.settings })
    return c.json(result)
  })

  // ─── File upload ───────────────────────────────────────────────────
  app.post('/api/files', async c => {
    if (!blobDir) return c.json({ error: 'Blob store not configured' }, 503)

    // Require files permission -- check conversation CWD if available, else any grant
    const uploadConversationId = c.req.header('x-conversation-id') || c.req.query('conversationId') || undefined
    const uploadCwd = uploadConversationId
      ? conversationStore.getConversation(uploadConversationId)?.project
      : undefined
    if (uploadCwd) {
      if (!httpHasPermission(c.req.raw, 'files', uploadCwd))
        return c.json({ error: 'Forbidden: files permission required' }, 403)
    } else {
      const grants = resolveHttpGrants(c.req.raw)
      if (grants !== null && !hasPermissionAnyCwd(grants, 'files'))
        return c.json({ error: 'Forbidden: files permission required' }, 403)
    }

    const contentType = c.req.header('content-type') || ''
    let hash: string
    let size: number
    let mediaType: string
    let filename = 'upload'

    if (contentType.includes('multipart/form-data')) {
      // Multipart: must buffer the form part (no streaming for multipart)
      const formData = await c.req.formData()
      const file = formData.get('file') as File | null
      if (!file) return c.json({ error: 'No file in form data' }, 400)
      mediaType = file.type || 'application/octet-stream'
      filename = file.name || 'upload'
      // Stream the File blob through the hashing pipeline
      const result = await storeBlobStreaming(file.stream(), mediaType)
      hash = result.hash
      size = result.size
    } else {
      // Raw body: stream directly -- O(1) memory
      mediaType = contentType.split(';')[0] || 'application/octet-stream'
      filename = `upload.${mediaTypeToExt(mediaType)}`
      const body = c.req.raw.body
      if (!body) return c.json({ error: 'Empty request body' }, 400)
      const result = await storeBlobStreaming(body, mediaType)
      hash = result.hash
      size = result.size
    }

    const ext = mediaTypeToExt(mediaType)
    const filePath = `/file/${hash}.${ext}`
    const url = publicOrigin
      ? `${publicOrigin}${filePath}`
      : `http://${c.req.header('host') || 'localhost:9999'}${filePath}`

    // Log to shared files index (keyed by project for per-project queries)
    const conversationId = c.req.header('x-conversation-id') || c.req.query('conversationId') || undefined
    const fileProject = conversationId ? conversationStore.getConversation(conversationId)?.project : undefined
    appendSharedFile({
      type: 'file',
      hash,
      filename,
      mediaType,
      project: fileProject,
      conversationId: conversationId,
      size,
      url,
      createdAt: Date.now(),
    })

    return c.json({ hash, url, filename, mediaType, size })
  })

  // ─── Shared files + clipboard (per-project) ─────────────────────
  app.get('/api/shared-files', c => {
    const projectFilter = c.req.query('project') || c.req.query('cwd')
    const conversationId = c.req.query('conversationId')
    let files = readSharedFiles()
    if (projectFilter) files = files.filter(f => f.project === projectFilter)
    else if (conversationId) files = files.filter(f => f.conversationId === conversationId)
    // Filter by projects the caller can access
    const grants = resolveHttpGrants(c.req.raw)
    if (grants) {
      files = files.filter(f => {
        if (!f.project) return false
        const { permissions } = resolvePermissions(grants, f.project)
        return permissions.has('chat:read')
      })
    }
    return c.json({ files })
  })

  app.delete('/api/shared-files/:hash', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const hash = c.req.param('hash')
    const ok = dismissSharedFile(hash)
    return c.json({ ok })
  })

  // Filter a project-order tree to only include nodes the grants can read.
  function filterProjectOrderTree(nodes: ProjectOrder['tree'], grants: UserGrant[]): ProjectOrder['tree'] {
    const result: ProjectOrder['tree'] = []
    for (const node of nodes) {
      if (node.type === 'project') {
        const projectUri = node.id
        const { permissions } = resolvePermissions(grants, projectUri)
        if (permissions.has('chat:read')) result.push(node)
      } else if (node.type === 'group') {
        const children = filterProjectOrderTree(node.children, grants)
        if (children.length > 0) result.push({ ...node, children })
      }
    }
    return result
  }

  // ─── Project order ─────────────────────────────────────────────────
  app.get('/api/project-order', c => {
    const order = getProjectOrder()
    const grants = resolveHttpGrants(c.req.raw)
    if (!grants) return c.json(order) // admin sees full tree
    return c.json({ ...order, tree: filterProjectOrderTree(order.tree, grants) })
  })

  app.post('/api/project-order', async c => {
    if (!httpHasPermission(c.req.raw, 'settings', '*'))
      return c.json({ error: 'Forbidden: settings permission required' }, 403)
    const body = await c.req.json<{ tree: unknown[] }>()
    if (!Array.isArray(body.tree)) {
      return c.json({ error: 'Invalid project order: expected { tree: [...] }' }, 400)
    }
    setProjectOrder(body as ProjectOrder)
    const order = getProjectOrder()
    // Broadcast filtered order per subscriber's grants
    for (const ws of conversationStore.getSubscribers()) {
      try {
        const wsGrants = (ws.data as { grants?: UserGrant[] }).grants
        const scopedOrder = wsGrants ? { ...order, tree: filterProjectOrderTree(order.tree, wsGrants) } : order
        ws.send(JSON.stringify({ type: 'project_order_updated', order: scopedOrder }))
      } catch {
        /* dead socket */
      }
    }
    return c.json({ success: true, order })
  })

  // ─── Transcribe ────────────────────────────────────────────────────
  app.post('/api/transcribe', async c => {
    if (!httpHasPermission(c.req.raw, 'voice', '*'))
      return c.json({ error: 'Forbidden: voice permission required' }, 403)
    const deepgramKey = process.env.DEEPGRAM_API_KEY
    if (!deepgramKey) {
      console.error('[transcribe] DEEPGRAM_API_KEY not configured')
      return c.json({ error: 'DEEPGRAM_API_KEY not configured' }, 500)
    }

    const body = await c.req.json<{ audioUrl?: string; conversationId?: string }>()
    if (!body.audioUrl) return c.json({ error: 'audioUrl required' }, 400)

    console.log(`[transcribe] Fetching audio: ${body.audioUrl}`)
    const audioRes = await fetch(body.audioUrl)
    if (!audioRes.ok) throw new Error(`Failed to fetch audio: ${audioRes.status}`)
    const audioBytes = new Uint8Array(await audioRes.arrayBuffer())
    const ct = audioRes.headers.get('content-type') || 'audio/webm'
    console.log(`[transcribe] Audio: ${audioBytes.byteLength} bytes, type: ${ct}`)

    const keyterms: string[] = []
    if (body.conversationId) {
      const conv = conversationStore.getConversation(body.conversationId)
      if (conv?.project) {
        const projSettings = getProjectSettings(conv.project)
        if (projSettings?.keyterms?.length) {
          keyterms.push(...projSettings.keyterms)
          console.log(`[transcribe] Project keyterms for ${conv.project}: ${projSettings.keyterms.join(', ')}`)
        }
      }
    }

    const params = new URLSearchParams({
      model: 'nova-3',
      smart_format: 'true',
      punctuate: 'true',
      filler_words: 'false',
      diarize: 'false',
      language: 'en',
    })
    for (const kt of keyterms) params.append('keyterm', kt)

    console.log('[transcribe] Calling Deepgram Nova-3...')
    const dgRes = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${deepgramKey}`, 'Content-Type': ct },
      body: audioBytes,
    })

    if (!dgRes.ok) {
      const err = await dgRes.text()
      console.error(`[transcribe] Deepgram failed: ${dgRes.status} ${err.slice(0, 500)}`)
      throw new Error(`Deepgram transcription failed: ${dgRes.status}`)
    }

    const dgData = (await dgRes.json()) as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> }
    }
    const rawText = dgData.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || ''
    console.log(`[transcribe] Result: "${rawText.slice(0, 200)}"${rawText.length > 200 ? '...' : ''}`)

    if (!rawText.trim()) return c.json({ raw: '', refined: '' })
    return c.json({ raw: rawText, refined: rawText })
  })

  return app
}
