/**
 * Share mode detection and state.
 *
 * When the URL hash is /#/share/TOKEN, the dashboard enters share mode:
 * limited UI, no auth gate, WS connects with ?share=TOKEN.
 */

let shareToken: string | null = null

/** Check URL hash for share token. Call once on app init. */
export function detectShareMode(): string | null {
  const hash = window.location.hash.slice(1)
  const match = hash.match(/^share\/(.+)$/)
  if (match) {
    shareToken = match[1]
    return shareToken
  }
  return null
}

/** Get the current share token (null if not in share mode). */
export function getShareToken(): string | null {
  return shareToken
}

/** Whether we're in share mode. */
export function isShareMode(): boolean {
  return shareToken !== null
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
