/**
 * Hono HTTP Routes for Concentrator
 * Replaces hand-rolled routing in api.ts and auth-routes.ts
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { ListDirsResult, SendInput, Session, SpawnResult, TeamInfo } from '../shared/protocol'
import { handleAuthRoute, requireAuth } from './auth-routes'
import { getGlobalSettings, updateGlobalSettings } from './global-settings'
import { resolveInJail } from './path-jail'
import {
  deleteProjectSettings,
  getAllProjectSettings,
  getProjectSettings,
  setProjectSettings,
} from './project-settings'
import { addSubscription, getSubscriptionCount, isPushConfigured, removeSubscription, sendPushToAll } from './push'
import { getSessionOrder, type SessionOrderV2, setSessionOrder } from './session-order'
import type { SessionStore } from './session-store'
import { UI_HTML } from './ui'

// ─── Image/Blob Store (disk-only, survives restarts) ────────────────────

let blobDir = '' // set by initBlobStore()

const BLOB_MAX_AGE_MS = 48 * 60 * 60 * 1000 // 48h TTL

function initBlobStore(cacheDir: string): void {
  blobDir = join(cacheDir, 'blobs')
  mkdirSync(blobDir, { recursive: true })
  // Count existing blobs
  try {
    const count = readdirSync(blobDir).filter(f => f.endsWith('.meta')).length
    if (count > 0) console.log(`[blobs] ${count} blobs on disk`)
  } catch {
    /* empty dir */
  }
}

// Evict expired blobs from disk hourly
setInterval(
  () => {
    if (!blobDir) return
    const now = Date.now()
    let evicted = 0
    try {
      for (const file of readdirSync(blobDir)) {
        if (!file.endsWith('.meta')) continue
        try {
          const meta = JSON.parse(readFileSync(join(blobDir, file), 'utf8'))
          if (now - meta.createdAt > BLOB_MAX_AGE_MS) {
            const hash = file.replace('.meta', '')
            try {
              unlinkSync(join(blobDir, hash))
            } catch {}
            try {
              unlinkSync(join(blobDir, file))
            } catch {}
            evicted++
          }
        } catch {
          /* corrupt meta */
        }
      }
    } catch {
      /* dir gone */
    }
    if (evicted > 0) console.log(`[blobs] Evicted ${evicted} expired blobs`)
  },
  60 * 60 * 1000,
)

function hashString(input: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(input)
  const bytes = hasher.digest()
  // Read 8 bytes as BigInt, convert to base36 for shorter URLs
  const n = bytes.readBigUInt64BE(0)
  return n.toString(36) // ~12-13 chars base36, ~10^19 combinations
}

export function registerFilePath(path: string): string {
  if (!blobDir) return hashString(path)
  // Copy file to blob store so it survives even if source disappears
  const hash = hashString(path)
  const blobPath = join(blobDir, hash)
  if (!existsSync(blobPath)) {
    try {
      const ext = path.split('.').pop()?.toLowerCase() || 'png'
      const mediaType = `image/${ext === 'jpg' ? 'jpeg' : ext}`
      writeFileSync(blobPath, readFileSync(path))
      writeFileSync(`${blobPath}.meta`, JSON.stringify({ mediaType, createdAt: Date.now() }))
    } catch {
      /* source file might not exist yet */
    }
  }
  return hash
}

export function registerBlob(data: string, mediaType: string): string {
  const key = `${data.length}:${data.slice(0, 200)}`
  const hash = hashString(key)
  if (blobDir) {
    const blobPath = join(blobDir, hash)
    if (!existsSync(blobPath)) {
      const bytes = Buffer.from(data, 'base64')
      writeFileSync(blobPath, bytes)
      writeFileSync(`${blobPath}.meta`, JSON.stringify({ mediaType, createdAt: Date.now() }))
    }
  }
  return hash
}

function storeBlobDirect(hash: string, bytes: Uint8Array, mediaType: string): void {
  if (!blobDir) return
  const blobPath = join(blobDir, hash)
  if (!existsSync(blobPath)) {
    writeFileSync(blobPath, bytes)
    writeFileSync(`${blobPath}.meta`, JSON.stringify({ mediaType, createdAt: Date.now() }))
  }
}

