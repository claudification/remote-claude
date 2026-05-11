/**
 * Session Shares - link-based temporary access to sessions.
 *
 * Generates tokens that grant limited permissions to a specific project.
 * No user registration needed - the token IS the auth.
 * Backed by StoreDriver KVStore (replaces JSON file persistence).
 */

import { randomBytes } from 'node:crypto'
import { cwdToProjectUri } from '../shared/project-uri'
import type { UserGrant } from './permissions'
import type { KVStore } from './store/types'

export type ShareTargetKind = 'conversation' | 'recap'

export interface ConversationShare {
  token: string
  project: string
  createdAt: number
  expiresAt: number
  createdBy: string
  label?: string
  revoked: boolean
  permissions: string[]
  /** Hide user input messages from shared transcript */
  hideUserInput?: boolean
  /** Polymorphic target kind. Default 'conversation' for backward compat.
   *  'recap' shares grant read on a single stored recap document, not on the
   *  underlying project's conversations. */
  targetKind?: ShareTargetKind
  /** Polymorphic target id. For 'conversation' shares this is implicitly the
   *  project (legacy). For 'recap' shares this is the recap_xxx... id. */
  targetId?: string
}

// Default permissions for shared conversations
const DEFAULT_SHARE_PERMISSIONS = ['chat', 'chat:read', 'files:read', 'terminal:read']

const KV_KEY = 'shares'

let shares: ConversationShare[] = []
let kv: KVStore | null = null
let expiryTimer: ReturnType<typeof setInterval> | null = null

function save() {
  if (!kv) return
  kv.set(KV_KEY, shares)
}

export function initShares(opts: { kv: KVStore; skipTimers?: boolean }) {
  kv = opts.kv

  // Load existing shares
  const raw = kv.get<ConversationShare[]>(KV_KEY)
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
  project: string
  expiresAt: number
  createdBy: string
  label?: string
  permissions?: string[]
  hideUserInput?: boolean
  targetKind?: ShareTargetKind
  targetId?: string
}): ConversationShare {
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
  const share: ConversationShare = {
    token,
    project: opts.project,
    createdAt: Date.now(),
    expiresAt: opts.expiresAt,
    createdBy: opts.createdBy,
    label: opts.label,
    revoked: false,
    permissions: opts.permissions || DEFAULT_SHARE_PERMISSIONS,
    hideUserInput: opts.hideUserInput || false,
    targetKind: opts.targetKind,
    targetId: opts.targetId,
  }

  shares.push(share)
  save()
  console.log(
    `[shares] Created share for ${opts.project} by ${opts.createdBy} (expires ${new Date(opts.expiresAt).toISOString()})`,
  )
  return share
}

/** Validate a share token. Returns the share if valid, null if expired/revoked/not found. */
export function validateShare(token: string): ConversationShare | null {
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
  console.log(`[shares] Revoked share for ${share.project}`)
  return true
}

/** List all active (non-expired, non-revoked) shares. */
export function listShares(): ConversationShare[] {
  return shares.filter(s => !s.revoked && s.expiresAt > Date.now())
}

/** List active shares for a specific project. */
function _listSharesForProject(project: string): ConversationShare[] {
  return shares.filter(s => !s.revoked && s.expiresAt > Date.now() && s.project === project)
}

/** Get a specific share by token (even if expired/revoked, for admin display). */
export function getShare(token: string): ConversationShare | undefined {
  return shares.find(s => s.token === token)
}

/** Build synthetic UserGrant[] from a share (for WS permission resolution).
 *
 * The share's `project` field can be either a canonical URI (`claude://...`)
 * or a legacy bare CWD path. We always emit `scope` (canonical), so the
 * permission resolver doesn't have to fall back through `legacyCwd`.
 * (Audit M2)
 */
export function shareToGrants(share: ConversationShare): UserGrant[] {
  const scope = share.project.includes('://') ? share.project : cwdToProjectUri(share.project)
  return [
    {
      scope,
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
      console.log(`[shares] Share expired for ${share.project} (created by ${share.createdBy})`)
    }
  }
  if (expired.length > 0) save()
  return expired
}

/** Reload shares from store (for SIGHUP handler). */
function _reloadShares() {
  if (!kv) return
  const raw = kv.get<ConversationShare[]>(KV_KEY)
  if (raw && Array.isArray(raw)) {
    shares = raw
  }
}
