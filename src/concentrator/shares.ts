/**
 * Session Shares - link-based temporary access to sessions.
 *
 * Generates tokens that grant limited permissions to a specific session CWD.
 * No user registration needed - the token IS the auth.
 * Persisted to {cacheDir}/shares.json.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UserGrant } from './permissions'

export interface SessionShare {
  token: string
  sessionCwd: string
  createdAt: number
  expiresAt: number
  createdBy: string
  label?: string
  revoked: boolean
  permissions: string[]
}

// Default permissions for shared sessions
const DEFAULT_SHARE_PERMISSIONS = ['chat', 'chat:read', 'files:read', 'terminal:read']

let shares: SessionShare[] = []
let sharesFilePath = ''
let expiryTimer: ReturnType<typeof setInterval> | null = null

// Debounced save
let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 500)
}

function save() {
  if (!sharesFilePath) return
  try {
    writeFileSync(sharesFilePath, JSON.stringify(shares, null, 2), { mode: 0o600 })
  } catch (err) {
    console.error('[shares] Failed to save:', err)
  }
}

export function initShares(opts: { cacheDir: string; skipTimers?: boolean }) {
  sharesFilePath = join(opts.cacheDir, 'shares.json')

  // Load existing shares
  try {
    if (existsSync(sharesFilePath)) {
      shares = JSON.parse(readFileSync(sharesFilePath, 'utf-8'))
      // Clean up expired + revoked on load
      const before = shares.length
      shares = shares.filter(s => !s.revoked && s.expiresAt > Date.now())
      if (shares.length !== before) save()
    }
  } catch {
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
  }

  shares.push(share)
  scheduleSave()
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
  scheduleSave()
  console.log(`[shares] Revoked share for ${share.sessionCwd}`)
  return true
}

/** List all active (non-expired, non-revoked) shares. */
export function listShares(): SessionShare[] {
  return shares.filter(s => !s.revoked && s.expiresAt > Date.now())
}

/** List active shares for a specific CWD. */
export function listSharesForCwd(cwd: string): SessionShare[] {
  return shares.filter(s => !s.revoked && s.expiresAt > Date.now() && s.sessionCwd === cwd)
}

/** Get a specific share by token (even if expired/revoked, for admin display). */
export function getShare(token: string): SessionShare | undefined {
  return shares.find(s => s.token === token)
}

/** Build synthetic UserGrant[] from a share (for WS permission resolution). */
export function shareToGrants(share: SessionShare): UserGrant[] {
  return [
    {
      cwd: share.sessionCwd,
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
  if (expired.length > 0) scheduleSave()
  return expired
}

/** Reload shares from disk (for SIGHUP handler). */
export function reloadShares() {
  if (!sharesFilePath) return
  try {
    if (existsSync(sharesFilePath)) {
      shares = JSON.parse(readFileSync(sharesFilePath, 'utf-8'))
    }
  } catch {}
}
