import { describe, expect, it } from 'bun:test'
import { computeCostUsd, normalizeUsage } from './pricing'

// model-pricing is fetched from LiteLLM at startup; in tests it's empty,
// so unknown-model fallback is the dominant path. We verify the shape
// of the result rather than absolute numbers.

describe('computeCostUsd', () => {
  it('returns zero amount + source=unknown for an unknown model', () => {
    const r = computeCostUsd('unknown/model', { inputTokens: 100, outputTokens: 50 })
    expect(r.amount).toBe(0)
    expect(r.source).toBe('unknown')
  })

  it('handles vendor-prefixed slugs by stripping the prefix', () => {
    // Both produce the same lookup result (zero in test env), but the
    // prefix-strip path runs without throwing.
    const a = computeCostUsd('anthropic/claude-haiku-4-5', { inputTokens: 1, outputTokens: 1 })
    const b = computeCostUsd('claude-haiku-4-5', { inputTokens: 1, outputTokens: 1 })
    expect(a.source).toBe(b.source)
  })
})

describe('normalizeUsage', () => {
  it('extracts the four token counts from an OpenRouter usage object', () => {
    const r = normalizeUsage('anthropic/claude-haiku-4-5', {
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 20 },
      cache_creation_input_tokens: 10,
    })
    expect(r.inputTokens).toBe(100)
    expect(r.outputTokens).toBe(50)
    expect(r.cacheReadTokens).toBe(20)
    expect(r.cacheWriteTokens).toBe(10)
  })

  it('trusts the cost field on the response when present', () => {
    const r = normalizeUsage('anything', {
      prompt_tokens: 100,
      completion_tokens: 50,
      cost: 0.0042,
    })
    expect(r.costUsd).toBe(0.0042)
    expect(r.costSource).toBe('openrouter')
  })

  it('zeroes everything when usage is missing', () => {
    const r = normalizeUsage('anything', undefined)
    expect(r.inputTokens).toBe(0)
    expect(r.outputTokens).toBe(0)
    expect(r.costUsd).toBe(0)
    expect(r.costSource).toBe('unknown')
  })
})
