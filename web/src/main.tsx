// If the previous page load crashed (error boundary fired), nuke SW + caches
// so the next load gets fresh code from the network instead of broken cache.
// This MUST run before anything else -- a broken cached bundle could crash again.
if (localStorage.getItem('sw-crash-detected')) {
  localStorage.removeItem('sw-crash-detected')
  ;(async function nukeSWCache() {
    const regs = await navigator.serviceWorker?.getRegistrations()
    if (regs) for (const r of regs) await r.unregister()
    const names = await caches?.keys()
    if (names?.length) {
      for (const n of names) await caches.delete(n)
      location.reload()
    }
  })().catch(() => {})
}

import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app'
import { installLogCapture } from './lib/debug-log'

// Capture console output into ring buffer before anything else runs
installLogCapture()

import { ErrorBoundary } from './components/error-boundary'
import '@fontsource/geist/400.css'
import '@fontsource/geist/500.css'
import '@fontsource/geist/600.css'
import '@fontsource/geist-mono/400.css'
import './styles/globals.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)

// Register service worker for caching + push notifications
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/sw.js')
    .then(reg => {
      // Check for SW updates every hour (browser default is 24h)
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000)
    })
    .catch(() => {})
}
