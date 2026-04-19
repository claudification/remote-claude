/**
 * Share mode detection and state.
 *
 * When the URL hash is /#/share/TOKEN, the dashboard enters share mode:
 * limited UI, no auth gate, WS connects with ?share=TOKEN.
 *
 * Detection runs eagerly at module load time so the WS URL is correct
 * before any WebSocket connections are established.
 */

// Detect immediately on module load (before WS_URL const is evaluated)
const hash = typeof window !== 'undefined' ? window.location.hash.slice(1) : ''
const shareMatch = hash.match(/^\/?share\/(.+)$/)
const shareToken: string | null = shareMatch ? shareMatch[1] : null

if (shareToken) {
  console.log(`[share] Share mode detected (token: ${shareToken.slice(0, 8)}...)`)
}

/** Check if we detected a share token. */
export function detectShareMode(): string | null {
  return shareToken
}

/** Build the WS URL with share token appended if in share mode. */
export function buildWsUrl(): string {
  const base = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
  if (shareToken) return `${base}?share=${encodeURIComponent(shareToken)}`
  return base
}

/** Build an HTTP URL with share token appended if in share mode. */
export function appendShareParam(url: string): string {
  if (!shareToken) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}share=${encodeURIComponent(shareToken)}`
}
