/**
 * LIVE OpenRouter prompt test. Skipped unless BOTH:
 *   RECAP_LIVE=1               (opt-in flag)
 *   OPENROUTER_API_KEY=sk-...  (real API key)
 *
 * Sends the synthetic small-fixture prompt to Haiku 4.5 and verifies the
 * response parses into valid frontmatter + body. This is the only test in
 * the suite that hits the real OpenRouter API; it exists so we can spot
 * prompt-format regressions that mock-only tests can't catch.
 *
 * Run manually:
 *   RECAP_LIVE=1 OPENROUTER_API_KEY=sk-... bun test src/broker/recap/__tests__/live-prompt.test.ts
 *
 * Cost per run: a few cents on Haiku.
 */

import { describe, expect, test } from 'bun:test'
import { buildPrompt } from '../period/llm/prompt-builder'
import { parseRecapOutput } from '../period/render/parse-recap'
import { chat } from '../shared/openrouter-client'
import { makePromptInputs } from './synthetic-fixtures'

const LIVE = process.env.RECAP_LIVE === '1' && !!process.env.OPENROUTER_API_KEY
const describeLive = LIVE ? describe : describe.skip

describeLive('LIVE OpenRouter recap prompt round-trip', () => {
  test('Haiku 4.5 returns parseable YAML frontmatter + body for small fixture', async () => {
    const inputs = makePromptInputs('small')
    const prompt = buildPrompt(inputs)

    const response = await chat({
      model: 'anthropic/claude-haiku-4.5',
      system: prompt.system,
      user: prompt.user,
      maxTokens: 4000,
      temperature: 0.2,
      timeoutMs: 60_000,
    })

    expect(response.content.length).toBeGreaterThan(200)

    const parsed = parseRecapOutput(response.content)
    expect(parsed.body.length).toBeGreaterThan(50)
    expect(typeof parsed.metadata.subtitle).toBe('string')
    expect((parsed.metadata.subtitle ?? '').length).toBeGreaterThan(2)

    // The model should have produced *something* in the YAML arrays. We don't
    // assert specific contents -- the prompt allows omitting fields, but the
    // small fixture has enough signal that at least keywords or hashtags
    // typically come back.
    const hasAnyMetadata =
      (parsed.metadata.keywords?.length ?? 0) > 0 ||
      (parsed.metadata.hashtags?.length ?? 0) > 0 ||
      (parsed.metadata.goals?.length ?? 0) > 0
    expect(hasAnyMetadata).toBe(true)

    console.log('[live] cost USD:', response.usage)
  }, 90_000)
})
