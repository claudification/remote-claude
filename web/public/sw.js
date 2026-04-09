/**
 * Service Worker - Caching + Push Notifications
 *
 * Strategy:
 * - Hashed assets (/assets/*): cache-first (immutable, hash changes on rebuild)
 * - HTML shell (/, /index.html): network-first with cache fallback (offline support)
 * - API/WS: never cached (real-time data)
 * - On update: notify app via postMessage, user decides when to reload
 */

const CACHE_NAME = 'rclaude-v1'
const SHELL_CACHE = 'rclaude-shell-v1'

// Hashed assets are immutable - cache forever
function isHashedAsset(url) {
  return url.pathname.startsWith('/assets/')
}

// HTML shell pages
function isShellRequest(url) {
  return url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/auth/login'
}

// Never cache these
function shouldSkip(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/sessions/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/file/') ||
    url.pathname.protocol === 'chrome-extension:'
  )
}

// Install: cache the HTML shell immediately
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(['/', '/index.html'])))
})

// Activate: clean old caches, claim clients
self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME && k !== SHELL_CACHE).map(k => caches.delete(k))))
      .then(() => clients.claim()),
  )
  // Notify all clients that a new SW is active (update available)
  clients.matchAll({ type: 'window' }).then(cls => {
    for (const client of cls) {
      client.postMessage({ type: 'sw-updated' })
    }
  })
})

// Fetch: cache-first for assets, network-first for shell
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // Skip non-GET and API requests
  if (event.request.method !== 'GET' || shouldSkip(url)) return

  // Hashed assets: cache-first (immutable)
  if (isHashedAsset(url)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
          }
          return response
        })
      }),
    )
    return
  }

  // Shell: network-first with cache fallback (offline support)
  if (isShellRequest(url)) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(SHELL_CACHE).then(cache => cache.put(event.request, clone))
          }
          return response
        })
        .catch(() => caches.match(event.request)),
    )
    return
  }

  // Static files (icons, fonts in /public): cache-first
  if (url.pathname.match(/\.(png|ico|svg|woff2?|webmanifest)$/)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached
        return fetch(event.request).then(response => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
          }
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
