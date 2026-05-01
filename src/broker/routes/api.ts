/**
 * API routes -- push, crashes, files, transcription, settings, project-order
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { parseProjectUri } from '../../shared/project-uri'
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
import { appendSharedFile, dismissSharedFile, mediaTypeToExt, readSharedFiles, storeBlobStreaming } from './blob-store'
import type { RouteHelpers } from './shared'
import { broadcastToSubscribers } from './shared'

export function createApiRouter(
  conversationStore: ConversationStore,
  helpers: RouteHelpers,
  rclaudeSecret: string | undefined,
  cacheDir: string | undefined,
  blobDir: string,
  publicOrigin: string | undefined,
  vapidPublicKey: string | undefined,
): Hono {
  const { httpHasPermission, httpIsAdmin, resolveHttpGrants } = helpers
  const app = new Hono()

  // ─── Model pricing (LiteLLM) ─────────────────────────────────────
  app.get('/api/models', c => c.json({ models: getModels(), fetchedAt: getModelsFetchedAt() }))

  // ─── Server capabilities ───────────────────────────────────────────
  app.get('/api/capabilities', c => c.json({ voice: !!process.env.DEEPGRAM_API_KEY }))

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
    if (!rclaudeSecret || !token || token !== rclaudeSecret) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    if (!isPushConfigured()) return c.json({ error: 'Push not configured (no VAPID keys)' }, 503)

    const rawBody = await c.req.text()
    if (!rawBody) return c.json({ error: 'Empty request body' }, 400)

    let body: { title: string; body: string; sessionId?: string; tag?: string }
    try {
      body = JSON.parse(rawBody)
    } catch {
      return c.json({ error: 'Invalid JSON', received: rawBody.slice(0, 200) }, 400)
    }

    if (!body.title && !body.body) return c.json({ error: 'Need title or body' }, 400)

    const result = await sendPushToAll({
      title: body.title || 'rclaude',
      body: body.body || '',
      conversationId: body.sessionId,
      tag: body.tag,
    })
    return c.json({ success: true, ...result })
  })

  // ─── Crash reports ─────────────────────────────────────────────────
  app.post('/api/crash', async c => {
    if (!cacheDir) return c.json({ error: 'No cache dir configured' }, 503)

    const body = await c.req.json()
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

    const allSessions = conversationStore.getAllConversations()
    const sessionForCwd = allSessions.find(
      s => parseProjectUri(s.project).path === projectPath && s.status === 'active',
    )
    const wrapperSocket = sessionForCwd ? conversationStore.getConversationSocket(sessionForCwd.id) : null
    if (!wrapperSocket) {
      return c.json({ error: 'No active session connected for this project' }, 503)
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

    // Require files permission -- check session CWD if available, else any grant
    const uploadSessionId = c.req.header('x-session-id') || c.req.query('sessionId') || undefined
    const uploadCwd = uploadSessionId ? conversationStore.getConversation(uploadSessionId)?.project : undefined
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
    const sessionId = c.req.header('x-session-id') || c.req.query('sessionId') || undefined
    const sessionProject = sessionId ? conversationStore.getConversation(sessionId)?.project : undefined
    appendSharedFile({
      type: 'file',
      hash,
      filename,
      mediaType,
      project: sessionProject,
      conversationId: sessionId,
      size,
      url,
      createdAt: Date.now(),
    })

    return c.json({ hash, url, filename, mediaType, size })
  })

  // ─── Shared files + clipboard (per-project) ─────────────────────
  app.get('/api/shared-files', c => {
    const projectFilter = c.req.query('project') || c.req.query('cwd')
    const sessionId = c.req.query('sessionId')
    let files = readSharedFiles()
    if (projectFilter) files = files.filter(f => f.project === projectFilter)
    else if (sessionId) files = files.filter(f => f.conversationId === sessionId)
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

    const body = await c.req.json<{ audioUrl?: string; sessionId?: string }>()
    if (!body.audioUrl) return c.json({ error: 'audioUrl required' }, 400)

    console.log(`[transcribe] Fetching audio: ${body.audioUrl}`)
    const audioRes = await fetch(body.audioUrl)
    if (!audioRes.ok) throw new Error(`Failed to fetch audio: ${audioRes.status}`)
    const audioBytes = new Uint8Array(await audioRes.arrayBuffer())
    const ct = audioRes.headers.get('content-type') || 'audio/webm'
    console.log(`[transcribe] Audio: ${audioBytes.byteLength} bytes, type: ${ct}`)

    const keyterms: string[] = []
    if (body.sessionId) {
      const session = conversationStore.getConversation(body.sessionId)
      if (session?.project) {
        const projSettings = getProjectSettings(session.project)
        if (projSettings?.keyterms?.length) {
          keyterms.push(...projSettings.keyterms)
          console.log(`[transcribe] Project keyterms for ${session.project}: ${projSettings.keyterms.join(', ')}`)
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
