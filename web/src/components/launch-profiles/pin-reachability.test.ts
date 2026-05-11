import type { LaunchProfile } from '@shared/launch-profile'
import { describe, expect, it } from 'vitest'
import type { SentinelStatusInfo } from '@/hooks/use-conversations'
import { checkProfilePins, isSentinelReachable, resolveProjectCwd } from './pin-reachability'

const ONLINE: SentinelStatusInfo[] = [
  { sentinelId: 'snt_1', alias: 'tower', connected: true },
  { sentinelId: 'snt_2', alias: 'cabin', connected: false },
]

function makeProfile(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return { id: 'lp_x', name: 'X', spawn: {}, createdAt: 0, updatedAt: 0, ...overrides }
}

describe('isSentinelReachable', () => {
  it('returns true when default and at least one sentinel is connected', () => {
    expect(isSentinelReachable(undefined, ONLINE)).toBe(true)
    expect(isSentinelReachable('default', ONLINE)).toBe(true)
  })

  it('returns false when default but every sentinel is offline', () => {
    const all = [{ sentinelId: 'snt_1', alias: 'tower', connected: false }]
    expect(isSentinelReachable(undefined, all)).toBe(false)
  })

  it('matches by alias', () => {
    expect(isSentinelReachable('tower', ONLINE)).toBe(true)
    expect(isSentinelReachable('cabin', ONLINE)).toBe(false)
  })

  it('matches by sentinelId as a fallback', () => {
    expect(isSentinelReachable('snt_1', ONLINE)).toBe(true)
  })

  it('returns false for unknown alias', () => {
    expect(isSentinelReachable('mystery', ONLINE)).toBe(false)
  })
})

describe('resolveProjectCwd', () => {
  it('returns the path component', () => {
    expect(resolveProjectCwd('claude://default/Users/jonas/projects/foo')).toBe('/Users/jonas/projects/foo')
  })

  it('returns null for unparseable URIs', () => {
    expect(resolveProjectCwd('not-a-uri')).toBeNull()
  })
})

describe('checkProfilePins', () => {
  it('passes when no pins are set and at least one sentinel is online', () => {
    const out = checkProfilePins(makeProfile(), ONLINE)
    expect(out.ok).toBe(true)
  })

  it('blocks on offline sentinel pin', () => {
    const out = checkProfilePins(makeProfile({ sentinel: 'cabin' }), ONLINE)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('cabin')
  })

  it('blocks on invalid project URI', () => {
    const out = checkProfilePins(makeProfile({ project: 'whatever' }), ONLINE)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('whatever')
  })

  it('returns cwd from a valid project URI', () => {
    const out = checkProfilePins(makeProfile({ project: 'claude://default/Users/jonas/projects/foo' }), ONLINE)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.cwd).toBe('/Users/jonas/projects/foo')
  })
})
