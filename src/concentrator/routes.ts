/**
 * Hono HTTP Routes for Concentrator
 * Replaces hand-rolled routing in api.ts and auth-routes.ts
 */

import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { ListDirsResult, SendInput, Session, SpawnResult, TeamInfo } from '../shared/protocol'
import { resolveSpawnConfig } from '../shared/spawn-defaults'
import { mapProjectTrust, type SpawnCallerContext } from '../shared/spawn-permissions'
import { type SpawnRequest, spawnRequestSchema } from '../shared/spawn-schema'
import {
  queryModelComparison as queryAnalyticsModels,
  querySummary as queryAnalyticsSummary,
  queryTimeSeries as queryAnalyticsTimeSeries,
} from './analytics-store'
import {
  createInvite,
  getAllUsers,
  getUser,
  hasServerRole,
  removeCredential,
  revokeUser,
  type ServerRole,
  setServerRoles,
  setUserGrants,
  unrevokeUser,
} from './auth'
import { getAuthenticatedUser, handleAuthRoute, requireAuth } from './auth-routes'
import { queryHourly, querySummary, queryTurns } from './cost-store'
import { startFileReaper } from './file-reaper'
import { getGlobalSettings, updateGlobalSettings } from './global-settings'
import { purgeMessages, queryMessages } from './inter-session-log'
import { getModels, getModelsFetchedAt } from './model-pricing'
import { resolveInJail } from './path-jail'
import {
  hasPermissionAnyCwd,
  type Permission,
  resolvePermissionFlags,
  resolvePermissions,
  type UserGrant,
} from './permissions'
import { addPersistedLink, getPersistedLinks, removePersistedLink } from './project-links'
import {
  deleteProjectSettings,
  getAllProjectSettings,
  getProjectSettings,
  setProjectSettings,
} from './project-settings'
import { listProjects } from './project-store'
import { addSubscription, getSubscriptionCount, isPushConfigured, removeSubscription, sendPushToAll } from './push'
import { getSessionOrder, type SessionOrderV2, setSessionOrder } from './session-order'
import type { SessionStore } from './session-store'
import {
  createShare as createSessionShare,
  getShare as getShareByToken,
  listShares as listAllShares,
  revokeShare as revokeSessionShare,
  shareToGrants,
  validateShare,
} from './shares'
import { dispatchSpawn } from './spawn-dispatch'
import { UI_HTML } from './ui'

// ─── Image/Blob Store (disk-only, survives restarts) ────────────────────

let blobDir = '' // set by initBlobStore()

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

/** Stream request body to temp file, compute full SHA256, rename to content hash. O(1) memory. */
async function storeBlobStreaming(
  body: ReadableStream<Uint8Array>,
  mediaType: string,
): Promise<{ hash: string; size: number }> {
  const tempPath = join(blobDir, `_upload_${randomUUID()}`)
  const hasher = new Bun.CryptoHasher('sha256')
  const writer = Bun.file(tempPath).writer()
  let size = 0

  try {
    for await (const chunk of body) {
      hasher.update(chunk)
      writer.write(chunk)
      size += chunk.byteLength
    }
    await writer.end()

    // Content-based hash (full SHA256, not just first 200 bytes)
    const digest = hasher.digest()
    const n = digest.readBigUInt64BE(0)
    const hash = n.toString(36)

    const blobPath = join(blobDir, hash)
    if (existsSync(blobPath)) {
      // Dedup: identical content already stored
      unlinkSync(tempPath)
    } else {
      renameSync(tempPath, blobPath)
      writeFileSync(`${blobPath}.meta`, JSON.stringify({ mediaType, size, createdAt: Date.now() }))
    }

    return { hash, size }
  } catch (err) {
    // Clean up temp file on any error
    try {
      unlinkSync(tempPath)
    } catch {}
    throw err
  }
}

// ─── Shared files + clipboard log (per-CWD, server-side) ─────────
export interface SharedFileEntry {
  type: 'file' | 'clipboard'
  hash: string
  filename: string
  mediaType: string
  cwd?: string // project directory (primary query key)
  sessionId?: string // for attribution
  size: number
  url: string
  text?: string // clipboard text content
  dismissed?: boolean
  createdAt: number
}

let sharedFilesLogPath: string | null = null
const SHARED_FILES_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

function initSharedFilesLog(cacheDir: string): void {
  sharedFilesLogPath = join(cacheDir, 'shared-files.jsonl')
}

export function appendSharedFile(entry: SharedFileEntry): void {
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
      .filter(e => e.createdAt > cutoff && !e.dismissed)
      .reverse() // newest first
  } catch {
    return []
  }
}