// ─── Shared files log ─────────────────────────────────────────────
interface SharedFileEntry {
  hash: string
  filename: string
  mediaType: string
  sessionId?: string
  size: number
  url: string
  createdAt: number
}

let sharedFilesLogPath: string | null = null
const SHARED_FILES_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

function initSharedFilesLog(cacheDir: string): void {
  sharedFilesLogPath = join(cacheDir, 'shared-files.jsonl')
}

function appendSharedFile(entry: SharedFileEntry): void {
  if (!sharedFilesLogPath) return
  try {
    appendFileSync(sharedFilesLogPath, `${JSON.stringify(entry)}\n`)
  } catch {
    // First write or permission issue
  }
}

function readSharedFiles(): SharedFileEntry[] {
  if (!sharedFilesLogPath || !existsSync(sharedFilesLogPath)) return []
  try {
    const cutoff = Date.now() - SHARED_FILES_MAX_AGE_MS
    return readFileSync(sharedFilesLogPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as SharedFileEntry)
      .filter(e => e.createdAt > cutoff)
      .reverse() // newest first
  } catch {
    return []
  }
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'svg']

function mediaTypeToExt(mediaType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/heic': 'heic',
    'image/svg+xml': 'svg',
  }
  return map[mediaType] || 'png'
}

export function processImagesInEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const images: Array<{ hash: string; ext: string; url: string; originalPath: string }> = []
  let modified = false

  const msg = entry?.message as Record<string, unknown> | undefined
  const content = msg?.content
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const block = content[i] as Record<string, unknown> | undefined
      const source = block?.source as Record<string, unknown> | undefined
      if (block?.type === 'image' && source?.type === 'base64' && source?.data && source?.media_type) {
        const mt = source.media_type as string
        const ext = mediaTypeToExt(mt)
        const hash = registerBlob(source.data as string, mt)
        images.push({ hash, ext, url: `/file/${hash}.${ext}`, originalPath: `inline:${mt}` })
        if (!modified) {
          entry = { ...entry, message: { ...msg, content: [...content] } }
          modified = true
        }
        const entryMsg = entry.message as Record<string, unknown>
        ;(entryMsg.content as unknown[])[i] = { type: 'text', text: `[Image: ${hash}.${ext}]` }
      }
    }
  }

  const imagePattern = /\[Image:\s*source:\s*([^\]]+)\]/gi
  function scanText(value: unknown): void {
    if (typeof value === 'string') {
      let match: RegExpExecArray | null = imagePattern.exec(value)
      while (match !== null) {
        const imagePath = match[1].trim()
        const ext = imagePath.split('.').pop()?.toLowerCase() || 'png'
        if (IMAGE_EXTENSIONS.includes(ext)) {
          const hash = registerFilePath(imagePath)
          if (!images.some(img => img.hash === hash)) {
            images.push({ hash, ext, url: `/file/${hash}.${ext}`, originalPath: imagePath })
          }
        }
        match = imagePattern.exec(value)
      }
    } else if (Array.isArray(value)) {
      value.forEach(scanText)
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(scanText)
    }
  }
  scanText(entry)

  if (images.length > 0) return { ...entry, images }
  return entry
}

// ─── MIME types ────────────────────────────────────────────────────────

function getMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  const mimeTypes: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    heic: 'image/heic',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    pdf: 'application/pdf',
  }
  return mimeTypes[ext || ''] || 'application/octet-stream'
}

// ─── Embedded files (compiled into binary) ─────────────────────────────

type EmbeddedBlob = Blob & { name: string }
const embeddedFiles = new Map<string, Blob>()
const hasEmbeddedWeb = typeof Bun !== 'undefined' && (Bun.embeddedFiles as EmbeddedBlob[])?.length > 0

if (hasEmbeddedWeb) {
  for (const blob of Bun.embeddedFiles as EmbeddedBlob[]) {
    const name = blob.name.replace(/-[a-f0-9]+\./, '.')
    embeddedFiles.set(name, blob)
    if (blob.name.startsWith('lib/') || blob.name.includes('/lib/')) {
      const libPath = blob.name.includes('/lib/') ? blob.name.substring(blob.name.indexOf('/lib/') + 1) : blob.name
      embeddedFiles.set(libPath, blob)
    }
  }
}

// ─── Session overview helper ───────────────────────────────────────────

