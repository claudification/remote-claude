import { describe, expect, test } from 'bun:test'
import {
  buildProjectUri,
  cwdToProjectUri,
  extractProjectLabel,
  isSameProject,
  matchProjectUri,
  normalizeProjectUri,
  parseProjectUri,
} from './project-uri'

describe('parseProjectUri', () => {
  test('parses full URI with authority', () => {
    const result = parseProjectUri('claude://studio/Users/jonas/projects/foo')
    expect(result.scheme).toBe('claude')
    expect(result.authority).toBe('studio')
    expect(result.path).toBe('/Users/jonas/projects/foo')
    expect(result.fragment).toBeUndefined()
    expect(result.raw).toBe('claude://studio/Users/jonas/projects/foo')
  })

  test('parses authority-less URI (triple slash)', () => {
    const result = parseProjectUri('claude:///Users/jonas/projects/foo')
    expect(result.scheme).toBe('claude')
    expect(result.authority).toBeUndefined()
    expect(result.path).toBe('/Users/jonas/projects/foo')
  })

  test('parses URI with fragment', () => {
    const result = parseProjectUri('claude:///path#conversation-id')
    expect(result.scheme).toBe('claude')
    expect(result.path).toBe('/path')
    expect(result.fragment).toBe('conversation-id')
  })

  test('parses wildcard', () => {
    const result = parseProjectUri('*')
    expect(result.scheme).toBe('*')
    expect(result.path).toBe('*')
    expect(result.raw).toBe('*')
  })

  test('parses scheme-wildcard', () => {
    const result = parseProjectUri('claude:*')
    expect(result.scheme).toBe('claude')
    expect(result.path).toBe('*')
    expect(result.raw).toBe('claude:*')
  })

  test('lowercases scheme', () => {
    const result = parseProjectUri('Claude:///Users/foo')
    expect(result.scheme).toBe('claude')
  })

  test('lowercases scheme-wildcard', () => {
    const result = parseProjectUri('CODEX:*')
    expect(result.scheme).toBe('codex')
  })

  test('parses codex scheme with authority', () => {
    const result = parseProjectUri('codex://beast/Users/jonas/projects/bar')
    expect(result.scheme).toBe('codex')
    expect(result.authority).toBe('beast')
    expect(result.path).toBe('/Users/jonas/projects/bar')
  })

  test('parses non-filesystem agent URI', () => {
    const result = parseProjectUri('open-claw://gateway.example.com/my-thing')
    expect(result.scheme).toBe('open-claw')
    expect(result.authority).toBe('gateway.example.com')
    expect(result.path).toBe('/my-thing')
  })

  test('throws on missing scheme', () => {
    expect(() => parseProjectUri('/Users/jonas/projects/foo')).toThrow('Invalid project URI')
  })

  test('throws on empty string', () => {
    expect(() => parseProjectUri('')).toThrow('Invalid project URI')
  })

  test('throws on garbage input', () => {
    expect(() => parseProjectUri('not a uri at all')).toThrow('Invalid project URI')
  })

  test('handles root path', () => {
    const result = parseProjectUri('claude:///')
    expect(result.scheme).toBe('claude')
    expect(result.path).toBe('/')
    expect(result.authority).toBeUndefined()
  })

  test('handles empty fragment (hash with nothing)', () => {
    const result = parseProjectUri('claude:///path#')
    expect(result.fragment).toBeUndefined()
  })

  test('preserves raw string', () => {
    const raw = 'claude://STUDIO/Users/jonas/projects/foo'
    const result = parseProjectUri(raw)
    expect(result.raw).toBe(raw)
  })
})

