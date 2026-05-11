import type { LaunchProfile } from '@shared/launch-profile'
import { describe, expect, it } from 'vitest'
import { buildSpawnRequest } from './run-profile'

function p(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id: 'lp_x',
    name: 'X',
    spawn: { backend: 'claude' },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('buildSpawnRequest', () => {
  it('merges profile.spawn onto cwd+sentinel', () => {
    const req = buildSpawnRequest(
      p({ spawn: { backend: 'claude', model: 'claude-haiku-4-5', effort: 'low' } }),
      '/tmp/cwd',
      'tower',
    )
    expect(req.cwd).toBe('/tmp/cwd')
    expect(req.sentinel).toBe('tower')
    expect(req.model).toBe('claude-haiku-4-5')
    expect(req.effort).toBe('low')
    expect(req.backend).toBe('claude')
  })

  it('respects appendSystemPrompt from the profile', () => {
    const req = buildSpawnRequest(p({ spawn: { backend: 'claude', appendSystemPrompt: 'be terse' } }), '/x', undefined)
    expect(req.appendSystemPrompt).toBe('be terse')
  })

  it('passes through chord and immediate-irrelevant fields (they are not in SpawnRequest)', () => {
    const req = buildSpawnRequest(p({ chord: 'a', immediate: false }), '/x', undefined)
    expect((req as unknown as { chord?: string }).chord).toBeUndefined()
    expect((req as unknown as { immediate?: boolean }).immediate).toBeUndefined()
  })
})