interface SessionOverview {
  id: string
  cwd: string
  model?: string
  status: Session['status']
  wrapperIds: string[]
  startedAt: number
  lastActivity: number
  eventCount: number
  activeSubagentCount: number
  totalSubagentCount: number
  team?: TeamInfo
  summary?: string
  title?: string
  agentName?: string
  prLinks?: Session['prLinks']
  lastEvent?: { hookEvent: string; timestamp: number }
}

function sessionToOverview(session: Session, sessionStore: SessionStore): SessionOverview {
  const lastEvent = session.events[session.events.length - 1]
  return {
    id: session.id,
    cwd: session.cwd,
    model: session.model,
    status: session.status,
    wrapperIds: sessionStore.getWrapperIds(session.id),
    startedAt: session.startedAt,
    lastActivity: session.lastActivity,
    eventCount: session.events.length,
    activeSubagentCount: session.subagents.filter(a => a.status === 'running').length,
    totalSubagentCount: session.subagents.length,
    team: session.team,
    summary: session.summary,
    title: session.title,
    agentName: session.agentName,
    prLinks: session.prLinks,
    lastEvent: lastEvent ? { hookEvent: lastEvent.hookEvent, timestamp: lastEvent.timestamp } : undefined,
  }
}

// ─── Broadcast helper ──────────────────────────────────────────────────

function broadcastToSubscribers(sessionStore: SessionStore, message: Record<string, unknown>) {
  const json = JSON.stringify(message)
  for (const ws of sessionStore.getSubscribers()) {
    try {
      ws.send(json)
    } catch {
      /* dead socket */
    }
  }
}

// ─── Route factory ─────────────────────────────────────────────────────

export interface RouteOptions {
  sessionStore: SessionStore
  webDir?: string
  vapidPublicKey?: string
  rclaudeSecret?: string
  cacheDir?: string
  serverStartTime?: number
  publicOrigin?: string // public base URL from --origin (e.g. "https://your-host.example.com")
}