describe('buildProjectUri', () => {
  test('builds URI with authority', () => {
    const result = buildProjectUri({ scheme: 'claude', authority: 'studio', path: '/Users/jonas/projects/foo' })
    expect(result).toBe('claude://studio/Users/jonas/projects/foo')
  })

  test('builds authority-less URI', () => {
    const result = buildProjectUri({ scheme: 'claude', path: '/Users/jonas/projects/foo' })
    expect(result).toBe('claude:///Users/jonas/projects/foo')
  })

  test('builds URI with fragment', () => {
    const result = buildProjectUri({ scheme: 'claude', path: '/path', fragment: 'conv-123' })
    expect(result).toBe('claude:///path#conv-123')
  })

  test('lowercases scheme', () => {
    const result = buildProjectUri({ scheme: 'CLAUDE', path: '/foo' })
    expect(result).toBe('claude:///foo')
  })

  test('round-trip: parse -> build -> parse is identity', () => {
    const uris = [
      'claude://studio/Users/jonas/projects/foo',
      'claude:///Users/jonas/projects/foo',
      'codex://beast/projects/bar',
      'open-claw://gateway.example.com/my-thing',
      'claude:///path#conversation-id',
    ]

    for (const uri of uris) {
      const parsed = parseProjectUri(uri)
      const built = buildProjectUri(parsed)
      const reparsed = parseProjectUri(built)
      expect(reparsed.scheme).toBe(parsed.scheme)
      expect(reparsed.authority).toBe(parsed.authority)
      expect(reparsed.path).toBe(parsed.path)
      expect(reparsed.fragment).toBe(parsed.fragment)
    }
  })
})

describe('cwdToProjectUri', () => {
  test('converts bare CWD with defaults', () => {
    const result = cwdToProjectUri('/Users/jonas/projects/foo')
    expect(result).toBe('claude:///Users/jonas/projects/foo')
  })

  test('converts CWD with explicit scheme and authority', () => {
    const result = cwdToProjectUri('/Users/jonas/projects/foo', 'claude', 'studio')
    expect(result).toBe('claude://studio/Users/jonas/projects/foo')
  })

  test('converts CWD with scheme only', () => {
    const result = cwdToProjectUri('/Users/jonas/projects/foo', 'codex')
    expect(result).toBe('codex:///Users/jonas/projects/foo')
  })

  test('handles root CWD', () => {
    const result = cwdToProjectUri('/')
    expect(result).toBe('claude:///')
  })
})

describe('matchProjectUri', () => {
  const target = 'claude:///Users/jonas/projects/remote-claude'

  test('universal wildcard matches everything', () => {
    expect(matchProjectUri('*', target)).toBe(true)
    expect(matchProjectUri('*', 'codex://beast/foo')).toBe(true)
    expect(matchProjectUri('*', 'open-claw://gw/thing')).toBe(true)
  })

  test('scheme wildcard matches all URIs with that scheme', () => {
    expect(matchProjectUri('claude:*', target)).toBe(true)
    expect(matchProjectUri('claude:*', 'claude://studio/other')).toBe(true)
    expect(matchProjectUri('claude:*', 'codex://beast/foo')).toBe(false)
  })

  test('scheme wildcard is case-insensitive on scheme', () => {
    expect(matchProjectUri('CLAUDE:*', target)).toBe(true)
  })

  test('trailing /* does prefix match on path', () => {
    expect(matchProjectUri('claude:///Users/jonas/projects/*', target)).toBe(true)
    expect(matchProjectUri('claude:///Users/jonas/projects/*', 'claude:///Users/jonas/projects/foo')).toBe(true)
    expect(matchProjectUri('claude:///Users/jonas/*', target)).toBe(true)
    expect(matchProjectUri('claude:///Users/other/*', target)).toBe(false)
  })

  test('trailing /* matches exact prefix path too', () => {
    expect(matchProjectUri('claude:///Users/jonas/projects/remote-claude/*', target)).toBe(true)
  })

  test('trailing /* requires scheme match', () => {
    expect(matchProjectUri('codex:///Users/jonas/projects/*', target)).toBe(false)
  })

  test('trailing /* requires authority match', () => {
    expect(matchProjectUri('claude://studio/Users/jonas/projects/*', target)).toBe(false)
    expect(matchProjectUri('claude://studio/Users/jonas/projects/*', 'claude://studio/Users/jonas/projects/foo')).toBe(
      true,
    )
  })

  test('exact match', () => {
    expect(matchProjectUri(target, target)).toBe(true)
    expect(matchProjectUri(target, 'claude:///Users/jonas/projects/other')).toBe(false)
  })

  test('exact match normalizes before comparison', () => {
    expect(matchProjectUri('CLAUDE:///Users/jonas/projects/remote-claude', target)).toBe(true)
    expect(matchProjectUri('claude:///Users/jonas/projects/remote-claude/', target)).toBe(true)
  })

  test('does not partial-match without trailing /*', () => {
    expect(matchProjectUri('claude:///Users/jonas/projects', target)).toBe(false)
  })
})

