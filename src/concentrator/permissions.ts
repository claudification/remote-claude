/**
 * Permission system: grant-based, project-URI-scoped, with roles + permissions.
 *
 * Roles are shorthand for permission bundles (admin -> all permissions).
 * Permissions are granular capabilities (chat, terminal:read, etc.).
 * Grants combine both: roles expand first, then explicit permissions merge in.
 *
 * Grants use `scope` (project URI pattern) for matching. Legacy `cwd` field
 * is auto-upgraded to a scope on evaluation.
 */

import { cwdToProjectUri, matchProjectUri } from '../shared/project-uri'

// ─── Roles (expand into permission sets) ──────────────────────────

export type Role = 'admin'

/** Role -> permission expansion map */
const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    'chat',
    'chat:read',
    'terminal',
    'terminal:read',
    'files',
    'files:read',
    'spawn',
    'settings',
    'voice',
    'notifications',
  ],
}

// ─── Permissions (granular capabilities) ──────────────────────────

export type Permission =
  | 'chat'
  | 'chat:read'
  | 'terminal'
  | 'terminal:read'
  | 'files'
  | 'files:read'
  | 'spawn'
  | 'settings'
  | 'voice'
  | 'notifications'

// ─── Grants ───────────────────────────────────────────────────────

export interface UserGrant {
  /** @deprecated Use `scope` instead. Legacy bare CWD glob pattern from persisted data. */
  legacyCwd?: string
  /** Project URI pattern for scope matching. '*' = all projects. */
  scope?: string
  /** Roles that expand into permission sets */
  roles?: Role[]
  /** Granular permissions (combined with role-expanded permissions) */
  permissions?: Permission[]
  /** Grant is not valid before this timestamp (ms). Omit = immediately valid. */
  notBefore?: number
  /** Grant expires after this timestamp (ms). Omit = never expires. */
  notAfter?: number
}

// ─── Internal helpers ─────────────────────────────────────────────

/** Auto-upgrade a legacy CWD glob to a project URI pattern. */
export function pathToScope(path: string): string {
  if (path === '*') return '*'
  if (path.endsWith('/*')) return `${cwdToProjectUri(path.slice(0, -2))}/*`
  return cwdToProjectUri(path)
}

/** Get the effective scope for a grant (prefer scope, fall back to auto-upgraded legacyCwd). */
function grantScope(grant: UserGrant): string {
  if (grant.scope) return grant.scope
  if (grant.legacyCwd) return pathToScope(grant.legacyCwd)
  return '*'
}

/** Normalize a project URI (or legacy bare CWD) into a project URI for matching. */
function normalizeTarget(project: string): string {
  if (project === '*') return '*'
  if (project.includes('://')) return project
  return cwdToProjectUri(project)
}

function matchGrant(grant: UserGrant, targetUri: string): boolean {
  return matchProjectUri(grantScope(grant), targetUri)
}

function isGrantActive(grant: UserGrant, now = Date.now()): boolean {
  if (grant.notBefore && now < grant.notBefore) return false
  if (grant.notAfter && now > grant.notAfter) return false
  return true
}

// ─── Resolution ───────────────────────────────────────────────────

/**
 * Resolve effective permissions for grants against a project URI.
 * Accepts legacy bare CWD paths (auto-upgraded) or project URIs directly.
 */
export function resolvePermissions(
  grants: UserGrant[],
  project: string,
): { permissions: Set<Permission>; isAdmin: boolean } {
  const result = new Set<Permission>()
  let admin = false
  const now = Date.now()
  const targetUri = normalizeTarget(project)

  for (const grant of grants) {
    if (!isGrantActive(grant, now)) continue
    if (!matchGrant(grant, targetUri)) continue

    // Expand roles into permissions
    if (grant.roles) {
      for (const role of grant.roles) {
        if (role === 'admin') admin = true
        const expanded = ROLE_PERMISSIONS[role]
        if (expanded) for (const p of expanded) result.add(p)
      }
    }

    // Add explicit permissions
    if (grant.permissions) {
      for (const p of grant.permissions) result.add(p)
    }
  }

  // Hierarchical implications
  if (result.has('chat')) result.add('chat:read')
  if (result.has('terminal')) result.add('terminal:read')
  if (result.has('files')) result.add('files:read')

  return { permissions: result, isAdmin: admin }
}

// ─── Resolved flags (what the client receives) ───────────────────

export interface ResolvedPermissions {
  canAdmin: boolean
  canEditUsers: boolean
  canChat: boolean
  canReadChat: boolean
  canTerminal: boolean
  canReadTerminal: boolean
  canFiles: boolean
  canReadFiles: boolean
  canSpawn: boolean
  canSettings: boolean
  canVoice: boolean
  canNotifications: boolean
}

export function resolvePermissionFlags(
  grants: UserGrant[],
  project = '*',
  serverRoles?: string[],
): ResolvedPermissions {
  const { permissions, isAdmin } = resolvePermissions(grants, project)
  return {
    canAdmin: isAdmin,
    canEditUsers: serverRoles?.includes('user-editor') ?? false,
    canChat: permissions.has('chat'),
    canReadChat: permissions.has('chat:read'),
    canTerminal: permissions.has('terminal'),
    canReadTerminal: permissions.has('terminal:read'),
    canFiles: permissions.has('files'),
    canReadFiles: permissions.has('files:read'),
    canSpawn: permissions.has('spawn'),
    canSettings: permissions.has('settings'),
    canVoice: permissions.has('voice'),
    canNotifications: permissions.has('notifications'),
  }
}

// ─── Grant queries ────────────────────────────────────────────────

/**
 * Check if any active grant provides a permission, regardless of project scope.
 * Used for scope-agnostic actions (e.g. file upload to global blob store).
 */
export function hasPermissionAnyCwd(grants: UserGrant[], permission: Permission): boolean {
  const now = Date.now()
  // Also check hierarchical parents (files:read -> files, etc.)
  const toCheck = [permission]
  if (permission === 'chat:read') toCheck.push('chat')
  if (permission === 'terminal:read') toCheck.push('terminal')
  if (permission === 'files:read') toCheck.push('files')

  for (const grant of grants) {
    if (!isGrantActive(grant, now)) continue
    if (grant.roles) {
      for (const role of grant.roles) {
        const expanded = ROLE_PERMISSIONS[role]
        if (expanded && toCheck.some(p => expanded.includes(p))) return true
      }
    }
    if (grant.permissions && toCheck.some(p => grant.permissions?.includes(p))) return true
  }
  return false
}

export function hasAnyProjectAccess(grants: UserGrant[], project: string): boolean {
  const now = Date.now()
  const targetUri = normalizeTarget(project)
  return grants.some(g => isGrantActive(g, now) && matchGrant(g, targetUri))
}

/** @deprecated Use hasAnyProjectAccess */
export const hasAnyCwdAccess = hasAnyProjectAccess

export function allGrantsExpired(grants: UserGrant[]): boolean {
  if (grants.length === 0) return true
  const now = Date.now()
  return grants.every(g => g.notAfter && g.notAfter < now)
}
