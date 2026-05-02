/**
 * Name of the implicit local sentinel -- used as the URI authority when no
 * explicit sentinel host is specified.
 *
 * Every Claude project URI has the shape `claude://{sentinel}/{absolute_path}`.
 * The authority slot IS the sentinel name: today there's one sentinel (the
 * local install, named `default`); when multi-sentinel lands, other hosts use
 * their own names (e.g. `claude://laptop/...`, `claude://workstation/...`).
 *
 * Legacy forms still accepted on input:
 *   - `claude:///path`       (sentinel-less -- upgraded to `default` on normalize)
 *   - `claude:////path`      (quad-slash concat scar -- collapsed on normalize)
 *
 * Both forms round-trip through `normalizeProjectUri()` to the canonical
 * `claude://default/{path}` form, and `matchProjectUri()` treats
 * empty authority as equivalent to `default` so pre-migration grants keep
 * matching post-migration session scopes.
 */
export const DEFAULT_SENTINEL_NAME = 'default'

export interface ProjectUri {
  scheme: string
  authority?: string
  path: string
  fragment?: string
  raw: string
}

export interface ProjectUriParts {
  scheme: string
  authority?: string
  path: string
  fragment?: string
}

const WILDCARD_URI: ProjectUri = Object.freeze({
  scheme: '*',
  path: '*',
  raw: '*',
})

function parseSchemeWildcard(uri: string): ProjectUri {
  const scheme = uri.slice(0, uri.indexOf(':'))
  return { scheme: scheme.toLowerCase(), path: '*', raw: uri }
}

export function parseProjectUri(uri: string): ProjectUri {
  if (uri === '*') return { ...WILDCARD_URI }

  if (/^[a-z][a-z0-9+.-]*:\*$/i.test(uri)) {
    return parseSchemeWildcard(uri)
  }

  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new Error(`Invalid project URI: ${uri}`)
  }

  const scheme = url.protocol.slice(0, -1).toLowerCase()
  if (!scheme) throw new Error(`Invalid project URI: missing scheme in ${uri}`)

  const authority = url.hostname || undefined
  const path = decodeURIComponent(url.pathname) || '/'
  const fragment = url.hash ? url.hash.slice(1) : undefined

  return { scheme, authority, path, fragment, raw: uri }
}

export function buildProjectUri(parts: ProjectUriParts): string {
  const scheme = parts.scheme.toLowerCase()
  // Claude scheme defaults to DEFAULT_SENTINEL_NAME when authority is omitted.
  // Other schemes keep the legacy empty-authority behavior.
  const authority = parts.authority ?? (scheme === 'claude' ? DEFAULT_SENTINEL_NAME : '')
  const fragment = parts.fragment ? `#${parts.fragment}` : ''
  return `${scheme}://${authority}${parts.path}${fragment}`
}

export function cwdToProjectUri(cwd: string, scheme = 'claude', authority?: string): string {
  return buildProjectUri({ scheme, authority, path: cwd })
}

/** Authority for matching purposes: empty/undefined on the `claude` scheme is
 *  treated as `default` so pre-canonicalization URIs still match current ones. */
function authorityForMatch(parsed: ProjectUri): string {
  if (parsed.authority) return parsed.authority
  return parsed.scheme === 'claude' ? DEFAULT_SENTINEL_NAME : ''
}

export function matchProjectUri(pattern: string, uri: string): boolean {
  if (pattern === '*') return true

  if (/^[a-z][a-z0-9+.-]*:\*$/i.test(pattern)) {
    const patternScheme = pattern.slice(0, pattern.indexOf(':')).toLowerCase()
    const parsed = parseProjectUri(uri)
    return parsed.scheme === patternScheme
  }

  if (pattern.endsWith('/*')) {
    const patternBase = pattern.slice(0, -2)
    const parsedPattern = parseProjectUri(patternBase)
    const parsedUri = parseProjectUri(uri)

    if (parsedPattern.scheme !== parsedUri.scheme) return false
    if (authorityForMatch(parsedPattern) !== authorityForMatch(parsedUri)) return false

    return parsedUri.path.startsWith(`${parsedPattern.path}/`) || parsedUri.path === parsedPattern.path
  }

  return normalizeProjectUri(pattern) === normalizeProjectUri(uri)
}

export function normalizeProjectUri(uri: string): string {
  if (uri === '*') return '*'
  if (/^[a-z][a-z0-9+.-]*:\*$/i.test(uri)) {
    return `${uri.slice(0, uri.indexOf(':')).toLowerCase()}:*`
  }

  const parsed = parseProjectUri(uri)
  let path = parsed.path
  // Collapse runs of leading slashes to a single slash. Pre-2026-04-25 data
  // produced by `'claude:///' || cwd` concatenation (where cwd was already
  // absolute) yields URIs like 'claude:////Users/...' which WHATWG URL parses
  // as authority='' + path='//Users/...' -- canonical form is a single slash.
  if (path.startsWith('//')) path = path.replace(/^\/+/, '/')
  if (path !== '/' && path.endsWith('/')) {
    path = path.slice(0, -1)
  }

  const fragment = parsed.fragment ? `#${parsed.fragment}` : ''
  // Upgrade empty authority to DEFAULT_SENTINEL_NAME for the `claude` scheme,
  // so both legacy (`claude:///path`) and current (`claude://default/path`)
  // forms canonicalize identically. Other schemes keep their literal authority.
  const authority = parsed.authority || (parsed.scheme === 'claude' ? DEFAULT_SENTINEL_NAME : '')
  return `${parsed.scheme}://${authority}${path}${fragment}`
}

export function projectWithoutConversation(uri: string): string {
  const hashIdx = uri.indexOf('#')
  return hashIdx >= 0 ? uri.slice(0, hashIdx) : uri
}

export function extractProjectLabel(uri: string): string {
  if (uri === '*' || /^[a-z][a-z0-9+.-]*:\*$/i.test(uri)) return uri

  const parsed = parseProjectUri(uri)
  const segments = parsed.path.split('/').filter(Boolean)
  return segments.length > 0 ? segments[segments.length - 1] : parsed.path
}

function cmp(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Compare two project URIs for equality / sorting at the PROJECT level.
 *
 * The conversation fragment (`#conv-xyz`) is irrelevant at the project level
 * and is stripped before comparison. Authority forms are equivalent
 * (`claude:///x` == `claude://default/x`). Scheme case, trailing slashes,
 * and multi-slash scars are all normalized.
 *
 * Returns -1 / 0 / 1 suitable for Array.sort(). Safe on both server and web.
 *
 * Use this when grouping / matching by project identity -- e.g. listing
 * conversations for a project, permission scope matching, sidebar grouping.
 */
export function compareProjectUri(a: string, b: string): number {
  return cmp(normalizeProjectUri(projectWithoutConversation(a)), normalizeProjectUri(projectWithoutConversation(b)))
}

/**
 * Compare two project URIs at the SESSION level, including the conversation
 * fragment. `claude://default/foo#conv-1` and `claude://default/foo#conv-2`
 * are distinct; `claude://default/foo` (no fragment) differs from either.
 *
 * Otherwise same normalization rules as compareProjectUri.
 *
 * Use this when matching a specific session (e.g. reconnect routing, live
 * session identity) where the conversation within a project matters.
 */
export function compareProjectConversationUri(a: string, b: string): number {
  return cmp(normalizeProjectUri(a), normalizeProjectUri(b))
}

export function isSameProject(a: string, b: string): boolean {
  return compareProjectUri(a, b) === 0
}

export function isSameProjectConversation(a: string, b: string): boolean {
  return compareProjectConversationUri(a, b) === 0
}