describe('normalizeProjectUri', () => {
  test('lowercases scheme', () => {
    expect(normalizeProjectUri('CLAUDE:///foo')).toBe('claude:///foo')
  })

  test('removes trailing slash from path', () => {
    expect(normalizeProjectUri('claude:///Users/jonas/projects/foo/')).toBe('claude:///Users/jonas/projects/foo')
  })

  test('keeps root path as /', () => {
    expect(normalizeProjectUri('claude:///')).toBe('claude:///')
  })

  test('strips empty fragment', () => {
    expect(normalizeProjectUri('claude:///path#')).toBe('claude:///path')
  })

  test('keeps non-empty fragment', () => {
    expect(normalizeProjectUri('claude:///path#conv-123')).toBe('claude:///path#conv-123')
  })

  test('wildcard passes through', () => {
    expect(normalizeProjectUri('*')).toBe('*')
  })

  test('scheme-wildcard normalizes scheme case', () => {
    expect(normalizeProjectUri('CLAUDE:*')).toBe('claude:*')
  })

  test('is idempotent', () => {
    const uris = [
      'claude:///Users/jonas/projects/foo',
      'claude://studio/Users/jonas/projects/foo',
      '*',
      'claude:*',
      'claude:///path#conv-123',
    ]
    for (const uri of uris) {
      const once = normalizeProjectUri(uri)
      const twice = normalizeProjectUri(once)
      expect(twice).toBe(once)
    }
  })

  test('preserves authority', () => {
    expect(normalizeProjectUri('claude://studio/foo')).toBe('claude://studio/foo')
  })
})

describe('extractProjectLabel', () => {
  test('returns last path segment', () => {
    expect(extractProjectLabel('claude:///Users/jonas/projects/foo')).toBe('foo')
  })

  test('works with authority', () => {
    expect(extractProjectLabel('claude://studio/Users/jonas/projects/remote-claude')).toBe('remote-claude')
  })

  test('works with non-filesystem paths', () => {
    expect(extractProjectLabel('open-claw://gateway/my-thing')).toBe('my-thing')
  })

  test('returns path for root', () => {
    expect(extractProjectLabel('claude:///')).toBe('/')
  })

  test('returns pattern for universal wildcard', () => {
    expect(extractProjectLabel('*')).toBe('*')
  })

  test('returns pattern for scheme-wildcard', () => {
    expect(extractProjectLabel('claude:*')).toBe('claude:*')
  })

  test('handles deep paths', () => {
    expect(extractProjectLabel('claude:///a/b/c/d/e')).toBe('e')
  })
})

describe('isSameProject', () => {
  test('same URI is same project', () => {
    expect(isSameProject('claude:///Users/jonas/projects/foo', 'claude:///Users/jonas/projects/foo')).toBe(true)
  })

  test('different scheme case is same project', () => {
    expect(isSameProject('CLAUDE:///Users/foo', 'claude:///Users/foo')).toBe(true)
  })

  test('trailing slash difference is same project', () => {
    expect(isSameProject('claude:///Users/foo/', 'claude:///Users/foo')).toBe(true)
  })

  test('different paths are different projects', () => {
    expect(isSameProject('claude:///Users/foo', 'claude:///Users/bar')).toBe(false)
  })

  test('different schemes are different projects', () => {
    expect(isSameProject('claude:///foo', 'codex:///foo')).toBe(false)
  })

  test('different authorities are different projects', () => {
    expect(isSameProject('claude://studio/foo', 'claude://beast/foo')).toBe(false)
  })

  test('authority vs no authority are different projects', () => {
    expect(isSameProject('claude:///foo', 'claude://studio/foo')).toBe(false)
  })
})
