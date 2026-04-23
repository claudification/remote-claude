/**
 * Session Shares - link-based temporary access to sessions.
 *
 * Generates tokens that grant limited permissions to a specific session CWD.
 * No user registration needed - the token IS the auth.
 * Backed by StoreDriver KVStore (replaces JSON file persistence).
 */

import { randomBytes } from 'node:crypto'
import type { UserGrant } from './permissions'
import type { KVStore } from './store/types'

export interface SessionShare {
  token: string
  sessionCwd: string
  createdAt: number
  expiresAt: number
  createdBy: string
  label?: string
  revoked: boolean
  permissions: string[]
  /** Hide user input messages from shared transcript */
  hideUserInput?: boolean
}

// Default permissions for shared sessions
const DEFAULT_SHARE_PERMISSIONS = ['chat', 'chat:read', 'files:read', 'terminal:read']

const KV_KEY = 'shares'

let shares: SessionShare[] = []
let kv: KVStore | null = null
let expiryTimer: ReturnType<typeof setInterval> | null = null

function save() {
  if (!kv) return
  kv.set(KV_KEY, shares)
}

export function initShares(opts: { kv: KVStore; skipTimers?: boolean }) {
  kv = opts.kv

  // Load existing shares
  const raw = kv.get<SessionShare[]>(KV_KEY)
  if (raw && Array.isArray(raw)) {
    // Clean up expired + revoked on load
    shares = raw.filter(s => !s.revoked && s.expiresAt > Date.now())
    if (shares.length !== raw.length) save()
  } else {
    shares = []
  }

  // Periodic expiry check (every 30s)
  if (!opts.skipTimers) {
    if (expiryTimer) clearInterval(expiryTimer)
    expiryTimer = setInterval(cleanExpired, 30_000)
  }
}

/** Create a new share token. Returns the share object. */
export function createShare(opts: {
  sessionCwd: string
  expiresAt: number
  createdBy: string
  label?: string
  permissions?: string[]
  hideUserInput?: boolean
}): SessionShare {
  // Validate expiry is in the future
  if (opts.expiresAt <= Date.now()) {
    throw new Error('Expiry must be in the future')
  }
  // Cap at 30 days
  const maxExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000
  if (opts.expiresAt > maxExpiry) {
    throw new Error('Maximum share duration is 30 days')
  }

  const token = randomBytes(32).toString('base64url')
  const share: SessionShare = {
    token,
    sessionCwd: opts.sessionCwd,
    createdAt: Date.now(),
    expiresAt: opts.expiresAt,
    createdBy: opts.createdBy,
    label: opts.label,
    revoked: false,
    permissions: opts.permissions || DEFAULT_SHARE_PERMISSIONS,
    hideUserInput: opts.hideUserInput || false,
  }

  shares.push(share)
  save()
  console.log(
    `[shares] Created share for ${opts.sessionCwd} by ${opts.createdBy} (expires ${new Date(opts.expiresAt).toISOString()})`,
  )
  return share
}

/** Validate a share token. Returns the share if valid, null if expired/revoked/not found. */
export function validateShare(token: string): SessionShare | null {
  const share = shares.find(s => s.token === token)
  if (!share) return null
  if (share.revoked) return null
  if (share.expiresAt <= Date.now()) return null
  return share
}

/** Revoke a share. Returns true if found and revoked. */
export function revokeShare(token: string): boolean {
  const share = shares.find(s => s.token === token)
  if (!share) return false
  share.revoked = true
  save()
  console.log(`[shares] Revoked share for ${share.sessionCwd}`)
  return true
}

/** List all active (non-expired, non-revoked) shares. */
export function listShares(): SessionShare[] {
  return shares.filter(s => !s.revoked && s.expiresAt > Date.now())
}

/** List active shares for a specific project. */
export function listSharesForProject(project: string): SessionShare[] {
  return shares.filter(s => !s.revoked && s.expiresAt > Date.now() && s.sessionCwd === project)
}

/** Get a specific share by token (even if expired/revoked, for admin display). */
export function getShare(token: string): SessionShare | undefined {
  return shares.find(s => s.token === token)
}

/** Build synthetic UserGrant[] from a share (for WS permission resolution). */
export function shareToGrants(share: SessionShare): UserGrant[] {
  return [
    {
      legacyCwd: share.sessionCwd,
      permissions: share.permissions as UserGrant['permissions'],
    },
  ]
}

/** Clean expired shares. Called periodically. Returns tokens of newly expired shares. */
export function cleanExpired(): string[] {
  const now = Date.now()
  const expired: string[] = []
  for (const share of shares) {
    if (!share.revoked && share.expiresAt <= now) {
      share.revoked = true
      expired.push(share.token)
      console.log(`[shares] Share expired for ${share.sessionCwd} (created by ${share.createdBy})`)
    }
  }
  if (expired.length > 0) save()
  return expired
}

/** Reload shares from store (for SIGHUP handler). */
export function reloadShares() {
  if (!kv) return
  const raw = kv.get<SessionShare[]>(KV_KEY)
  if (raw && Array.isArray(raw)) {
    shares = raw
  }
}
