import { describe, expect, test } from 'bun:test'
import { makePromptInputs } from '../../__tests__/synthetic-fixtures'
import { pickModel } from './escalate'
import { buildPrompt } from './prompt-builder'

describe('pickModel', () => {
  test('small inputs pick haiku', () => {
    const m = pickModel(1000)
    expect(m.model).toContain('haiku')
    expect(m.reason).toBe('small')
  })

  test('just under escalation threshold picks haiku', () => {
    const m = pickModel(49_999)
    expect(m.reason).toBe('small')
  })

  test('just over escalation threshold picks sonnet (escalated)', () => {
    const m = pickModel(50_001)
    expect(m.model).toContain('sonnet')
    expect(m.reason).toBe('escalated')
  })

  test('just under chunk ceiling picks sonnet (escalated, not too-big)', () => {
    const m = pickModel(599_999)
    expect(m.reason).toBe('escalated')
  })

  test('just over chunk ceiling picks sonnet (too-big)', () => {
    const m = pickModel(600_001)
    expect(m.reason).toBe('too-big')
  })
})

describe('pickModel integrated with fixture sizes', () => {
  test('small fixture -> haiku', () => {
    const out = buildPrompt(makePromptInputs('small'))
    expect(pickModel(out.inputChars).reason).toBe('small')
  })

  test('medium fixture -> haiku or sonnet (depends on fixture sizing -- pin the band)', () => {
    const out = buildPrompt(makePromptInputs('medium'))
    const m = pickModel(out.inputChars)
    expect(['small', 'escalated']).toContain(m.reason)
  })

  test('large fixture -> sonnet escalation', () => {
    const out = buildPrompt(makePromptInputs('large'))
    expect(pickModel(out.inputChars).reason).toBe('escalated')
  })

  test('huge fixture -> chunk-reduce path', () => {
    const out = buildPrompt(makePromptInputs('huge'))
    expect(pickModel(out.inputChars).reason).toBe('too-big')
  })
})
