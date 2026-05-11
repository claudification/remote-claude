import { describe, expect, it } from 'bun:test'
import {
  BACKENDS_WITH_APPEND_SYSTEM_PROMPT,
  backendSupportsAppendSystemPrompt,
  isLaunchProfileId,
  LAUNCH_PROFILE_ID_PREFIX,
  LAUNCH_PROFILE_MAX_APPEND_SP,
  launchProfileListSchema,
  launchProfileSchema,
  newLaunchProfileId,
} from './launch-profile'

function baseProfile() {
  return {
    id: newLaunchProfileId(),
    name: 'Test',
    spawn: {},
    createdAt: 1000,
    updatedAt: 1000,
  }
}

describe('newLaunchProfileId', () => {
  it('produces an id with the lp_ prefix', () => {
    const id = newLaunchProfileId()
    expect(id.startsWith(LAUNCH_PROFILE_ID_PREFIX)).toBe(true)
    expect(isLaunchProfileId(id)).toBe(true)
  })

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newLaunchProfileId()))
    expect(ids.size).toBe(200)
  })
})

describe('isLaunchProfileId', () => {
  it('rejects non-strings', () => {
    expect(isLaunchProfileId(null)).toBe(false)
    expect(isLaunchProfileId(undefined)).toBe(false)
    expect(isLaunchProfileId(42)).toBe(false)
  })

  it('rejects strings without the prefix', () => {
    expect(isLaunchProfileId('abc')).toBe(false)
    expect(isLaunchProfileId('lp')).toBe(false)
  })

  it('rejects an empty body after the prefix', () => {
    expect(isLaunchProfileId(LAUNCH_PROFILE_ID_PREFIX)).toBe(false)
  })
})

describe('backendSupportsAppendSystemPrompt', () => {
  it('returns true for claude and chat-api', () => {
    expect(backendSupportsAppendSystemPrompt('claude')).toBe(true)
    expect(backendSupportsAppendSystemPrompt('chat-api')).toBe(true)
  })

  it('returns false for hermes and opencode', () => {
    expect(backendSupportsAppendSystemPrompt('hermes')).toBe(false)
    expect(backendSupportsAppendSystemPrompt('opencode')).toBe(false)
  })

  it('returns true when backend is undefined (defaults to claude downstream)', () => {
    expect(backendSupportsAppendSystemPrompt(undefined)).toBe(true)
  })

  it('matrix sanity: list does NOT include hermes or opencode', () => {
    const list: readonly string[] = BACKENDS_WITH_APPEND_SYSTEM_PROMPT
    expect(list).not.toContain('hermes')
    expect(list).not.toContain('opencode')
  })
})

describe('launchProfileSchema', () => {
  it('accepts a minimal profile', () => {
    expect(launchProfileSchema.safeParse(baseProfile()).success).toBe(true)
  })

  it('rejects an empty name', () => {
    const bad = { ...baseProfile(), name: '' }
    expect(launchProfileSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects an id without the lp_ prefix', () => {
    const bad = { ...baseProfile(), id: 'profile_abc' }
    expect(launchProfileSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects an unknown color', () => {
    const bad = { ...baseProfile(), color: 'rainbow' }
    expect(launchProfileSchema.safeParse(bad).success).toBe(false)
  })

  it('caps appendSystemPrompt at 16 KB', () => {
    const huge = 'x'.repeat(LAUNCH_PROFILE_MAX_APPEND_SP + 1)
    const bad = { ...baseProfile(), spawn: { appendSystemPrompt: huge } }
    expect(launchProfileSchema.safeParse(bad).success).toBe(false)
  })

  it('accepts spawn fields including appendSystemPrompt and backend', () => {
    const ok = {
      ...baseProfile(),
      spawn: {
        backend: 'claude' as const,
        model: 'claude-haiku-4-5',
        effort: 'low' as const,
        appendSystemPrompt: 'You are a careful reviewer.',
      },
    }
    expect(launchProfileSchema.safeParse(ok).success).toBe(true)
  })

  it('rejects an invalid chord type', () => {
    const bad = { ...baseProfile(), chord: 42 }
    expect(launchProfileSchema.safeParse(bad).success).toBe(false)
  })
})

describe('launchProfileListSchema', () => {
  it('accepts the empty list (user emptied the list)', () => {
    expect(launchProfileListSchema.safeParse([]).success).toBe(true)
  })

  it('rejects more than the cap', () => {
    const many = Array.from({ length: 51 }, () => baseProfile())
    expect(launchProfileListSchema.safeParse(many).success).toBe(false)
  })
})