export function createRouter(options: RouteOptions): Hono {
  const { sessionStore, webDir, vapidPublicKey, rclaudeSecret, cacheDir, serverStartTime = Date.now(), publicOrigin } = options

  // Initialize disk-backed blob store + shared files log
  if (cacheDir) {
    initBlobStore(cacheDir)
    initSharedFilesLog(cacheDir)
  }

  const app = new Hono()

  // ─── Auth middleware ───────────────────────────────────────────────
  // Auth routes are handled first (before middleware), then requireAuth blocks the rest
  app.use('*', async (c, next) => {
    // Auth routes handled by dedicated route group below
    if (c.req.path.startsWith('/auth/')) return next()

    // requireAuth returns a Response if blocked, null if allowed
    const block = requireAuth(c.req.raw)
    if (block) return block

    return next()
  })

  // ─── Auth routes (/auth/*) ─────────────────────────────────────────
  app.all('/auth/*', async c => {
    const response = await handleAuthRoute(c.req.raw)
    if (response) return response
    return c.json({ error: 'Not found' }, 404)
  })

  // ─── Health check ──────────────────────────────────────────────────
  app.get('/health', c => c.text('ok'))

  // ─── Server capabilities ───────────────────────────────────────────
  app.get('/api/capabilities', c => c.json({ voice: !!process.env.DEEPGRAM_API_KEY }))

  // ─── File serving by hash ──────────────────────────────────────────
  app.get('/file/:hash', async c => {
    if (!blobDir) return new Response(null, { status: 503 })
    const hash = c.req.param('hash').replace(/\.[a-z]+$/i, '') // strip extension
    const blobPath = join(blobDir, hash)
    const metaPath = `${blobPath}.meta`

    const file = Bun.file(blobPath)
    if (!(await file.exists())) return new Response(null, { status: 404 })

    let mediaType = 'application/octet-stream'
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      mediaType = meta.mediaType || mediaType
    } catch {
      /* no meta, use generic type */
    }

    return new Response(file, {
      headers: { 'Content-Type': mediaType, 'Cache-Control': 'public, max-age=86400' },
    })
  })

  // ─── Sessions ──────────────────────────────────────────────────────
  app.get('/sessions', c => {
    const activeOnly = c.req.query('active') === 'true'
    const sessions = activeOnly ? sessionStore.getActiveSessions() : sessionStore.getAllSessions()
    return c.json(sessions.map(s => sessionToOverview(s, sessionStore)))
  })

  app.get('/sessions/:id', c => {
    const session = sessionStore.getSession(c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    return c.json(sessionToOverview(session, sessionStore))
  })

  app.get('/sessions/:id/events', c => {
    const sessionId = c.req.param('id')
    const limit = parseInt(c.req.query('limit') || '0', 10)
    const since = parseInt(c.req.query('since') || '0', 10)
    const events = sessionStore.getSessionEvents(sessionId, limit || undefined, since || undefined)
    if (events.length === 0 && !sessionStore.getSession(sessionId)) {
      return c.json({ error: 'Session not found' }, 404)
    }
    return c.json(events)
  })

  app.get('/sessions/:id/subagents', c => {
    const session = sessionStore.getSession(c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    return c.json(session.subagents)
  })

  app.get('/sessions/:id/transcript', c => {
    const sessionId = c.req.param('id')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    const limit = parseInt(c.req.query('limit') || '20', 10)
    if (!sessionStore.hasTranscriptCache(sessionId)) {
      return c.json({ error: 'No transcript in cache (rclaude not streaming yet?)' }, 404)
    }
    const entries = sessionStore.getTranscriptEntries(sessionId, limit)
    return c.json(entries.map(e => processImagesInEntry(e as Record<string, unknown>)))
  })

  app.get('/sessions/:id/subagents/:agentId/transcript', c => {
    const sessionId = c.req.param('id')
    const agentId = c.req.param('agentId')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    const limit = parseInt(c.req.query('limit') || '100', 10)
    if (!sessionStore.hasSubagentTranscriptCache(sessionId, agentId)) {
      return c.json({ error: 'No subagent transcript in cache' }, 404)
    }
    const entries = sessionStore.getSubagentTranscriptEntries(sessionId, agentId, limit)
    return c.json(entries.map(e => processImagesInEntry(e as Record<string, unknown>)))
  })

  app.get('/sessions/:id/diag', c => {
    const sessionId = c.req.param('id')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    return c.json({
      id: sessionId,
      cwd: session.cwd,
      model: session.model,
      status: session.status,
      wrapperIds: sessionStore.getWrapperIds(sessionId),
      capabilities: session.capabilities,
      version: session.version,
      buildTime: session.buildTime,
      startedAt: session.startedAt,
      lastActivity: session.lastActivity,
      compacting: session.compacting,
      compactedAt: session.compactedAt,
      eventCount: session.events.length,
      transcriptCacheEntries: sessionStore.getTranscriptEntries(sessionId).length,
      subagents: session.subagents,
      tasks: session.tasks,
      bgTasks: session.bgTasks,
      teammates: session.teammates,
      team: session.team,
      args: session.args,
      diagLog: session.diagLog,
    })
  })

  app.get('/sessions/:id/tasks', c => {
    const session = sessionStore.getSession(c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    return c.json({ tasks: session.tasks, archivedTasks: session.archivedTasks })
  })

  app.post('/sessions/:id/input', async c => {
    const sessionId = c.req.param('id')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (session.status === 'ended') return c.json({ error: 'Session has ended' }, 400)

    const ws = sessionStore.getSessionSocket(sessionId)
    if (!ws) return c.json({ error: 'Session not connected' }, 400)

    const body = await c.req.json<{ input: string; crDelay?: number }>()
    if (!body.input || typeof body.input !== 'string') return c.json({ error: 'Missing input field' }, 400)

    const inputMsg: SendInput = {
      type: 'input',
      sessionId,
      input: body.input,
      ...(typeof body.crDelay === 'number' && body.crDelay > 0 && { crDelay: body.crDelay }),
    }
    ws.send(JSON.stringify(inputMsg))
    return c.json({ success: true })
  })

  app.post('/sessions/:id/revive', async c => {
    const sessionId = c.req.param('id')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (session.status === 'active') return c.json({ error: 'Session is already active' }, 400)

    const agent = sessionStore.getAgent()
    if (!agent) return c.json({ error: 'No host agent connected' }, 503)

    const wrapperId = randomUUID()
    agent.send(JSON.stringify({ type: 'revive', sessionId, cwd: session.cwd, wrapperId }))
    return c.json({ success: true, message: 'Revive command sent to agent', wrapperId }, 202)
  })

  app.delete('/sessions/:id', c => {
    const sessionId = c.req.param('id')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (session.status !== 'ended') return c.json({ error: 'Only ended sessions can be dismissed' }, 400)
    sessionStore.removeSession(sessionId)
    broadcastToSubscribers(sessionStore, { type: 'session_dismissed', sessionId })
    return c.json({ success: true })
  })

  // ─── Agent ─────────────────────────────────────────────────────────
  app.get('/agent/status', c => {
    const connected = sessionStore.hasAgent()
    const info = sessionStore.getAgentInfo()
    return c.json({ connected, machineId: info?.machineId, hostname: info?.hostname })
  })

  app.post('/agent/quit', c => {
    const agent = sessionStore.getAgent()
    if (!agent) return c.json({ error: 'No agent connected' }, 404)
    agent.send(JSON.stringify({ type: 'quit', reason: 'Requested via API' }))
    return c.json({ success: true })
  })

  app.get('/api/agent/diag', c => {
    const info = sessionStore.getAgentInfo()
    return c.json({
      connected: sessionStore.hasAgent(),
      machineId: info?.machineId,
      hostname: info?.hostname,
      entries: sessionStore.getAgentDiag(),
    })
  })

  // ─── Spawn ─────────────────────────────────────────────────────────
  app.post('/api/spawn', async c => {
    const agent = sessionStore.getAgent()
    if (!agent) return c.json({ error: 'No host agent connected' }, 503)

    const body = await c.req.json<{ cwd: string; mkdir?: boolean }>()
    if (!body.cwd || typeof body.cwd !== 'string') return c.json({ error: 'Missing cwd field' }, 400)

    const requestId = randomUUID()
    const wrapperId = randomUUID()

    const result = await new Promise<SpawnResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        sessionStore.removeSpawnListener(requestId)
        reject(new Error('Spawn timed out (15s)'))
      }, 15000)

      sessionStore.addSpawnListener(requestId, msg => {
        clearTimeout(timeout)
        resolve(msg as SpawnResult)
      })

      agent.send(JSON.stringify({ type: 'spawn', requestId, cwd: body.cwd, wrapperId, mkdir: body.mkdir || false }))
    })

    if (result.success) {
      return c.json({ success: true, wrapperId, tmuxSession: result.tmuxSession })
    }
    return c.json({ error: result.error || 'Spawn failed' }, 500)
  })

  // ─── Directory listing (agent relay) ───────────────────────────────
  app.get('/api/dirs', async c => {
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
    addSubscription(body.subscription, c.req.header('user-agent'))
    return c.json({ success: true, total: getSubscriptionCount() })
  })

  app.post('/api/push/unsubscribe', async c => {
    const body = await c.req.json<{ endpoint: string }>()
    if (!body.endpoint) return c.json({ error: 'Missing endpoint' }, 400)
    removeSubscription(body.endpoint)
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
      sessionId: body.sessionId,
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
  app.get('/api/settings/projects', c => c.json(getAllProjectSettings()))

  app.post('/api/settings/projects', async c => {
    const body = await c.req.json<{ cwd: string; settings: { label?: string; icon?: string; color?: string } }>()
    if (!body.cwd) return c.json({ error: 'Missing cwd' }, 400)
    setProjectSettings(body.cwd, body.settings || {})
    const allSettings = getAllProjectSettings()
    broadcastToSubscribers(sessionStore, { type: 'project_settings_updated', settings: allSettings })
    return c.json({ success: true, settings: allSettings })
  })

  app.delete('/api/settings/projects', async c => {
    const body = await c.req.json<{ cwd: string }>()
    if (!body.cwd) return c.json({ error: 'Missing cwd' }, 400)
    deleteProjectSettings(body.cwd)
    const allSettings = getAllProjectSettings()
    broadcastToSubscribers(sessionStore, { type: 'project_settings_updated', settings: allSettings })
    return c.json({ success: true, settings: allSettings })
  })

  app.post('/api/settings/projects/generate-keyterms', async c => {
    const openrouterKey = process.env.OPENROUTER_API_KEY
    if (!openrouterKey) return c.json({ error: 'OPENROUTER_API_KEY not configured' }, 500)

    const body = await c.req.json<{ cwd: string }>()
    if (!body.cwd) return c.json({ error: 'Missing cwd' }, 400)

    const allSessions = sessionStore.getAllSessions()
    const sessionForCwd = allSessions.find(s => s.cwd === body.cwd && s.status === 'active')
    const wrapperSocket = sessionForCwd ? sessionStore.getSessionSocket(sessionForCwd.id) : null
    if (!wrapperSocket) {
      return c.json({ error: 'No active session connected for this project' }, 503)
    }

    const filesToRead = [
      `${body.cwd}/CLAUDE.md`,
      `${body.cwd}/.claude/CLAUDE.md`,
      `${body.cwd}/package.json`,
      `${body.cwd}/README.md`,
    ]

    const fileContents: string[] = []
    for (const filePath of filesToRead) {
      try {
        const content = await new Promise<string | null>((resolve, reject) => {
          const requestId = randomUUID()
          const timeout = setTimeout(() => {
            sessionStore.removeFileListener(requestId)
            reject(new Error(`File read timed out (5s): ${filePath}`))
          }, 5000)

          sessionStore.addFileListener(requestId, raw => {
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

    console.log(`[keyterms] Generating keyterms for ${body.cwd} from ${fileContents.length} files`)

    const llmRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openrouterKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4-5-20251001',
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
    setProjectSettings(body.cwd, { keyterms })
    return c.json({ keyterms, settings: getAllProjectSettings() })
  })

  // ─── Global settings ───────────────────────────────────────────────
  app.get('/api/settings', c => c.json(getGlobalSettings()))

  app.post('/api/settings', async c => {
    const body = await c.req.json()
    const result = updateGlobalSettings(body)
    broadcastToSubscribers(sessionStore, { type: 'settings_updated', settings: result.settings })
    return c.json(result)
  })

  // ─── File upload ───────────────────────────────────────────────────
  app.post('/api/files', async c => {
    const contentType = c.req.header('content-type') || ''
    let bytes: Uint8Array
    let mediaType: string
    let filename = 'image'

    if (contentType.includes('multipart/form-data')) {
      const formData = await c.req.formData()
      const file = formData.get('file') as File | null
      if (!file) return c.json({ error: 'No file in form data' }, 400)
      bytes = new Uint8Array(await file.arrayBuffer())
      mediaType = file.type || 'image/png'
      filename = file.name || 'image'
    } else {
      bytes = new Uint8Array(await c.req.arrayBuffer())
      mediaType = contentType.split(';')[0] || 'image/png'
      const ext = mediaType.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
      filename = `paste.${ext}`
    }

    const key = `${bytes.length}:${Array.from(bytes.slice(0, 200)).join(',')}`
    const hash = hashString(key)
    storeBlobDirect(hash, bytes, mediaType)

    const ext = mediaType.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    const filePath = `/file/${hash}.${ext}`
    const url = publicOrigin
      ? `${publicOrigin}${filePath}`
      : `http://${c.req.header('host') || 'localhost:9999'}${filePath}`

    // Log to shared files index
    const sessionId = c.req.header('x-session-id') || c.req.query('sessionId') || undefined
    appendSharedFile({ hash, filename, mediaType, sessionId, size: bytes.length, url, createdAt: Date.now() })

    return c.json({ hash, url, filename, mediaType })
  })

  // ─── Shared files ─────────────────────────────────────────────────
  app.get('/api/shared-files', c => {
    const sessionId = c.req.query('sessionId')
    let files = readSharedFiles()
    if (sessionId) files = files.filter(f => f.sessionId === sessionId)
    return c.json({ files })
  })

  // ─── Session order ─────────────────────────────────────────────────
  app.get('/api/session-order', c => c.json(getSessionOrder()))

  app.post('/api/session-order', async c => {
    const body = await c.req.json<{ version: number; tree: unknown[] }>()
    if (body.version !== 2 || !Array.isArray(body.tree)) {
      return c.json({ error: 'Invalid session order: expected { version: 2, tree: [...] }' }, 400)
    }
    setSessionOrder(body as SessionOrderV2)
    const order = getSessionOrder()
    broadcastToSubscribers(sessionStore, { type: 'session_order_updated', order })
    return c.json({ success: true, order })
  })

  // ─── Transcribe ────────────────────────────────────────────────────
  app.post('/api/transcribe', async c => {
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
      const session = sessionStore.getSession(body.sessionId)
      if (session?.cwd) {
        const projSettings = getProjectSettings(session.cwd)
        if (projSettings?.keyterms?.length) {
          keyterms.push(...projSettings.keyterms)
          console.log(`[transcribe] Project keyterms for ${session.cwd}: ${projSettings.keyterms.join(', ')}`)
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

  // ─── Stats ─────────────────────────────────────────────────────────
  app.get('/api/stats', c => {
    const allSessions = sessionStore.getAllSessions()
    let active = 0
    let idle = 0
    let ended = 0
    for (const s of allSessions) {
      if (s.status === 'active') active++
      else if (s.status === 'idle') idle++
      else ended++
    }

    const diag = sessionStore.getSubscriptionsDiag()
    const traffic = sessionStore.getTrafficStats()

    return c.json({
      uptime: Math.round((Date.now() - serverStartTime) / 1000),
      sessions: { total: allSessions.length, active, idle, ended },
      connections: {
        total: diag.summary.totalSubscribers,
        legacy: diag.summary.legacySubscribers,
        v2: diag.summary.v2Subscribers,
      },
      traffic,
      channels: diag.summary.channelCounts,
    })
  })

  app.get('/api/subscriptions', c => c.json(sessionStore.getSubscriptionsDiag()))

  // ─── Static file serving ───────────────────────────────────────────

  // Embedded web dashboard (compiled into binary)
  if (hasEmbeddedWeb) {
    app.get('*', (c, next) => {
      const path = c.req.path

      // index.html at root
      if (path === '/' || path === '/index.html') {
        const indexHtml = embeddedFiles.get('index.html')
        if (indexHtml) {
          return new Response(indexHtml, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        }
      }

      // Embedded assets
      const assetPath = path.startsWith('/') ? path.slice(1) : path
      const asset = embeddedFiles.get(assetPath)
      if (asset) {
        return new Response(asset, {
          headers: {
            'Content-Type': getMimeType(assetPath),
            'Cache-Control': assetPath.startsWith('lib/') ? 'public, max-age=31536000, immutable' : 'no-cache',
          },
        })
      }

      // SPA fallback for non-API paths
      if (
        !path.startsWith('/sessions') &&
        !path.startsWith('/health') &&
        !path.startsWith('/api') &&
        !path.startsWith('/file')
      ) {
        const indexHtml = embeddedFiles.get('index.html')
        if (indexHtml) {
          return new Response(indexHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        }
      }

      return next()
    })
  }

  // webDir file serving (Docker volume mount)
  if (webDir) {
    app.get('*', async (c, next) => {
      const path = c.req.path
      const filePath = path === '/' ? '/index.html' : path
      const fullPath = `${webDir}${filePath}`

      const safeWebPath = resolveInJail(fullPath)
      if (safeWebPath) {
        try {
          const file = Bun.file(safeWebPath)
          if (await file.exists()) {
            const isAsset = filePath.startsWith('/assets/') || filePath.startsWith('/lib/')
            return new Response(file, {
              headers: {
                'Content-Type': getMimeType(filePath),
                'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
              },
            })
          }
        } catch {
          // File not found
        }
      }

      // SPA fallback
      if (
        !path.startsWith('/sessions') &&
        !path.startsWith('/health') &&
        !path.startsWith('/api') &&
        !path.startsWith('/file')
      ) {
        try {
          const indexFile = Bun.file(`${webDir}/index.html`)
          if (await indexFile.exists()) {
            return new Response(indexFile, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
          }
        } catch {}
      }

      return next()
    })
  }

  // Fallback inline HTML UI (no embedded web or webDir)
  if (!hasEmbeddedWeb && !webDir) {
    app.get('/', c => c.html(UI_HTML))
    app.get('/ui', c => c.html(UI_HTML))
  }

  // ─── CORS preflight ────────────────────────────────────────────────
  app.options('*', _c => new Response(null, { status: 204 }))

  // ─── 404 catch-all ─────────────────────────────────────────────────
  app.all('*', c => c.json({ error: 'Not found' }, 404))

  // ─── Centralized error handler ─────────────────────────────────────
  app.onError((err, c) => {
    console.error(`[api] ${c.req.method} ${c.req.path} error:`, err.message)
    return c.json({ error: err.message || 'Internal server error' }, 500)
  })

  return app
}
