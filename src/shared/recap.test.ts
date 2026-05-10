import { describe, expect, it } from 'bun:test'
import { parseRecapContent } from './recap'

describe('parseRecapContent', () => {
  it('parses clean JSON', () => {
    const result = parseRecapContent(
      '{"title":"Fix spawn timeout","recap":"Fixed the spawn dispatch timeout handling and added sentinel liveness checks."}',
    )
    expect(result.title).toBe('Fix spawn timeout')
    expect(result.recap).toBe('Fixed the spawn dispatch timeout handling and added sentinel liveness checks.')
  })

  it('parses JSON with markdown fencing', () => {
    const result = parseRecapContent(
      '```json\n{"title":"Debug auth flow","recap":"Traced authentication failure to stale cookie handling."}\n```',
    )
    expect(result.title).toBe('Debug auth flow')
    expect(result.recap).toBe('Traced authentication failure to stale cookie handling.')
  })

  it('parses JSON with extra text around it', () => {
    const result = parseRecapContent(
      'Here is the summary:\n{"title":"Add dark mode","recap":"Implemented dark mode toggle with persistent preference storage."}',
    )
    expect(result.title).toBe('Add dark mode')
    expect(result.recap).toBe('Implemented dark mode toggle with persistent preference storage.')
  })

  it('falls back to plain text for legacy recaps', () => {
    const result = parseRecapContent('Fixed the login bug and added error handling for expired tokens.')
    expect(result.title).toBeNull()
    expect(result.recap).toBe('Fixed the login bug and added error handling for expired tokens.')
  })

  it('falls back to plain text for malformed JSON', () => {
    const result = parseRecapContent('{title: broken json}')
    expect(result.title).toBeNull()
    expect(result.recap).toBe('{title: broken json}')
  })

  it('handles empty title gracefully', () => {
    const result = parseRecapContent('{"title":"","recap":"Did some work."}')
    expect(result.title).toBeNull()
    expect(result.recap).toBe('Did some work.')
  })

  it('falls back recap to raw text when recap field is empty', () => {
    const result = parseRecapContent('{"title":"Some title","recap":""}')
    expect(result.title).toBe('Some title')
    expect(result.recap).toBe('{"title":"Some title","recap":""}')
  })

  it('handles fencing with just ```', () => {
    const result = parseRecapContent(
      '```\n{"title":"Refactor store","recap":"Extracted shared utilities from monolithic store."}\n```',
    )
    expect(result.title).toBe('Refactor store')
    expect(result.recap).toBe('Extracted shared utilities from monolithic store.')
  })
})
