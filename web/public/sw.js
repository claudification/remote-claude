/**
 * Service Worker for Push Notifications
 * Handles push events and notification clicks
 */

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
    // Vibrate pattern for mobile
    vibrate: [200, 100, 200],
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()

  const url = event.notification.data?.url || '/'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Focus existing window if available
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          client.focus()
          client.navigate(url)
          return
        }
      }
      // Open new window
      return clients.openWindow(url)
    }),
  )
})

// Activate immediately
self.addEventListener('activate', event => {
  event.waitUntil(clients.claim())
})
