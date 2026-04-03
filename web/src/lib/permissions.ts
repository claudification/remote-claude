/**
 * Frontend permission helpers.
 * Mirrors src/concentrator/permissions.ts logic for UI gating.
 * Server enforces regardless -- this is purely for hiding UI elements.
 */

export type Permission =
  | 'admin'
  | 'chat'
  | 'chat:read'
  | 'terminal'
  | 'terminal:read'
  | 'files'
  | 'files:read'
  | 'spawn'
  | 'settings'
  | 'voice'

export interface UserGrant {
  cwd: string
  permissions: Permission[]
  notBefore?: number
  notAfter?: number
}

const ALL_PERMISSIONS: Permission[] = [
  'admin',
  'chat',
  'chat:read',
  'terminal',
  'terminal:read',
  'files',
  'files:read',
  'spawn',
  'settings',
  'voice',
]

function matchCwdGlob(pattern: string, cwd: string): boolean {
  if (pattern === '*') return true
  if (pattern === cwd) return true
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1)
    return cwd.startsWith(prefix) || cwd === pattern.slice(0, -2)
  }
  return false
}

function isGrantActive(grant: UserGrant, now = Date.now()): boolean {
  if (grant.notBefore && now < grant.notBefore) return false
  if (grant.notAfter && now > grant.notAfter) return false
  return true
}

/**
 * Check if grants include a specific permission for a given CWD.
 * Use '*' as cwd for global checks (settings, session order).
 */
export function hasPermission(grants: UserGrant[], permission: Permission, cwd = '*'): boolean {
  const now = Date.now()
  for (const grant of grants) {
    if (!isGrantActive(grant, now)) continue
    if (!matchCwdGlob(grant.cwd, cwd)) continue
    // Direct match
    if (grant.permissions.includes(permission)) return true
    // Admin implies everything
    if (grant.permissions.includes('admin')) return true
    // Hierarchical: chat implies chat:read, terminal implies terminal:read, files implies files:read
    if (permission === 'chat:read' && grant.permissions.includes('chat')) return true
    if (permission === 'terminal:read' && grant.permissions.includes('terminal')) return true
    if (permission === 'files:read' && grant.permissions.includes('files')) return true
  }
  return false
}

/**
 * Check if grants give ANY access to a session's CWD.
 * Used for filtering the session list.
 */
export function hasAnyCwdAccess(grants: UserGrant[], cwd: string): boolean {
  const now = Date.now()
  return grants.some(g => isGrantActive(g, now) && matchCwdGlob(g.cwd, cwd))
}

/**
 * Resolve all named permission flags for a specific CWD.
 * Returns an object with clear boolean properties.
 */
export interface ResolvedPermissions {
  canAdmin: boolean
  canChat: boolean
  canReadChat: boolean
  canTerminal: boolean
  canReadTerminal: boolean
  canFiles: boolean
  canReadFiles: boolean
  canSpawn: boolean
  canSettings: boolean
  canVoice: boolean
}

export function resolvePermissionsFor(grants: UserGrant[], cwd = '*'): ResolvedPermissions {
  return {
    canAdmin: hasPermission(grants, 'admin', cwd),
    canChat: hasPermission(grants, 'chat', cwd),
    canReadChat: hasPermission(grants, 'chat:read', cwd),
    canTerminal: hasPermission(grants, 'terminal', cwd),
    canReadTerminal: hasPermission(grants, 'terminal:read', cwd),
    canFiles: hasPermission(grants, 'files', cwd),
    canReadFiles: hasPermission(grants, 'files:read', cwd),
    canSpawn: hasPermission(grants, 'spawn', cwd),
    canSettings: hasPermission(grants, 'settings', cwd),
    canVoice: hasPermission(grants, 'voice', cwd),
  }
}
