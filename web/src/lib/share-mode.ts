/**
 * Share mode detection and state.
 *
 * When the URL hash is /#/share/TOKEN, the dashboard enters share mode:
 * limited UI, no auth gate, WS connects with ?share=TOKEN.
 *
 * Detection runs eagerly at module load time so the WS URL is correct
 * before any WebSocket connections are established. Authenticated users
 * call clearShareMode() to bypass share mode and use the full dashboard.
 */

export type ShareKind = 'conversation' | 'recap'

// Detect immediately on module load (before WS_URL const is evaluated)
function detectInitial(): { token: string | null; kind: ShareKind } {
  if (typeof window === 'undefined') return { token: null, kind: 'conversation' }
  const hash = window.location.hash.slice(1)
  const hashMatch = hash.match(/^\/?share\/(.+)$/)
  if (hashMatch) return { token: hashMatch[1], kind: 'conversation' }
  // Phase 11: /r/:token redirects to /?share=TOKEN&kind=recap so the SPA
  // can route polymorphic share targets without a server-rendered page.
  const params = new URLSearchParams(window.location.search)
  const queryToken = params.get('share')
  if (queryToken) {
    const kind: ShareKind = params.get('kind') === 'recap' ? 'recap' : 'conversation'
    return { token: queryToken, kind }
  }
  return { token: null, kind: 'conversation' }
}

const initial = detectInitial()
let shareToken: string | null = initial.token
let shareKind: ShareKind = initial.kind

if (shareToken) {
  console.log(`[share] Share mode detected (token: ${shareToken.slice(0, 8)}..., kind: ${shareKind})`)
}

/** Check if we detected a share token. */
export function detectShareMode(): string | null {
  return shareToken
}

/** Returns the share-target kind. Defaults to 'conversation' for backward
 *  compat with old hash-form share URLs that didn't carry a kind hint. */
export function detectShareKind(): ShareKind {
  return shareKind
}

/** Clear share mode (authenticated user redirecting to full dashboard). */
export function clearShareMode(): void {
  shareToken = null
  shareKind = 'conversation'
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
