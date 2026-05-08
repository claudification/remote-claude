// If the previous page load crashed (error boundary fired), nuke SW + caches
// so the next load gets fresh code from the network instead of broken cache.
// This MUST run before anything else -- a broken cached bundle could crash again.
// 2s deadline guarantees reload even if cache/SW ops hang.
if (localStorage.getItem('sw-crash-detected')) {
  localStorage.removeItem('sw-crash-detected')
  const go = () => window.location.replace(`${location.origin}/?_cb=${Date.now()}${location.hash}`)
  const deadline = setTimeout(go, 2000)
  ;(async () => {
    try {
      const regs = await navigator.serviceWorker?.getRegistrations()
      if (regs) await Promise.allSettled(regs.map(r => r.unregister()))
    } catch {}
    try {
      const keys = await caches?.keys()
      if (keys) await Promise.allSettled(keys.map(k => caches.delete(k)))
    } catch {}
    clearTimeout(deadline)
    go()
  })().catch(go)
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
import { loadAndApplyTheme } from './lib/themes'

loadAndApplyTheme()

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
      // Check for SW updates immediately on load + every hour
      reg.update().catch(() => {})
      setInterval(() => reg.update().catch(() => {}), 10 * 60 * 1000)
    })
    .catch(() => {})
}
