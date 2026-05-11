import { describe, expect, it } from 'bun:test'
import type { TranscriptEntry } from '../../../shared/protocol'
import {
  extractAssistantText,
  extractUserPromptsAndFinals,
  extractUserText,
  prefixed,
  truncate,
} from './transcript-extract'

function user(text: string, ts = '2026-05-11T10:00:00Z'): TranscriptEntry {
  return {
    type: 'user',
    uuid: crypto.randomUUID(),
    timestamp: ts,
    message: { role: 'user', content: text },
  } as TranscriptEntry
}

function userBlocks(blocks: Array<{ type: string; text?: string }>, ts = '2026-05-11T10:00:00Z'): TranscriptEntry {
  return {
    type: 'user',
    uuid: crypto.randomUUID(),
    timestamp: ts,
    message: { role: 'user', content: blocks },
  } as TranscriptEntry
}

function assistant(text: string, ts = '2026-05-11T10:00:01Z'): TranscriptEntry {
  return {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as TranscriptEntry
}

describe('extractUserText', () => {
  it('reads a string content', () => {
    expect(extractUserText(user('hello') as never)).toBe('hello')
  })
  it('joins text blocks', () => {
    const e = userBlocks([
      { type: 'text', text: 'a' },
      { type: 'tool_result', text: 'ignore me' },
      { type: 'text', text: 'b' },
    ])
    expect(extractUserText(e as never)).toBe('a b')
  })
  it('returns null when no text blocks', () => {
    const e = userBlocks([{ type: 'tool_result' }])
    expect(extractUserText(e as never)).toBeNull()
  })
})

describe('extractAssistantText', () => {
  it('reads text blocks', () => {
    expect(extractAssistantText(assistant('done') as never)).toBe('done')
  })
  it('returns null on empty content', () => {
    const e = { ...assistant('x'), message: { role: 'assistant', content: [] } }
    expect(extractAssistantText(e as never)).toBeNull()
  })
})

describe('prefixed', () => {
  it('prefixes non-empty text', () => {
    expect(prefixed('USER', 'hi')).toBe('USER: hi')
  })
  it('returns null for null input', () => {
    expect(prefixed('USER', null)).toBeNull()
  })
})

describe('truncate', () => {
  it('returns input under the limit', () => {
    expect(truncate('hi', 10)).toBe('hi')
  })
  it('appends ellipsis when over the limit', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcde...')
  })
})

describe('extractUserPromptsAndFinals', () => {
  it('pairs user prompts with their final assistant text', () => {
    const turns = extractUserPromptsAndFinals([
      user('what is X', '2026-05-11T10:00:00Z'),
      assistant('researching'),
      assistant('X is a thing'),
      user('and Y', '2026-05-11T11:00:00Z'),
      assistant('Y too'),
    ])
    expect(turns.length).toBe(2)
    expect(turns[0].userPrompt).toBe('what is X')
    expect(turns[0].assistantFinal).toBe('researching X is a thing')
    expect(turns[0].timestamp).toBeGreaterThan(0)
    expect(turns[1].userPrompt).toBe('and Y')
    expect(turns[1].assistantFinal).toBe('Y too')
  })

  it('marks truncated prompts with the [truncated N chars] suffix', () => {
    const long = 'q'.repeat(2500)
    const turns = extractUserPromptsAndFinals([user(long), assistant('ack')])
    expect(turns.length).toBe(1)
    expect(turns[0].userPrompt).toContain('...[truncated 500 chars]')
  })

  it('marks truncated assistant finals too', () => {
    const long = 'a'.repeat(5000)
    const turns = extractUserPromptsAndFinals([user('go'), assistant(long)])
    expect(turns.length).toBe(1)
    expect(turns[0].assistantFinal).toContain('...[truncated 1000 chars]')
  })

  it('drops a turn that has neither prompt text nor assistant text', () => {
    const turns = extractUserPromptsAndFinals([userBlocks([{ type: 'tool_result' }])])
    expect(turns.length).toBe(0)
  })

  it('handles a trailing user prompt with no assistant reply', () => {
    const turns = extractUserPromptsAndFinals([user('lonely')])
    expect(turns.length).toBe(1)
    expect(turns[0].userPrompt).toBe('lonely')
    expect(turns[0].assistantFinal).toBe('')
  })
})
