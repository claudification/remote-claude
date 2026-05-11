import { describe, expect, it } from 'bun:test'
import { launchProfileListSchema } from './launch-profile'
import { buildSeedProfiles } from './launch-profile-seeds'

describe('buildSeedProfiles', () => {
  it('returns three seed profiles', () => {
    expect(buildSeedProfiles().length).toBe(3)
  })

  it('produces a list that passes the schema', () => {
    const seeds = buildSeedProfiles(123)
    const parsed = launchProfileListSchema.safeParse(seeds)
    if (!parsed.success) {
      throw new Error(`seed list failed schema: ${parsed.error.message}`)
    }
  })

  it('assigns unique ids and chords', () => {
    const seeds = buildSeedProfiles()
    const ids = new Set(seeds.map(p => p.id))
    const chords = new Set(seeds.map(p => p.chord))
    expect(ids.size).toBe(3)
    expect(chords.size).toBe(3)
  })

  it('stamps createdAt = updatedAt = now', () => {
    const seeds = buildSeedProfiles(42)
    for (const seed of seeds) {
      expect(seed.createdAt).toBe(42)
      expect(seed.updatedAt).toBe(42)
    }
  })

  it('defaults immediate to true for chord launches', () => {
    for (const seed of buildSeedProfiles()) {
      expect(seed.immediate).toBe(true)
    }
  })

  it('uses the claude backend for all seeds', () => {
    for (const seed of buildSeedProfiles()) {
      expect(seed.spawn.backend).toBe('claude')
    }
  })
})
