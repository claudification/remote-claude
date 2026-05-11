import type { LaunchProfile } from '@shared/launch-profile'
import { describe, expect, it } from 'vitest'
import {
  blankProfile,
  findDuplicateChord,
  findDuplicateName,
  findProfile,
  moveProfile,
  removeProfile,
  replaceProfile,
} from './draft'

function p(id: string, name: string, extra: Partial<LaunchProfile> = {}): LaunchProfile {
  return { id, name, spawn: {}, createdAt: 0, updatedAt: 0, ...extra }
}

describe('blankProfile', () => {
  it('starts on the claude backend with immediate=true', () => {
    const b = blankProfile(1234)
    expect(b.spawn.backend).toBe('claude')
    expect(b.immediate).toBe(true)
    expect(b.createdAt).toBe(1234)
    expect(b.id.startsWith('lp_')).toBe(true)
  })
})

describe('replaceProfile', () => {
  it('replaces by id', () => {
    const list = [p('a', 'A'), p('b', 'B')]
    const next = p('a', 'A renamed')
    expect(replaceProfile(list, next).map(x => x.name)).toEqual(['A renamed', 'B'])
  })

  it('appends when id is new', () => {
    const list = [p('a', 'A')]
    expect(replaceProfile(list, p('b', 'B'))).toHaveLength(2)
  })
})

describe('removeProfile', () => {
  it('removes by id', () => {
    const list = [p('a', 'A'), p('b', 'B')]
    expect(removeProfile(list, 'a').map(x => x.id)).toEqual(['b'])
  })
})

describe('moveProfile', () => {
  it('moves up', () => {
    const list = [p('a', 'A'), p('b', 'B')]
    expect(moveProfile(list, 'b', 'up').map(x => x.id)).toEqual(['b', 'a'])
  })

  it('moves down', () => {
    const list = [p('a', 'A'), p('b', 'B')]
    expect(moveProfile(list, 'a', 'down').map(x => x.id)).toEqual(['b', 'a'])
  })

  it('no-op at boundary', () => {
    const list = [p('a', 'A'), p('b', 'B')]
    expect(moveProfile(list, 'a', 'up')).toBe(list)
    expect(moveProfile(list, 'b', 'down')).toBe(list)
  })
})

describe('findProfile', () => {
  it('returns the match or undefined', () => {
    const list = [p('a', 'A')]
    expect(findProfile(list, 'a')?.name).toBe('A')
    expect(findProfile(list, 'z')).toBeUndefined()
    expect(findProfile(list, undefined)).toBeUndefined()
  })
})

describe('findDuplicateName', () => {
  it('detects case-insensitive duplicates', () => {
    expect(findDuplicateName([p('a', 'Opus'), p('b', 'opus')])).toBe('opus')
  })

  it('ignores empty names', () => {
    expect(findDuplicateName([p('a', ''), p('b', '')])).toBeNull()
  })

  it('returns null when unique', () => {
    expect(findDuplicateName([p('a', 'X'), p('b', 'Y')])).toBeNull()
  })
})

describe('findDuplicateChord', () => {
  it('detects duplicate chords', () => {
    expect(findDuplicateChord([p('a', 'A', { chord: 'o' }), p('b', 'B', { chord: 'o' })])).toBe('o')
  })

  it('returns null when chords are unique or empty', () => {
    expect(findDuplicateChord([p('a', 'A'), p('b', 'B', { chord: 's' })])).toBeNull()
  })
})
