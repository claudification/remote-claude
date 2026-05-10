import { describe, expect, test } from 'bun:test'
import type { TranscriptEntry } from './protocol'
import { filterDisplayEntries, isDisplayEntry } from './transcript-filter'

function entry(type: string, extra?: Record<string, unknown>): TranscriptEntry {
  return { type, timestamp: new Date().toISOString(), ...extra } as TranscriptEntry
}

describe('isDisplayEntry', () => {
  test('keeps user entries with text content', () => {
    expect(isDisplayEntry(entry('user', { message: { role: 'user', content: 'hello' } }))).toBe(true)
  })

  test('keeps assistant entries', () => {
    expect(isDisplayEntry(entry('assistant', { message: { role: 'assistant', content: 'hi' } }))).toBe(true)
  })

  test('drops progress entries', () => {
    expect(isDisplayEntry(entry('progress', { data: { foo: 1 } }))).toBe(false)
  })

  test('drops system entries without subtype', () => {
    expect(isDisplayEntry(entry('system'))).toBe(false)
  })

  test('keeps system entries with subtype', () => {
    expect(isDisplayEntry(entry('system', { subtype: 'stop_hook_summary' }))).toBe(true)
  })

  test('drops system entries with noise subtypes', () => {
    expect(isDisplayEntry(entry('system', { subtype: 'file_snapshot' }))).toBe(false)
    expect(isDisplayEntry(entry('system', { subtype: 'post_turn_summary' }))).toBe(false)
    expect(isDisplayEntry(entry('system', { subtype: 'task_progress' }))).toBe(false)
    expect(isDisplayEntry(entry('system', { subtype: 'task_notification' }))).toBe(false)
  })

  test('drops user entries that are pure tool_result arrays', () => {
    const e = entry('user', {
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '' }] },
    })
    expect(isDisplayEntry(e)).toBe(false)
  })

  test('keeps user entries with mixed content (text + tool_result)', () => {
    const e = entry('user', {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_result', tool_use_id: 'x' },
        ],
      },
    })
    expect(isDisplayEntry(e)).toBe(true)
  })

  test('keeps boot entries', () => {
    expect(isDisplayEntry(entry('boot', { step: 'init' }))).toBe(true)
  })

  test('keeps launch entries', () => {
    expect(isDisplayEntry(entry('launch', { launchId: 'x', phase: 'initial', step: 'spawning' }))).toBe(true)
  })

  test('keeps compacting/compacted entries', () => {
    expect(isDisplayEntry(entry('compacting'))).toBe(true)
    expect(isDisplayEntry(entry('compacted'))).toBe(true)
  })

  test('keeps queue-operation entries', () => {
    expect(isDisplayEntry(entry('queue-operation', { operation: 'enqueue', content: 'do stuff' }))).toBe(true)
  })

  test('keeps pr-link entries', () => {
    expect(isDisplayEntry(entry('pr-link', { prNumber: 42 }))).toBe(true)
  })

  test('keeps last-prompt entries', () => {
    expect(isDisplayEntry(entry('last-prompt', { lastPrompt: 'x' }))).toBe(true)
  })
})

describe('filterDisplayEntries', () => {
  const mixed: TranscriptEntry[] = [
    entry('progress'),
    entry('user', { message: { role: 'user', content: 'q1' } }),
    entry('progress'),
    entry('progress'),
    entry('assistant', { message: { role: 'assistant', content: 'a1' } }),
    entry('system', { subtype: 'file_snapshot' }),
    entry('system'),
    entry('user', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] } }),
    entry('user', { message: { role: 'user', content: 'q2' } }),
    entry('progress'),
    entry('assistant', { message: { role: 'assistant', content: 'a2' } }),
  ]

  test('without limit returns all display entries', () => {
    const result = filterDisplayEntries(mixed)
    expect(result).toHaveLength(4)
    expect(result.map(e => e.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  test('with limit returns last N display entries', () => {
    const result = filterDisplayEntries(mixed, 2)
    expect(result).toHaveLength(2)
    const r0 = result[0] as { message?: { content?: string } }
    const r1 = result[1] as { message?: { content?: string } }
    expect(r0.message?.content).toBe('q2')
    expect(r1.message?.content).toBe('a2')
  })

  test('with limit larger than display count returns all', () => {
    const result = filterDisplayEntries(mixed, 100)
    expect(result).toHaveLength(4)
  })

  test('preserves chronological order', () => {
    const entries: TranscriptEntry[] = [
      entry('user', { message: { role: 'user', content: 'first' } }),
      entry('progress'),
      entry('user', { message: { role: 'user', content: 'second' } }),
      entry('progress'),
      entry('user', { message: { role: 'user', content: 'third' } }),
    ]
    const result = filterDisplayEntries(entries, 2)
    const r0 = result[0] as { message?: { content?: string } }
    const r1 = result[1] as { message?: { content?: string } }
    expect(r0.message?.content).toBe('second')
    expect(r1.message?.content).toBe('third')
  })
})
