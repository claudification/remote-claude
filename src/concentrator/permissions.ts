/**
 * Permission system: grant-based, CWD-scoped, with temporal bounds.
 *
 * Users have grants: [{ cwd, permissions, notBefore?, notAfter? }]
 * Each grant binds a set of permissions to a CWD glob pattern.
 * Resolution is per-session: check all grants against the session's CWD.
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

export const ALL_PERMISSIONS: Permission[] = [
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

export interface UserGrant {
  /** CWD glob pattern. '*' = all projects. */
  cwd: string
  /** What the user can do with matching sessions */
  permissions: Permission[]
  /** Grant is not valid before this timestamp (ms). Omit = immediately valid. */
  notBefore?: number
  /** Grant expires after this timestamp (ms). Omit = never expires. */
  notAfter?: number
}

/**
 * Simple glob matching for CWD patterns.
 * Supports: '*' (match all), '/exact/path', '/prefix/*' (trailing wildcard).
 */
function matchCwdGlob(pattern: string, cwd: string): boolean {
  if (pattern === '*') return true
  if (pattern === cwd) return true
  // Trailing wildcard: /foo/bar/* matches /foo/bar/anything
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1) // keep the trailing /
    return cwd.startsWith(prefix) || cwd === pattern.slice(0, -2)
  }
  return false
}

/**
 * Check if a grant is temporally valid right now.
 */
function isGrantActive(grant: UserGrant, now = Date.now()): boolean {
  if (grant.notBefore && now < grant.notBefore) return false
  if (grant.notAfter && now > grant.notAfter) return false
  return true
}

/**
 * Resolve effective permissions for a user against a specific CWD.
 * Returns the union of all matching, active grants.
 */
export function resolvePermissions(grants: UserGrant[], cwd: string): Set<Permission> {
  const result = new Set<Permission>()
  const now = Date.now()

  for (const grant of grants) {
    if (!isGrantActive(grant, now)) continue
    if (!matchCwdGlob(grant.cwd, cwd)) continue
    for (const p of grant.permissions) result.add(p)
  }

  // admin implies everything
  if (result.has('admin')) {
    for (const p of ALL_PERMISSIONS) result.add(p)
  }
  // Hierarchical implications
  if (result.has('chat')) result.add('chat:read')
  if (result.has('terminal')) result.add('terminal:read')
  if (result.has('files')) result.add('files:read')

  return result
}

/**
 * Check if grants give ANY permission for ANY CWD (used to filter session visibility).
 * A grant with cwd '*' matches everything. Otherwise checks specific CWD.
 */
export function hasAnyCwdAccess(grants: UserGrant[], cwd: string): boolean {
  const now = Date.now()
  return grants.some(g => isGrantActive(g, now) && matchCwdGlob(g.cwd, cwd))
}

/**
 * Check if grants include admin for any CWD (global admin check).
 */
export function isAdmin(grants: UserGrant[]): boolean {
  const now = Date.now()
  return grants.some(g => isGrantActive(g, now) && g.permissions.includes('admin'))
}

/**
 * Check if a user has ONLY chat/chat:read/voice permissions (no power perms).
 * Used to auto-detect normie users for the simplified chat view.
 */
export function isNormieUser(grants: UserGrant[]): boolean {
  if (isAdmin(grants)) return false
  const powerPerms: Permission[] = ['terminal', 'terminal:read', 'files', 'files:read', 'spawn', 'settings']
  const now = Date.now()
  for (const g of grants) {
    if (!isGrantActive(g, now)) continue
    if (g.permissions.some(p => powerPerms.includes(p))) return false
  }
  return true
}
