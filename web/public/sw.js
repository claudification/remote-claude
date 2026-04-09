/**
 * Service Worker - Manifest-based precaching + push notifications
 *
 * On install: fetches /asset-manifest.json, precaches all listed files.
 * On update: if manifest changed, new SW installs with new cache.
 * Runtime: cache-first for precached assets, network-first for API/dynamic.
 * /file/* blobs: LRU cache (max 50, skip >2MB).
 */

const PRECACHE = 'rclaude-precache'
const FILE_CACHE = 'rclaude-files-v1'
const FILE_CACHE_MAX = 50
const FILE_CACHE_MAX_SIZE = 2 * 1024 * 1024

// ─── Install: precache from manifest ─────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    fetch('/asset-manifest.json')
      .then(res => res.json())
      .then(async manifest => {
        const cache = await caches.open(`${PRECACHE}-${manifest.buildHash}`)
        const urls = manifest.files.map(f => f.url).filter(u => !u.endsWith('.map'))
        // Also cache the root HTML
        urls.push('/')
        await cache.addAll(urls)
        console.log(`[sw] precached ${urls.length} files (build: ${manifest.buildHash})`)
      })
      .catch(err => console.warn('[sw] precache failed:', err)),
  )
  self.skipWaiting()
})

// ─── Activate: clean old precaches, claim clients ────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => {
        // Find the current precache name
        const current = keys.find(k => k.startsWith(PRECACHE))
        return Promise.all(
          keys
            .filter(k => k.startsWith(PRECACHE) && k !== current)
            .map(k => {
              console.log(`[sw] deleting old cache: ${k}`)
              return caches.delete(k)
            }),
        )
      })
      .then(() => clients.claim()),
  )
  // Notify all clients that a new SW is active
  clients.matchAll({ type: 'window' }).then(cls => {
    for (const client of cls) {
      client.postMessage({ type: 'sw-updated' })
    }
  })
})

// ─── Fetch: precache-first, with runtime caching for /file/* ─────

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // Skip non-GET and never-cache paths
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/sessions/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/ws')
  )
    return

  // Precached assets: cache-first (manifest guarantees correctness)
  if (url.pathname.startsWith('/assets/') || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached
        // Fallback to network (shouldn't happen if precache worked)
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(`${PRECACHE}-runtime`).then(cache => cache.put(event.request, clone))
          }
          return response
        })
      }),
    )
    return
  }

  // Static files (icons, fonts): cache-first
  if (url.pathname.match(/\.(png|ico|svg|woff2?|webmanifest)$/)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(`${PRECACHE}-runtime`).then(cache => cache.put(event.request, clone))
          }
          return response
        })
      }),
    )
    return
  }

  // /file/* blobs: cache-first, LRU eviction, skip large files
  if (url.pathname.startsWith('/file/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached
        return fetch(event.request).then(response => {
          if (!response.ok) return response
          const size = response.headers.get('content-length')
          if (size && parseInt(size, 10) > FILE_CACHE_MAX_SIZE) return response
          const clone = response.clone()
          caches.open(FILE_CACHE).then(async cache => {
            await cache.put(event.request, clone)
            const keys = await cache.keys()
            if (keys.length > FILE_CACHE_MAX) {
              const toDelete = keys.slice(0, keys.length - FILE_CACHE_MAX)
              for (const key of toDelete) await cache.delete(key)
            }
          })
          return response
        })
      }),
    )
    return
  }
})

// ─── Push Notifications ──────────────────────────────────────────

self.addEventListener('push', event => {
  if (!event.data) return

  let payload
  try {
    payload = event.data.json()
  } catch {
    payload = { title: 'rclaude', body: event.data.text() }
  }

  const title = payload.title || 'rclaude'
  const options = {
    body: payload.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || `rclaude-${Date.now()}`,
    data: {
      sessionId: payload.sessionId,
      url: payload.sessionId ? `/#session/${payload.sessionId}` : '/',
      ...payload.data,
    },
    vibrate: [200, 100, 200],
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()

  const url = event.notification.data?.url || '/'
  const sessionId = event.notification.data?.sessionId

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          client.focus()
          if (sessionId) {
            client.postMessage({ type: 'navigate-session', sessionId })
          }
          return
        }
      }
      return clients.openWindow(url)
    }),
  )
})
