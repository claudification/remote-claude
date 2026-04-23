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
  const authority = parts.authority ?? ''
  const fragment = parts.fragment ? `#${parts.fragment}` : ''
  return `${scheme}://${authority}${parts.path}${fragment}`
}

export function cwdToProjectUri(cwd: string, scheme = 'claude', authority?: string): string {
  return buildProjectUri({ scheme, authority, path: cwd })
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
    if (parsedPattern.authority !== parsedUri.authority) return false

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
  if (path !== '/' && path.endsWith('/')) {
    path = path.slice(0, -1)
  }

  const fragment = parsed.fragment ? `#${parsed.fragment}` : ''
  const authority = parsed.authority ?? ''
  return `${parsed.scheme}://${authority}${path}${fragment}`
}

export function extractProjectLabel(uri: string): string {
  if (uri === '*' || /^[a-z][a-z0-9+.-]*:\*$/i.test(uri)) return uri

  const parsed = parseProjectUri(uri)
  const segments = parsed.path.split('/').filter(Boolean)
  return segments.length > 0 ? segments[segments.length - 1] : parsed.path
}

export function isSameProject(a: string, b: string): boolean {
  return normalizeProjectUri(a) === normalizeProjectUri(b)
}
