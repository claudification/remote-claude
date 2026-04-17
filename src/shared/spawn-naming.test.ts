import { describe, expect, it } from 'vitest'
import { deriveSessionName, sanitizeSessionName } from './spawn-naming'
import type { TaskMeta } from './spawn-prompt'

const task: TaskMeta = {
  slug: 't-1',
  title: 'Build the rocket',
  status: 'open',
  priority: 'high',
  tags: ['alpha'],
}

describe('sanitizeSessionName', () => {
  it('strips single and double quotes', () => {
    expect(sanitizeSessionName(`"hello" 'world'`)).toBe('hello world')
  })

  it('collapses whitespace and trims', () => {
    expect(sanitizeSessionName('  a\t\tb\n\nc  ')).toBe('a b c')
  })

  it('truncates to 60 characters', () => {
    const s = 'x'.repeat(120)
    expect(sanitizeSessionName(s)).toHaveLength(60)
  })
})

describe('deriveSessionName', () => {
  it('uses explicit name when provided', () => {
    expect(deriveSessionName({ name: 'my session' })).toBe('my session')
  })

  it('prefers explicit name over task.title', () => {
    expect(deriveSessionName({ name: 'override' }, task)).toBe('override')
  })

  it('falls back to task.title when name is absent', () => {
    expect(deriveSessionName({}, task)).toBe('Build the rocket')
  })

  it('falls back to first non-empty line of prompt', () => {
    const out = deriveSessionName({ prompt: '\n\nFirst real line\nsecond line' })
    expect(out).toBe('First real line')
  })

  it('returns null when no hints are present', () => {
    expect(deriveSessionName({})).toBeNull()
    expect(deriveSessionName({ prompt: '' })).toBeNull()
    expect(deriveSessionName({ prompt: '\n  \n\t\n' })).toBeNull()
  })

  it('strips quotes in derived name', () => {
    expect(deriveSessionName({ name: `"quoted"` })).toBe('quoted')
  })

  it('truncates long task titles to 60 chars', () => {
    const long = { ...task, title: 'x'.repeat(200) }
    const out = deriveSessionName({}, long)
    expect(out).toHaveLength(60)
  })

  it('ignores empty explicit name and advances to next hint', () => {
    expect(deriveSessionName({ name: '   ' }, task)).toBe('Build the rocket')
  })
})
