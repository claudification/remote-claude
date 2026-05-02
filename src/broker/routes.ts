/**
 * Hono HTTP Routes for Broker
 * Composition root -- mounts sub-routers, serves static files.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { handleAuthRoute, requireAuth } from './auth-routes'
import type { ConversationStore } from './conversation-store'
import { startFileReaper } from './file-reaper'
import { resolveInJail } from './path-jail'
import { createAdminRouter } from './routes/admin'
import { createApiRouter } from './routes/api'
import { blobDir, initBlobStore, initSharedFilesLog } from './routes/blob-store'
import { createConversationsRouter } from './routes/conversations'
import { createSentinelRouter } from './routes/sentinels'
import { createRouteHelpers } from './routes/shared'
import { createSpawnRouter } from './routes/spawn'
import { createStatsRouter } from './routes/stats'
import type { StoreDriver } from './store/types'

// Re-export blob/file helpers for external consumers (session-store, handlers, etc.)
export {
  appendSharedFile,
  dismissSharedFile,
  mediaTypeToExt,
  processImagesInEntry,
  readSharedFiles,
  registerBlob,
  registerFilePath,
  type SharedFileEntry,
  storeBlobStreaming,
} from './routes/blob-store'

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

// ─── Route factory ─────────────────────────────────────────────────────

export interface RouteOptions {
  conversationStore: ConversationStore
  store: StoreDriver
  webDir?: string
  vapidPublicKey?: string
  rclaudeSecret?: string
  cacheDir?: string
  serverStartTime?: number
  publicOrigin?: string // public base URL from --origin (e.g. "https://your-host.example.com")
  sentinelRegistry?: import('./sentinel-registry').SentinelRegistry
}

export function createRouter(options: RouteOptions): Hono {
  const {
    conversationStore,
    store,
    webDir,
    vapidPublicKey,
    rclaudeSecret,
    cacheDir,
    serverStartTime = Date.now(),
    publicOrigin,
    sentinelRegistry,
  } = options

  // Initialize disk-backed blob store + shared files log
  if (cacheDir) {
    initBlobStore(cacheDir)
    startFileReaper(blobDir)
    initSharedFilesLog(cacheDir)
  }

  const helpers = createRouteHelpers(rclaudeSecret)

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

  // ─── Sentinel ──────────────────────────────────────────────────────
  app.get('/sentinel/status', c => {
    const connected = conversationStore.hasSentinel()
    const info = conversationStore.getSentinelInfo()
    return c.json({ connected, machineId: info?.machineId, hostname: info?.hostname })
  })

  app.post('/sentinel/quit', c => {
    if (!helpers.httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const sentinel = conversationStore.getSentinel()
    if (!sentinel) return c.json({ error: 'No sentinel connected' }, 404)
    sentinel.send(JSON.stringify({ type: 'quit', reason: 'Requested via API' }))
    return c.json({ success: true })
  })

  app.get('/api/sentinel/diag', c => {
    if (!helpers.httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const info = conversationStore.getSentinelInfo()
    return c.json({
      connected: conversationStore.hasSentinel(),
      machineId: info?.machineId,
      hostname: info?.hostname,
      entries: conversationStore.getSentinelDiag(),
    })
  })

  // ─── Sub-routers ────────────────────────────────────────────────────
  app.route('/', createConversationsRouter(conversationStore, helpers))
  app.route('/', createSpawnRouter(conversationStore, helpers))
  app.route(
    '/',
    createApiRouter(conversationStore, helpers, rclaudeSecret, cacheDir, blobDir, publicOrigin, vapidPublicKey),
  )
  app.route('/', createStatsRouter(conversationStore, store, helpers, serverStartTime))
  app.route('/', createAdminRouter(conversationStore, helpers, rclaudeSecret))
  if (sentinelRegistry) {
    app.route('/', createSentinelRouter(sentinelRegistry, conversationStore, helpers))
  }

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
        !path.startsWith('/conversations') &&
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
        !path.startsWith('/conversations') &&
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
