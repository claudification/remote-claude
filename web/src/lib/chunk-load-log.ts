// Logs every JS/CSS chunk fetch the browser performs into console.debug,
// where debug-log captures it for the in-app DebugConsole. PerformanceObserver
// with `buffered: true` replays the initial bundle's resource entries too, so
// chunks that loaded before this code ran still show up.

const ASSET_RE = /\/assets\/[^/]+\.(js|css|mjs)(?:\?|$)/

function logEntry(entry: PerformanceResourceTiming) {
  if (!ASSET_RE.test(entry.name)) return
  const file = entry.name.split('/').pop()?.split('?')[0] || entry.name
  const size = entry.transferSize || entry.encodedBodySize || 0
  const sizeStr = size > 0 ? `${(size / 1024).toFixed(1)}KB` : '?KB'
  const duration = Math.round(entry.duration)
  const cached = entry.transferSize === 0 && entry.decodedBodySize > 0 ? ' (cache)' : ''
  console.debug(`[chunk] ${file} ${sizeStr} ${duration}ms${cached}`)
}

let installed = false

export function installChunkLoadLog() {
  if (installed || typeof PerformanceObserver === 'undefined') return
  installed = true
  try {
    const obs = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        logEntry(entry as PerformanceResourceTiming)
      }
    })
    // `buffered: true` replays already-recorded entries (the initial bundle).
    obs.observe({ type: 'resource', buffered: true })
  } catch {
    // PerformanceObserver missing options support -- non-fatal, just skip.
  }
}
