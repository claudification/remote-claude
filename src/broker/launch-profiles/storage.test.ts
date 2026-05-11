import { describe, expect, it } from 'bun:test'
import type { LaunchProfile } from '../../shared/launch-profile'
import { newLaunchProfileId } from '../../shared/launch-profile'
import { buildSeedProfiles } from '../../shared/launch-profile-seeds'
import type { KVStore } from '../store/types'
import {
  deleteLaunchProfiles,
  getLaunchProfilesOrSeed,
  getLaunchProfilesRaw,
  launchProfilesKey,
  saveLaunchProfiles,
} from './storage'

function makeKV(): KVStore {
  const map = new Map<string, unknown>()
  return {
    get<T = unknown>(key: string): T | null {
      return (map.get(key) as T) ?? null
    },
    set<T = unknown>(key: string, value: T) {
      map.set(key, value)
    },
    delete(key: string) {
      return map.delete(key)
    },
    keys(prefix?: string) {
      const all = [...map.keys()]
      return prefix ? all.filter(k => k.startsWith(prefix)) : all
    },
  }
}

function p(name: string, overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id: newLaunchProfileId(),
    name,
    spawn: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('launchProfilesKey', () => {
  it('composes the key per user', () => {
    expect(launchProfilesKey('jonas')).toBe('launch-profiles:jonas')
    expect(launchProfilesKey('alice')).toBe('launch-profiles:alice')
  })
})

describe('getLaunchProfilesRaw', () => {
  it('returns null when nothing has ever been written', () => {
    const kv = makeKV()
    expect(getLaunchProfilesRaw(kv, 'jonas')).toBeNull()
  })

  it('returns the empty array when the user emptied the list', () => {
    const kv = makeKV()
    kv.set(launchProfilesKey('jonas'), [])
    expect(getLaunchProfilesRaw(kv, 'jonas')).toEqual([])
  })

  it('roundtrips a saved list', () => {
    const kv = makeKV()
    const list = [p('A'), p('B')]
    kv.set(launchProfilesKey('jonas'), list)
    expect(getLaunchProfilesRaw(kv, 'jonas')).toEqual(list)
  })
})

describe('getLaunchProfilesOrSeed (D5 semantics)', () => {
  it('seeds when KV is null and persists the seeds', () => {
    const kv = makeKV()
    const out = getLaunchProfilesOrSeed(kv, 'jonas', 42)
    expect(out.length).toBe(3)
    expect(getLaunchProfilesRaw(kv, 'jonas')).toEqual(out)
  })

  it('does NOT seed when the user emptied the list', () => {
    const kv = makeKV()
    kv.set(launchProfilesKey('jonas'), [])
    expect(getLaunchProfilesOrSeed(kv, 'jonas')).toEqual([])
  })

  it('returns the existing list verbatim', () => {
    const kv = makeKV()
    const existing = [p('Pre-existing')]
    kv.set(launchProfilesKey('jonas'), existing)
    expect(getLaunchProfilesOrSeed(kv, 'jonas')).toEqual(existing)
  })

  it('seeds per-user (each user gets their own first-load seeds)', () => {
    const kv = makeKV()
    const jonas = getLaunchProfilesOrSeed(kv, 'jonas', 1)
    const alice = getLaunchProfilesOrSeed(kv, 'alice', 2)
    expect(jonas.length).toBe(3)
    expect(alice.length).toBe(3)
    expect(jonas[0]?.createdAt).toBe(1)
    expect(alice[0]?.createdAt).toBe(2)
  })
})

describe('saveLaunchProfiles', () => {
  it('persists a valid list', () => {
    const kv = makeKV()
    const list = [p('A')]
    const res = saveLaunchProfiles(kv, 'jonas', list)
    expect(res.ok).toBe(true)
    expect(getLaunchProfilesRaw(kv, 'jonas')).toEqual(list)
  })

  it('persists the empty array (user emptied the list)', () => {
    const kv = makeKV()
    const res = saveLaunchProfiles(kv, 'jonas', [])
    expect(res.ok).toBe(true)
    expect(getLaunchProfilesRaw(kv, 'jonas')).toEqual([])
  })

  it('rejects a non-array', () => {
    const kv = makeKV()
    const res = saveLaunchProfiles(kv, 'jonas', { wrong: true })
    expect(res.ok).toBe(false)
  })

  it('rejects duplicate names (case-insensitive, trimmed)', () => {
    const kv = makeKV()
    const res = saveLaunchProfiles(kv, 'jonas', [p('Opus '), p('opus')])
    expect(res.ok).toBe(false)
    expect(res.error).toContain('duplicate')
  })

  it('rejects malformed entries', () => {
    const kv = makeKV()
    const bad = [{ id: 'lp_x', name: '', spawn: {}, createdAt: 0, updatedAt: 0 }]
    const res = saveLaunchProfiles(kv, 'jonas', bad)
    expect(res.ok).toBe(false)
  })

  it('accepts the seed list shape', () => {
    const kv = makeKV()
    const res = saveLaunchProfiles(kv, 'jonas', buildSeedProfiles())
    expect(res.ok).toBe(true)
  })

  it('isolates per-user writes', () => {
    const kv = makeKV()
    saveLaunchProfiles(kv, 'jonas', [p('Jonas only')])
    saveLaunchProfiles(kv, 'alice', [p('Alice only')])
    expect(getLaunchProfilesRaw(kv, 'jonas')?.[0]?.name).toBe('Jonas only')
    expect(getLaunchProfilesRaw(kv, 'alice')?.[0]?.name).toBe('Alice only')
  })
})

describe('deleteLaunchProfiles', () => {
  it('removes the entry', () => {
    const kv = makeKV()
    kv.set(launchProfilesKey('jonas'), [])
    expect(deleteLaunchProfiles(kv, 'jonas')).toBe(true)
    expect(getLaunchProfilesRaw(kv, 'jonas')).toBeNull()
  })
})
