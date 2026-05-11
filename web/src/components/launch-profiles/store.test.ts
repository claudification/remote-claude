import type { LaunchProfile } from '@shared/launch-profile'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  getLaunchProfilesSnapshot,
  isLaunchProfilesLoading,
  resetLaunchProfilesCache,
  setLaunchProfiles,
  setLaunchProfilesLoading,
  subscribeLaunchProfiles,
} from './store'

function p(name: string): LaunchProfile {
  return { id: `lp_${name}`, name, spawn: {}, createdAt: 1, updatedAt: 1 }
}

beforeEach(() => {
  resetLaunchProfilesCache()
})

describe('store snapshot lifecycle', () => {
  it('starts with a null snapshot', () => {
    expect(getLaunchProfilesSnapshot()).toBeNull()
  })

  it('records the latest profile list', () => {
    setLaunchProfiles([p('A'), p('B')])
    expect(getLaunchProfilesSnapshot()?.map(x => x.name)).toEqual(['A', 'B'])
  })

  it('preserves the empty array snapshot (user emptied the list)', () => {
    setLaunchProfiles([])
    expect(getLaunchProfilesSnapshot()).toEqual([])
  })

  it('reset returns the snapshot to null', () => {
    setLaunchProfiles([p('A')])
    resetLaunchProfilesCache()
    expect(getLaunchProfilesSnapshot()).toBeNull()
  })
})

describe('loading flag', () => {
  it('toggles on and off', () => {
    expect(isLaunchProfilesLoading()).toBe(false)
    setLaunchProfilesLoading(true)
    expect(isLaunchProfilesLoading()).toBe(true)
    setLaunchProfilesLoading(false)
    expect(isLaunchProfilesLoading()).toBe(false)
  })
})

describe('subscribe', () => {
  it('fires when the list changes', () => {
    let received: LaunchProfile[] | null = null
    const unsub = subscribeLaunchProfiles(p => {
      received = p
    })
    setLaunchProfiles([p('A')])
    expect(received).not.toBeNull()
    expect(received?.[0]?.name).toBe('A')
    unsub()
  })

  it('does not fire after unsubscribe', () => {
    let count = 0
    const unsub = subscribeLaunchProfiles(() => {
      count++
    })
    unsub()
    setLaunchProfiles([p('A')])
    expect(count).toBe(0)
  })

  it('supports multiple listeners', () => {
    let calls = 0
    const a = subscribeLaunchProfiles(() => {
      calls++
    })
    const b = subscribeLaunchProfiles(() => {
      calls++
    })
    setLaunchProfiles([p('A')])
    expect(calls).toBe(2)
    a()
    b()
  })
})
