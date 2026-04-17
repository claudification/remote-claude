/**
 * Unified spawn permission gate.
 *
 * Single source of truth for the cross-transport (HTTP / WS / MCP) checks
 * that every spawn path must agree on. Callers translate their native
 * auth/trust signals into a `SpawnCallerContext` and let this module decide.
 *
 * Base rule: spawn permission is always required.
 * MCP rule: the MCP caller's own project must be `benevolent`.
 * Field rules:
 *   - `permissionMode: 'bypassPermissions'` requires `benevolent` trust
 *   - Overrides of sensitive env keys require `benevolent` trust
 */

import type { SpawnRequest } from './spawn-schema'

export type TrustLevel = 'untrusted' | 'trusted' | 'benevolent'

export type SpawnCallerKind = 'http' | 'ws' | 'mcp'

export type SpawnCallerContext = {
  kind: SpawnCallerKind
  hasSpawnPermission: boolean
  trustLevel: TrustLevel
  /** Caller's own cwd, for MCP cross-project trust checks. null for dashboard callers. */
  cwd: string | null
}

/** Thrown when spawn is denied. Callers map to HTTP 403 / WS error reply. */
export class SpawnPermissionError extends Error {
  code = 'spawn_forbidden'
  field: string | undefined
  required: TrustLevel | 'spawn_permission'
  constructor(message: string, field?: string, required: TrustLevel | 'spawn_permission' = 'spawn_permission') {
    super(message)
    this.name = 'SpawnPermissionError'
    this.field = field
    this.required = required
  }
}

export const SENSITIVE_ENV_KEYS: ReadonlySet<string> = new Set([
  'HOME',
  'PATH',
  'USER',
  'SHELL',
  'LOGNAME',
  'SUDO_USER',
  'ANTHROPIC_API_KEY',
])

/**
 * Unified spawn gate. Throws SpawnPermissionError on deny.
 */
export function assertSpawnAllowed(ctx: SpawnCallerContext, req: SpawnRequest): void {
  if (!ctx.hasSpawnPermission) {
    throw new SpawnPermissionError('Spawn permission required', undefined, 'spawn_permission')
  }
  if (ctx.kind === 'mcp' && ctx.trustLevel !== 'benevolent') {
    throw new SpawnPermissionError('Spawn via MCP requires benevolent trust on caller project', undefined, 'benevolent')
  }
  if (req.permissionMode === 'bypassPermissions' && ctx.trustLevel !== 'benevolent') {
    throw new SpawnPermissionError('bypassPermissions mode requires benevolent trust', 'permissionMode', 'benevolent')
  }
  if (req.env) {
    for (const key of Object.keys(req.env)) {
      if (SENSITIVE_ENV_KEYS.has(key) && ctx.trustLevel !== 'benevolent') {
        throw new SpawnPermissionError(
          `Override of sensitive env "${key}" requires benevolent trust`,
          'env',
          'benevolent',
        )
      }
    }
  }
}

/**
 * Map the wire-level `ProjectSettings.trustLevel` ('default' | 'open' | 'benevolent' | undefined)
 * to the internal {@link TrustLevel} used by {@link assertSpawnAllowed}.
 *
 * - `benevolent` stays `benevolent`
 * - everything else collapses to `trusted` (dashboard default)
 * - `untrusted` is reserved for callers that want to deny by default
 *   (pass `'untrusted'` explicitly, e.g. guest/share sessions)
 */
export function mapProjectTrust(trust: 'default' | 'open' | 'benevolent' | undefined): TrustLevel {
  if (trust === 'benevolent') return 'benevolent'
  return 'trusted'
}
