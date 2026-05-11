import { describe, expect, test } from 'bun:test'
import { makePromptInputs, SIZES } from '../../__tests__/synthetic-fixtures'
import { buildPrompt } from './prompt-builder'

describe('buildPrompt', () => {
  test('emits non-empty system + user payloads', () => {
    const inputs = makePromptInputs('small')
    const out = buildPrompt(inputs)
    expect(out.system.length).toBeGreaterThan(200)
    expect(out.user.length).toBeGreaterThan(50)
    expect(out.inputChars).toBe(out.system.length + out.user.length)
  })

  test('mentions the project label and period range in the system prompt', () => {
    const inputs = makePromptInputs('small')
    const out = buildPrompt(inputs)
    expect(out.system).toContain(inputs.projectLabel)
    expect(out.system).toContain(inputs.periodHuman)
    expect(out.system).toContain(inputs.periodIsoRange)
  })

  test('user payload references a conversation id from the input', () => {
    const inputs = makePromptInputs('small')
    const out = buildPrompt(inputs)
    expect(out.user).toContain('conv_000')
  })

  test('size grows monotonically with fixture size', () => {
    const small = buildPrompt(makePromptInputs('small'))
    const medium = buildPrompt(makePromptInputs('medium'))
    const large = buildPrompt(makePromptInputs('large'))
    expect(medium.inputChars).toBeGreaterThan(small.inputChars)
    expect(large.inputChars).toBeGreaterThan(medium.inputChars)
  })

  test('large fixture lands in the Sonnet escalation band', () => {
    // The escalate threshold is 50_000 chars; the large fixture is sized to
    // sit comfortably above it so escalate.test.ts also exercises the band.
    const out = buildPrompt(makePromptInputs('large'))
    expect(out.inputChars).toBeGreaterThan(50_000)
  })

  test('huge fixture exceeds the chunk-reduce ceiling', () => {
    const out = buildPrompt(makePromptInputs('huge'))
    expect(out.inputChars).toBeGreaterThan(600_000)
  })

  test('OUTPUT FORMAT: includes both YAML frontmatter spec and TL;DR section', () => {
    const out = buildPrompt(makePromptInputs('small'))
    expect(out.system).toContain('YAML frontmatter')
    expect(out.system).toContain('TL;DR')
  })

  test('cost summary always appears in the user payload (deterministic from SQL)', () => {
    const out = buildPrompt(makePromptInputs('medium'))
    expect(out.user.toLowerCase()).toContain('cost')
  })

  test('open questions section surfaces when fixture has open questions', () => {
    const inputs = makePromptInputs('small')
    expect(inputs.openQuestions.conversationsWithOpenQuestions.length).toBeGreaterThan(0)
    const out = buildPrompt(inputs)
    // Section header in the user payload uses underscore form: OPEN_QUESTIONS
    expect(out.user).toContain('OPEN_QUESTIONS')
  })

  test('cost summary line exists with totals (per-day breakdown is intentionally NOT in prompt -- LLM must not regenerate numbers)', () => {
    const inputs = makePromptInputs('small')
    const out = buildPrompt(inputs)
    expect(out.user).toContain('COST SUMMARY')
    expect(out.user).toMatch(/total=\$\d/)
  })
})

describe('buildPrompt -- snapshot guards (size only, content not pinned)', () => {
  // Pin order-of-magnitude sizes so a refactor that 10x-inflates the prompt
  // is caught immediately. Tighter snapshot pinning would brittle-fail on
  // every prompt copy edit.
  for (const size of Object.keys(SIZES) as Array<keyof typeof SIZES>) {
    test(`size=${size}`, () => {
      const out = buildPrompt(makePromptInputs(size))
      expect(out.inputChars).toBeGreaterThan(0)
      expect(out.system.length).toBeLessThan(10_000)
    })
  }
})
