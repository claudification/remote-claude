/**
 * Per-user storage for launch profiles, keyed in the broker KV.
 *
 * Key format: `launch-profiles:${userName}`.
 *
 * Seeding semantics (D5):
 *   null  -> never written; the caller may seed the user's first list
 *   []    -> user emptied the list; preserve verbatim, do NOT re-seed
 */

import { LAUNCH_PROFILE_MAX_COUNT, type LaunchProfile, launchProfileListSchema } from '../../shared/launch-profile'
import { buildSeedProfiles } from '../../shared/launch-profile-seeds'
import type { KVStore } from '../store/types'

const KEY_PREFIX = 'launch-profiles:'

export function launchProfilesKey(userName: string): string {
  return `${KEY_PREFIX}${userName}`
}

export function getLaunchProfilesRaw(kv: KVStore, userName: string): LaunchProfile[] | null {
  return kv.get<LaunchProfile[]>(launchProfilesKey(userName))
}

export function getLaunchProfilesOrSeed(kv: KVStore, userName: string, nowMs: number = Date.now()): LaunchProfile[] {
  const raw = getLaunchProfilesRaw(kv, userName)
  if (raw === null) {
    const seeds = buildSeedProfiles(nowMs)
    kv.set(launchProfilesKey(userName), seeds)
    return seeds
  }
  return raw
}

export interface SaveLaunchProfilesResult {
  ok: boolean
  error?: string
  profiles?: LaunchProfile[]
}

export function saveLaunchProfiles(kv: KVStore, userName: string, profiles: unknown): SaveLaunchProfilesResult {
  const validated = validateProfileList(profiles)
  if (!validated.ok) return validated
  kv.set(launchProfilesKey(userName), validated.profiles)
  return validated
}

function validateProfileList(profiles: unknown): SaveLaunchProfilesResult {
  const parsed = launchProfileListSchema.safeParse(profiles)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid launch profile list' }
  }
  if (parsed.data.length > LAUNCH_PROFILE_MAX_COUNT) {
    return { ok: false, error: `at most ${LAUNCH_PROFILE_MAX_COUNT} profiles allowed` }
  }
  const dup = findDuplicateName(parsed.data)
  if (dup) return { ok: false, error: `duplicate profile name: ${dup}` }
  return { ok: true, profiles: parsed.data }
}

export function deleteLaunchProfiles(kv: KVStore, userName: string): boolean {
  return kv.delete(launchProfilesKey(userName))
}

function findDuplicateName(profiles: LaunchProfile[]): string | null {
  const seen = new Set<string>()
  for (const p of profiles) {
    const key = p.name.trim().toLowerCase()
    if (seen.has(key)) return p.name
    seen.add(key)
  }
  return null
}
