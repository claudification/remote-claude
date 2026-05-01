import { describe, expect, it } from 'vitest'
import { deriveConversationName, sanitizeConversationName, validateSessionName } from './spawn-naming'
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
    expect(sanitizeConversationName(`"hello" 'world'`)).toBe('hello world')
  })

  it('collapses whitespace and trims', () => {
    expect(sanitizeConversationName('  a\t\tb\n\nc  ')).toBe('a b c')
  })

  it('truncates to 60 characters', () => {
    const s = 'x'.repeat(120)
    expect(sanitizeConversationName(s)).toHaveLength(60)
  })
})

describe('deriveSessionName', () => {
  it('uses explicit name when provided', () => {
    expect(deriveConversationName({ name: 'my session' })).toBe('my session')
  })

  it('prefers explicit name over task.title', () => {
    expect(deriveConversationName({ name: 'override' }, task)).toBe('override')
  })

  it('falls back to task.title when name is absent', () => {
    expect(deriveConversationName({}, task)).toBe('Build the rocket')
  })

  it('falls back to first non-empty line of prompt', () => {
    const out = deriveConversationName({ prompt: '\n\nFirst real line\nsecond line' })
    expect(out).toBe('First real line')
  })

  it('returns null when no hints are present', () => {
    expect(deriveConversationName({})).toBeNull()
    expect(deriveConversationName({ prompt: '' })).toBeNull()
    expect(deriveConversationName({ prompt: '\n  \n\t\n' })).toBeNull()
  })

  it('strips quotes in derived name', () => {
    expect(deriveConversationName({ name: `"quoted"` })).toBe('quoted')
  })

  it('truncates long task titles to 60 chars', () => {
    const long = { ...task, title: 'x'.repeat(200) }
    const out = deriveConversationName({}, long)
    expect(out).toHaveLength(60)
  })

  it('ignores empty explicit name and advances to next hint', () => {
    expect(deriveConversationName({ name: '   ' }, task)).toBe('Build the rocket')
  })
})

describe('validateSessionName', () => {
  it('returns null for a valid unique name', () => {
    expect(validateSessionName('fresh-name', new Set(['other']))).toBeNull()
  })

  it('rejects names that collide with existing sessions', () => {
    expect(validateSessionName('taken', new Set(['taken']))).toContain('already in use')
  })

  it('rejects empty-after-sanitization names', () => {
    expect(validateSessionName('   ', new Set())).toContain('empty')
  })

  it('detects collision after sanitization (quotes stripped)', () => {
    expect(validateSessionName('"my session"', new Set(['my session']))).toContain('already in use')
  })
})