function dismissSharedFile(hash: string): boolean {
  if (!sharedFilesLogPath || !existsSync(sharedFilesLogPath)) return false
  try {
    const lines = readFileSync(sharedFilesLogPath, 'utf-8').trim().split('\n').filter(Boolean)
    const updated = lines.map(line => {
      const entry = JSON.parse(line) as SharedFileEntry
      if (entry.hash === hash) return JSON.stringify({ ...entry, dismissed: true })
      return line
    })
    writeFileSync(sharedFilesLogPath, `${updated.join('\n')}\n`)
    return true
  } catch {
    return false
  }
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'svg']

function mediaTypeToExt(mediaType: string, fallback = 'bin'): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/heic': 'heic',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
    'application/json': 'json',
    'application/zip': 'zip',
    'text/plain': 'txt',
    'text/html': 'html',
    'text/css': 'css',
    'application/octet-stream': 'bin',
  }
  if (map[mediaType]) return map[mediaType]
  // Fallback: use MIME subtype if it looks like a clean extension (no hyphens/plus)
  const sub = mediaType.split('/')[1] || ''
  if (sub && /^[a-z0-9]+$/i.test(sub)) return sub
  return fallback
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
  const {
    sessionStore,
    webDir,
    vapidPublicKey,
    rclaudeSecret,
    cacheDir,
    serverStartTime = Date.now(),
    publicOrigin,
  } = options

  /**
   * Resolve the caller's grants from an HTTP request.
   * Returns null for admin/bearer auth (full access).
   * Returns UserGrant[] for cookie users and share viewers.
   */
  function resolveHttpGrants(req: Request): UserGrant[] | null {
    // Bearer token with shared secret = admin, no restrictions
    const authHeader = req.headers.get('authorization')
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (rclaudeSecret && bearer && bearer === rclaudeSecret) return null

    // Cookie auth = user grants
    const userName = getAuthenticatedUser(req)
    if (userName) {
      const user = getUser(userName)
      return user?.grants || []
    }

    // Share token auth
    const url = new URL(req.url)
    const shareToken = url.searchParams.get('share')
    if (shareToken) {
      const share = validateShare(shareToken)
      if (share) return shareToGrants(share)
    }

    return [] // no auth = no access
  }

  /** Check if the caller has a specific permission for a session's CWD. */
  function httpHasPermission(req: Request, permission: Permission, cwd: string): boolean {
    const grants = resolveHttpGrants(req)
    if (grants === null) return true // admin
    const { permissions } = resolvePermissions(grants, cwd)
    return permissions.has(permission)
  }

  /** Check if the caller is an admin (bearer token OR admin role in grants). */
  function httpIsAdmin(req: Request, cwd = '*'): boolean {
    const grants = resolveHttpGrants(req)
    if (grants === null) return true // bearer token
    const { isAdmin } = resolvePermissions(grants, cwd)
    return isAdmin
  }

  /** Filter sessions by caller's grants. */
  function filterSessionsByHttpGrants<T extends { cwd: string }>(req: Request, sessions: T[]): T[] {
    const grants = resolveHttpGrants(req)
    if (grants === null) return sessions // admin sees all
    return sessions.filter(s => {
      const { permissions } = resolvePermissions(grants, s.cwd)
      return permissions.has('chat:read')
    })
  }

  // Initialize disk-backed blob store + shared files log
  if (cacheDir) {
    initBlobStore(cacheDir)
    startFileReaper(blobDir)
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

  // ─── Model pricing (LiteLLM) ─────────────────────────────────────
  app.get('/api/models', c => c.json({ models: getModels(), fetchedAt: getModelsFetchedAt() }))

  // ─── File serving by hash ──────────────────────────────────────────
  app.get('/file/:hash', async c => {
    if (!blobDir) return new Response(null, { status: 503 })
    const hash = c.req.param('hash').replace(/\.[^.]+$/, '') // strip extension (everything after last dot)
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

    const totalSize = file.size
    const headers: Record<string, string> = {
      'Content-Type': mediaType,
      'Cache-Control': 'public, max-age=86400',
      'Accept-Ranges': 'bytes',
      ETag: `"${hash}"`,
    }

    // Range request support (video seeking, resumable downloads)
    const rangeHeader = c.req.header('range')
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
      if (match) {
        const start = parseInt(match[1], 10)
        const end = match[2] ? parseInt(match[2], 10) : totalSize - 1
        if (start >= totalSize || end >= totalSize || start > end) {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${totalSize}` },
          })
        }
        const sliced = file.slice(start, end + 1)
        return new Response(sliced, {
          status: 206,
          headers: {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Content-Length': String(end - start + 1),
          },
        })
      }
    }

    headers['Content-Length'] = String(totalSize)
    return new Response(file, { headers })
  })

  // ─── Sessions (all gated by grants) ────────────────────────────────
  app.get('/sessions', c => {
    const activeOnly = c.req.query('active') === 'true'
    const sessions = activeOnly ? sessionStore.getActiveSessions() : sessionStore.getAllSessions()
    const filtered = filterSessionsByHttpGrants(c.req.raw, sessions)
    return c.json(filtered.map(s => sessionToOverview(s, sessionStore)))
  })

  app.get('/sessions/:id', c => {
    const session = sessionStore.getSession(c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.cwd)) return c.json({ error: 'Forbidden' }, 403)
    return c.json(sessionToOverview(session, sessionStore))
  })

  app.get('/sessions/:id/events', c => {
    const sessionId = c.req.param('id')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.cwd)) return c.json({ error: 'Forbidden' }, 403)
    const limit = parseInt(c.req.query('limit') || '0', 10)
    const since = parseInt(c.req.query('since') || '0', 10)
    const events = sessionStore.getSessionEvents(sessionId, limit || undefined, since || undefined)
    return c.json(events)
  })

  app.get('/sessions/:id/subagents', c => {
    const session = sessionStore.getSession(c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.cwd)) return c.json({ error: 'Forbidden' }, 403)
    return c.json(session.subagents)
  })

  app.get('/sessions/:id/transcript', c => {
    const sessionId = c.req.param('id')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.cwd)) return c.json({ error: 'Forbidden' }, 403)
    const limit = parseInt(c.req.query('limit') || '20', 10)
    if (!sessionStore.hasTranscriptCache(sessionId)) {
      return c.json({ error: 'No transcript in cache (rclaude not streaming yet?)' }, 404)
    }
    let entries = sessionStore.getTranscriptEntries(sessionId, limit)

    // Filter user entries for share viewers with hideUserInput
    const shareToken = new URL(c.req.raw.url).searchParams.get('share')
    if (shareToken) {
      const share = validateShare(shareToken)
      if (share?.hideUserInput) {
        entries = entries.filter(e => (e as { type?: string }).type !== 'user')
      }
    }

    return c.json(entries.map(e => processImagesInEntry(e as Record<string, unknown>)))
  })

  app.get('/sessions/:id/subagents/:agentId/transcript', c => {
    const sessionId = c.req.param('id')
    const agentId = c.req.param('agentId')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.cwd)) return c.json({ error: 'Forbidden' }, 403)
    const limit = parseInt(c.req.query('limit') || '100', 10)
    if (!sessionStore.hasSubagentTranscriptCache(sessionId, agentId)) {
      return c.json({ error: 'No subagent transcript in cache' }, 404)
    }
    const entries = sessionStore.getSubagentTranscriptEntries(sessionId, agentId, limit)
    return c.json(entries.map(e => processImagesInEntry(e as Record<string, unknown>)))
  })

  app.get('/sessions/:id/diag', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
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
      sessionInfo: (session as unknown as Record<string, unknown>).sessionInfo,
      diagLog: session.diagLog,
    })
  })

  app.get('/sessions/:id/tasks', c => {
    const session = sessionStore.getSession(c.req.param('id'))
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat:read', session.cwd)) return c.json({ error: 'Forbidden' }, 403)
    return c.json({ tasks: session.tasks, archivedTasks: session.archivedTasks })
  })

  app.post('/sessions/:id/input', async c => {
    const sessionId = c.req.param('id')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'chat', session.cwd)) return c.json({ error: 'Forbidden' }, 403)
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
    if (!httpHasPermission(c.req.raw, 'spawn', '*'))
      return c.json({ error: 'Forbidden: spawn permission required' }, 403)
    const sessionId = c.req.param('id')
    const session = sessionStore.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    if (session.status === 'active') return c.json({ error: 'Session is already active' }, 400)

    // If called with X-Caller-Session header, check benevolent trust
    const callerSessionId = c.req.header('X-Caller-Session')
    if (callerSessionId) {
      const callerSess = sessionStore.getSession(callerSessionId)
      const callerTrust = callerSess?.cwd ? getProjectSettings(callerSess.cwd)?.trustLevel : undefined
      if (callerTrust !== 'benevolent') {
        return c.json({ error: 'Requires benevolent trust level' }, 403)
      }
    }

    const agent = sessionStore.getAgent()
    if (!agent) return c.json({ error: 'No host agent connected' }, 503)

    const wrapperId = randomUUID()
    const lc = session.launchConfig // stored launch config from original spawn
    const name =
      session.title || getProjectSettings(session.cwd)?.label || session.cwd.split('/').pop() || sessionId.slice(0, 8)
    // Resolve defaults: launch config > project > global > undefined
    const projSettings = getProjectSettings(session.cwd)
    const globalSettings = getGlobalSettings()
    const resolved = resolveSpawnConfig(
      {
        cwd: session.cwd,
        headless: lc?.headless,
        model: lc?.model as SpawnRequest['model'] | undefined,
        effort: lc?.effort as SpawnRequest['effort'] | undefined,
        bare: lc?.bare,
        repl: lc?.repl,
        permissionMode: lc?.permissionMode as SpawnRequest['permissionMode'] | undefined,
        autocompactPct: lc?.autocompactPct,
        maxBudgetUsd: lc?.maxBudgetUsd,
      },
      projSettings,
      globalSettings,
    )
    const { headless, model, effort, bare, repl, permissionMode, autocompactPct, maxBudgetUsd } = resolved

    agent.send(
      JSON.stringify({
        type: 'revive',
        sessionId,
        cwd: session.cwd,
        wrapperId,
        mode: 'resume',
        headless,
        effort,
        model,
        sessionName: session.title || undefined,
        bare: bare || undefined,
        repl: repl || undefined,
        permissionMode,
        autocompactPct: autocompactPct ?? session.autocompactPct,
        maxBudgetUsd: maxBudgetUsd ?? session.maxBudgetUsd,
        adHocWorktree: session.adHocWorktree || undefined,
        env: lc?.env || undefined,
      }),
    )

    // Register rendezvous for MCP callers
    if (callerSessionId) {
      sessionStore
        .addRendezvous(wrapperId, callerSessionId, session.cwd, 'revive')
        .then(revived => {
          const callerWs = sessionStore.getSessionSocket(callerSessionId)
          if (callerWs) {
            callerWs.send(
              JSON.stringify({
                type: 'revive_ready',
                sessionId: revived.id,
                cwd: revived.cwd,
                wrapperId,
                session: revived,
              }),
            )
          }
        })
        .catch(err => {
          const callerWs = sessionStore.getSessionSocket(callerSessionId)
          if (callerWs) {
            callerWs.send(
              JSON.stringify({
                type: 'revive_timeout',
                wrapperId,
                sessionId,
                cwd: session.cwd,
                error: typeof err === 'string' ? err : 'Revive rendezvous timed out',
              }),
            )
          }
        })
    }

    return c.json({ success: true, name, message: 'Revive command sent to agent', wrapperId }, 202)
  })

  app.delete('/sessions/:id', c => {
    if (!httpHasPermission(c.req.raw, 'settings', '*')) return c.json({ error: 'Forbidden' }, 403)
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
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const agent = sessionStore.getAgent()
    if (!agent) return c.json({ error: 'No agent connected' }, 404)
    agent.send(JSON.stringify({ type: 'quit', reason: 'Requested via API' }))
    return c.json({ success: true })
  })

  app.get('/api/agent/diag', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
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
    for (const [cwd, settings] of Object.entries(all)) {
      const { permissions } = resolvePermissions(grants, cwd)
      if (permissions.has('chat:read')) filtered[cwd] = settings
    }
    return c.json(filtered)
  })

  app.post('/api/settings/projects', async c => {
    if (!httpHasPermission(c.req.raw, 'settings', '*'))
      return c.json({ error: 'Forbidden: settings permission required' }, 403)
    const body = await c.req.json<{ cwd: string; settings: { label?: string; icon?: string; color?: string } }>()
    if (!body.cwd) return c.json({ error: 'Missing cwd' }, 400)
    setProjectSettings(body.cwd, body.settings || {})
    const allSettings = getAllProjectSettings()
    broadcastToSubscribers(sessionStore, { type: 'project_settings_updated', settings: allSettings })
    return c.json({ success: true, settings: allSettings })
  })

  app.delete('/api/settings/projects', async c => {
    if (!httpHasPermission(c.req.raw, 'settings', '*'))
      return c.json({ error: 'Forbidden: settings permission required' }, 403)
    const body = await c.req.json<{ cwd: string }>()
    if (!body.cwd) return c.json({ error: 'Missing cwd' }, 400)
    deleteProjectSettings(body.cwd)
    const allSettings = getAllProjectSettings()
    broadcastToSubscribers(sessionStore, { type: 'project_settings_updated', settings: allSettings })
    return c.json({ success: true, settings: allSettings })
  })

  app.post('/api/settings/projects/generate-keyterms', async c => {
    if (!httpHasPermission(c.req.raw, 'settings', '*'))
      return c.json({ error: 'Forbidden: settings permission required' }, 403)
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
    setProjectSettings(body.cwd, { keyterms })
    return c.json({ keyterms, settings: getAllProjectSettings() })
  })

  // ─── Global settings ───────────────────────────────────────────────
  app.get('/api/settings', c => c.json(getGlobalSettings()))

  app.post('/api/settings', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const body = await c.req.json()
    const result = updateGlobalSettings(body)
    broadcastToSubscribers(sessionStore, { type: 'settings_updated', settings: result.settings })
    return c.json(result)
  })

  // ─── File upload ───────────────────────────────────────────────────
  app.post('/api/files', async c => {
    if (!blobDir) return c.json({ error: 'Blob store not configured' }, 503)

    // Require files permission -- check session CWD if available, else any grant
    const uploadSessionId = c.req.header('x-session-id') || c.req.query('sessionId') || undefined
    const uploadCwd = uploadSessionId ? sessionStore.getSession(uploadSessionId)?.cwd : undefined
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

    // Log to shared files index (keyed by CWD for per-project queries)
    const sessionId = c.req.header('x-session-id') || c.req.query('sessionId') || undefined
    const sessionCwd = sessionId ? sessionStore.getSession(sessionId)?.cwd : undefined
    appendSharedFile({
      type: 'file',
      hash,
      filename,
      mediaType,
      cwd: sessionCwd,
      sessionId,
      size,
      url,
      createdAt: Date.now(),
    })

    return c.json({ hash, url, filename, mediaType, size })
  })

  // ─── Shared files + clipboard (per-CWD) ─────────────────────────
  app.get('/api/shared-files', c => {
    const cwd = c.req.query('cwd')
    const sessionId = c.req.query('sessionId')
    let files = readSharedFiles()
    if (cwd) files = files.filter(f => f.cwd === cwd)
    else if (sessionId) files = files.filter(f => f.sessionId === sessionId)
    // Filter by CWDs the caller can access
    const grants = resolveHttpGrants(c.req.raw)
    if (grants) {
      files = files.filter(f => {
        if (!f.cwd) return false
        const { permissions } = resolvePermissions(grants, f.cwd)
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

  // ─── Session order ─────────────────────────────────────────────────
  app.get('/api/session-order', c => {
    const order = getSessionOrder()
    const grants = resolveHttpGrants(c.req.raw)
    if (!grants) return c.json(order) // admin sees full tree
    // Filter tree to only include CWDs the user can access
    function filterTree(nodes: SessionOrderV2['tree']): SessionOrderV2['tree'] {
      const result: SessionOrderV2['tree'] = []
      for (const node of nodes) {
        if (node.type === 'session') {
          const cwd = node.id.startsWith('cwd:') ? node.id.slice(4) : node.id
          // biome-ignore lint/style/noNonNullAssertion: guaranteed non-null by early return above
          const { permissions } = resolvePermissions(grants!, cwd)
          if (permissions.has('chat:read')) result.push(node)
        } else if (node.type === 'group') {
          const children = filterTree(node.children)
          if (children.length > 0) result.push({ ...node, children })
        }
      }
      return result
    }
    return c.json({ ...order, tree: filterTree(order.tree) })
  })

  app.post('/api/session-order', async c => {
    if (!httpHasPermission(c.req.raw, 'settings', '*'))
      return c.json({ error: 'Forbidden: settings permission required' }, 403)
    const body = await c.req.json<{ version: number; tree: unknown[] }>()
    if (body.version !== 2 || !Array.isArray(body.tree)) {
      return c.json({ error: 'Invalid session order: expected { version: 2, tree: [...] }' }, 400)
    }
    setSessionOrder(body as SessionOrderV2)
    const order = getSessionOrder()
    // Broadcast filtered order per subscriber's grants
    for (const ws of sessionStore.getSubscribers()) {
      try {
        const wsGrants = (ws.data as { grants?: UserGrant[] }).grants
        if (!wsGrants) {
          ws.send(JSON.stringify({ type: 'session_order_updated', order }))
        } else {
          function filterNodes(nodes: SessionOrderV2['tree']): SessionOrderV2['tree'] {
            const result: SessionOrderV2['tree'] = []
            for (const node of nodes) {
              if (node.type === 'session') {
                const cwd = node.id.startsWith('cwd:') ? node.id.slice(4) : node.id
                // biome-ignore lint/style/noNonNullAssertion: guaranteed non-null by else branch above
                const { permissions } = resolvePermissions(wsGrants!, cwd)
                if (permissions.has('chat:read')) result.push(node)
              } else if (node.type === 'group') {
                const children = filterNodes(node.children)
                if (children.length > 0) result.push({ ...node, children })
              }
            }
            return result
          }
          ws.send(JSON.stringify({ type: 'session_order_updated', order: { ...order, tree: filterNodes(order.tree) } }))
        }
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

  // ─── User admin (gated behind user-editor server role) ─────────────

  function requireUserEditor(c: { req: { raw: Request } }): Response | null {
    // Bearer token with shared secret = full admin access (CLI/scripts)
    const authHeader = c.req.raw.headers.get('authorization')
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (rclaudeSecret && bearerToken && bearerToken === rclaudeSecret) return null

    const userName = getAuthenticatedUser(c.req.raw)
    if (!userName)
      return c.req.raw.headers.get('accept')?.includes('json')
        ? new Response(JSON.stringify({ error: 'Not authenticated' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response('Unauthorized', { status: 401 })
    if (!hasServerRole(userName, 'user-editor')) {
      return new Response(JSON.stringify({ error: 'Forbidden: user-editor role required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return null
  }

  app.get('/api/users', c => {
    const block = requireUserEditor(c)
    if (block) return block
    const users = getAllUsers().map(u => ({
      name: u.name,
      createdAt: u.createdAt,
      lastUsedAt: u.lastUsedAt,
      revoked: u.revoked,
      grants: u.grants,
      serverRoles: u.serverRoles,
      credentialCount: u.credentials.length,
      credentials: u.credentials.map(c => ({
        credentialId: c.credentialId,
        registeredAt: c.registeredAt,
        counter: c.counter,
        transports: c.transports,
      })),
      pushSubscriptionCount: u.pushSubscriptions?.length || 0,
    }))
    return c.json({ users })
  })

  app.post('/api/users/invite', async c => {
    const block = requireUserEditor(c)
    if (block) return block
    const body = await c.req.json<{ name: string; grants?: unknown[]; serverRoles?: string[] }>()
    if (!body.name) return c.json({ error: 'name is required' }, 400)
    try {
      const invite = createInvite(body.name, body.grants as Parameters<typeof createInvite>[1])
      const origin = c.req.header('origin') || ''
      const inviteUrl = `${origin}/#/invite/${invite.token}`
      return c.json({ token: invite.token, expiresAt: invite.expiresAt, inviteUrl })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  /** After changing grants/roles, hot-reload on live WS connections and push updated permissions + session list */
  function refreshUserPermissions(userName: string) {
    const user = getUser(userName)
    if (!user) return
    for (const ws of sessionStore.getSubscribers()) {
      if ((ws.data as { userName?: string }).userName === userName) {
        // Hot-reload grants on the live WS connection
        ;(ws.data as { grants?: unknown }).grants = user.grants
        // Push updated permissions
        const serverRoles = user.serverRoles
        const global = resolvePermissionFlags(user.grants, '*', serverRoles)
        const perSessionPerms: Record<string, ReturnType<typeof resolvePermissionFlags>> = {}
        for (const s of sessionStore.getActiveSessions()) {
          perSessionPerms[s.id] = resolvePermissionFlags(user.grants, s.cwd, serverRoles)
        }
        try {
          ws.send(JSON.stringify({ type: 'permissions', global, sessions: perSessionPerms }))
        } catch {}
        // Re-send filtered session list (user might gain/lose access)
        sessionStore.sendSessionsList(ws)
      }
    }
  }

  app.post('/api/users/:name/grants', async c => {
    const block = requireUserEditor(c)
    if (block) return block
    const name = c.req.param('name')
    const body = await c.req.json<{ grants: unknown[] }>()
    if (!Array.isArray(body.grants)) return c.json({ error: 'grants array required' }, 400)
    if (setUserGrants(name, body.grants as Parameters<typeof setUserGrants>[1])) {
      refreshUserPermissions(name)
      return c.json({ ok: true })
    }
    return c.json({ error: 'User not found' }, 404)
  })

  app.post('/api/users/:name/server-roles', async c => {
    const block = requireUserEditor(c)
    if (block) return block
    const name = c.req.param('name')
    const body = await c.req.json<{ serverRoles: string[] }>()
    if (!Array.isArray(body.serverRoles)) return c.json({ error: 'serverRoles array required' }, 400)
    if (setServerRoles(name, body.serverRoles as ServerRole[])) {
      refreshUserPermissions(name)
      return c.json({ ok: true })
    }
    return c.json({ error: 'User not found' }, 404)
  })

  app.post('/api/users/:name/revoke', c => {
    const block = requireUserEditor(c)
    if (block) return block
    const name = c.req.param('name')
    if (revokeUser(name)) {
      // Kill active WS connections for revoked user
      for (const ws of sessionStore.getSubscribers()) {
        if ((ws.data as { userName?: string }).userName === name) {
          sessionStore.removeTerminalViewerBySocket(ws)
          sessionStore.removeSubscriber(ws)
          try {
            ws.close(4401, 'User revoked')
          } catch {}
        }
      }
      return c.json({ ok: true })
    }
    return c.json({ error: 'User not found' }, 404)
  })

  app.post('/api/users/:name/unrevoke', c => {
    const block = requireUserEditor(c)
    if (block) return block
    if (unrevokeUser(c.req.param('name'))) return c.json({ ok: true })
    return c.json({ error: 'User not found' }, 404)
  })

  app.delete('/api/users/:name', c => {
    const block = requireUserEditor(c)
    if (block) return block
    const name = c.req.param('name')
    // Don't allow deleting yourself
    const caller = getAuthenticatedUser(c.req.raw)
    if (caller === name) return c.json({ error: 'Cannot delete yourself' }, 400)
    const user = getUser(name)
    if (!user) return c.json({ error: 'User not found' }, 404)
    // Revoke first (kills sessions), then we'd need a deleteUser -- for now revoke is enough
    revokeUser(name)
    return c.json({ ok: true })
  })

  app.delete('/api/users/:name/credentials/:credentialId', c => {
    const block = requireUserEditor(c)
    if (block) return block
    const name = c.req.param('name')
    const credentialId = decodeURIComponent(c.req.param('credentialId'))
    const result = removeCredential(name, credentialId)
    switch (result) {
      case 'user_not_found':
        return c.json({ error: 'User not found' }, 404)
      case 'not_found':
        return c.json({ error: 'Credential not found' }, 404)
      case 'removed_and_revoked':
        return c.json({ ok: true, revoked: true, message: 'Last passkey removed - user revoked' })
      case 'removed':
        return c.json({ ok: true, revoked: false, message: 'Passkey removed, all sessions killed' })
    }
  })

  // ─── Session Shares ────────────────────────────────────────────────

  app.post('/api/shares', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const body = await c.req.json<{
      sessionCwd: string
      expiresIn?: number // ms from now
      expiresAt?: number // absolute timestamp
      label?: string
      permissions?: string[]
      hideUserInput?: boolean
    }>()
    if (!body.sessionCwd) return c.json({ error: 'sessionCwd is required' }, 400)
    const expiresAt = body.expiresAt || (body.expiresIn ? Date.now() + body.expiresIn : Date.now() + 4 * 60 * 60 * 1000) // default 4h
    try {
      const share = createSessionShare({
        sessionCwd: body.sessionCwd,
        expiresAt,
        createdBy: getAuthenticatedUser(c.req.raw) || 'admin',
        label: body.label,
        permissions: body.permissions,
        hideUserInput: body.hideUserInput,
      })
      const origin = c.req.header('origin') || ''
      sessionStore.broadcastSharesUpdate()
      return c.json({
        token: share.token,
        expiresAt: share.expiresAt,
        shareUrl: `${origin}/#/share/${share.token}`,
      })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  app.get('/api/shares', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const active = listAllShares()
    // Include connected viewer count per share
    const shares = active.map(s => ({
      ...s,
      viewerCount: sessionStore.getShareViewerCount(s.token),
    }))
    return c.json({ shares })
  })

  app.get('/api/shares/:token', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const share = getShareByToken(c.req.param('token'))
    if (!share) return c.json({ error: 'Share not found' }, 404)
    return c.json({
      ...share,
      viewerCount: sessionStore.getShareViewerCount(share.token),
    })
  })

  app.delete('/api/shares/:token', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const token = c.req.param('token')
    if (revokeSessionShare(token)) {
      // Kill all WS connections authenticated with this share token
      for (const ws of sessionStore.getSubscribers()) {
        if ((ws.data as { shareToken?: string }).shareToken === token) {
          try {
            ws.send(JSON.stringify({ type: 'share_expired', reason: 'Share has been revoked' }))
            ws.close(4403, 'Share revoked')
          } catch {}
        }
      }
      sessionStore.broadcastSharesUpdate()
      return c.json({ ok: true })
    }
    return c.json({ error: 'Share not found' }, 404)
  })

  // ─── Stats ─────────────────────────────────────────────────────────
  app.get('/api/stats', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
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

  app.get('/api/subscriptions', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    return c.json(sessionStore.getSubscriptionsDiag())
  })

  // ─── Cost reporting ─────────────────────────────────────────────────

  app.get('/api/stats/turns', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const q = c.req.query()
    return c.json(
      queryTurns({
        from: q.from ? Number(q.from) : undefined,
        to: q.to ? Number(q.to) : undefined,
        account: q.account || undefined,
        model: q.model || undefined,
        cwd: q.cwd || undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
      }),
    )
  })

  app.get('/api/stats/hourly', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const q = c.req.query()
    return c.json(
      queryHourly({
        from: q.from ? Number(q.from) : undefined,
        to: q.to ? Number(q.to) : undefined,
        account: q.account || undefined,
        model: q.model || undefined,
        cwd: q.cwd || undefined,
        groupBy: (q.groupBy as 'hour' | 'day') || undefined,
      }),
    )
  })

  app.get('/api/stats/summary', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const period = (c.req.query('period') || '24h') as '24h' | '7d' | '30d'
    if (!['24h', '7d', '30d'].includes(period)) {
      return c.json({ error: 'Invalid period. Use 24h, 7d, or 30d' }, 400)
    }
    return c.json(querySummary(period))
  })

  // ─── Projects ──────────────────────────────────────────────────────

  app.get('/api/projects', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    return c.json({ projects: listProjects() })
  })

  // ─── Analytics ─────────────────────────────────────────────────────

  app.get('/api/analytics/summary', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const period = (c.req.query('period') || '7d') as '24h' | '7d' | '30d' | '90d'
    const project = c.req.query('project') || undefined
    if (!['24h', '7d', '30d', '90d'].includes(period)) {
      return c.json({ error: 'Invalid period. Use 24h, 7d, 30d, or 90d' }, 400)
    }
    return c.json(queryAnalyticsSummary(period, project))
  })

  app.get('/api/analytics/timeseries', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const period = (c.req.query('period') || '7d') as '24h' | '7d' | '30d'
    const granularity = (c.req.query('granularity') || 'hour') as 'hour' | 'day'
    const project = c.req.query('project') || undefined
    if (!['24h', '7d', '30d'].includes(period)) {
      return c.json({ error: 'Invalid period. Use 24h, 7d, or 30d' }, 400)
    }
    return c.json(queryAnalyticsTimeSeries(period, granularity, project))
  })

  app.get('/api/analytics/models', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const period = (c.req.query('period') || '7d') as '24h' | '7d' | '30d' | '90d'
    const project = c.req.query('project') || undefined
    if (!['24h', '7d', '30d', '90d'].includes(period)) {
      return c.json({ error: 'Invalid period. Use 24h, 7d, 30d, or 90d' }, 400)
    }
    return c.json(queryAnalyticsModels(period, project))
  })

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

  // ─── Project links ──────────────────────────────────────────────
  app.get('/api/links', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const persisted = getPersistedLinks()
    const activeSessions = sessionStore.getActiveSessions()

    const links = persisted.map(pl => {
      const sessA = activeSessions.find(s => s.cwd === pl.cwdA)
      const sessB = activeSessions.find(s => s.cwd === pl.cwdB)
      const nameA = getProjectSettings(pl.cwdA)?.label || pl.cwdA.split('/').pop() || pl.cwdA
      const nameB = getProjectSettings(pl.cwdB)?.label || pl.cwdB.split('/').pop() || pl.cwdB
      return {
        cwdA: pl.cwdA,
        cwdB: pl.cwdB,
        nameA,
        nameB,
        createdAt: pl.createdAt,
        lastUsed: pl.lastUsed,
        online: !!(sessA && sessB),
        sessionIdA: sessA?.id,
        sessionIdB: sessB?.id,
      }
    })
    return c.json({ links })
  })

  app.post('/api/links', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const body = await c.req.json<{ cwdA: string; cwdB: string }>()
    if (!body.cwdA || !body.cwdB) return c.json({ error: 'cwdA and cwdB required' }, 400)
    if (body.cwdA === body.cwdB) return c.json({ error: 'Cannot link a project to itself' }, 400)

    const link = addPersistedLink(body.cwdA, body.cwdB)

    // Activate the in-memory project link
    const active = sessionStore.getActiveSessions()
    const anyA = active.find(s => s.cwd === link.cwdA)
    const anyB = active.find(s => s.cwd === link.cwdB)
    if (anyA && anyB) sessionStore.linkProjects(anyA.id, anyB.id)

    return c.json({ ok: true, link })
  })

  app.delete('/api/links', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const body = await c.req.json<{ cwdA: string; cwdB: string; purgeHistory?: boolean }>()
    if (!body.cwdA || !body.cwdB) return c.json({ error: 'cwdA and cwdB required' }, 400)

    const removed = removePersistedLink(body.cwdA, body.cwdB)

    // Sever the in-memory project link
    sessionStore.unlinkProjectsByCwd(body.cwdA, body.cwdB)

    let purged = 0
    if (body.purgeHistory) {
      purged = purgeMessages(body.cwdA, body.cwdB)
    }

    return c.json({ ok: true, removed, purged })
  })

  // ─── Inter-session message history ──────────────────────────────────
  app.get('/api/links/messages', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const cwdA = c.req.query('cwdA')
    const cwdB = c.req.query('cwdB')
    const cwd = c.req.query('cwd')
    const limit = Number.parseInt(c.req.query('limit') || '50', 10)
    const beforeStr = c.req.query('before')
    const before = beforeStr ? Number.parseInt(beforeStr, 10) : undefined

    const result = queryMessages({
      cwdA: cwdA || undefined,
      cwdB: cwdB || undefined,
      cwd: cwd || undefined,
      limit,
      before,
    })
    return c.json(result)
  })

  // ─── 404 catch-all ─────────────────────────────────────────────────
  app.all('*', c => c.json({ error: 'Not found' }, 404))

  // ─── Centralized error handler ─────────────────────────────────────
  app.onError((err, c) => {
    console.error(`[api] ${c.req.method} ${c.req.path} error:`, err.message)
    return c.json({ error: err.message || 'Internal server error' }, 500)
  })

  return app
}
