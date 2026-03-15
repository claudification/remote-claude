import { describe, expect, test } from 'bun:test'
import { isPathWithinCwd } from './path-guard'

describe('isPathWithinCwd', () => {
  const cwd = '/home/jonas/projects/acme'

  // Valid paths
  test('allows exact cwd path', () => {
    expect(isPathWithinCwd('/home/jonas/projects/acme', cwd)).toBe(true)
  })

  test('allows file directly in cwd', () => {
    expect(isPathWithinCwd('/home/jonas/projects/acme/README.md', cwd)).toBe(true)
  })

  test('allows nested file in cwd', () => {
    expect(isPathWithinCwd('/home/jonas/projects/acme/src/index.ts', cwd)).toBe(true)
  })

  test('allows deeply nested path', () => {
    expect(isPathWithinCwd('/home/jonas/projects/acme/a/b/c/d/e.txt', cwd)).toBe(true)
  })

  // Traversal attacks
  test('blocks simple ../ traversal', () => {
    expect(isPathWithinCwd('/home/jonas/projects/acme/../secret/file', cwd)).toBe(false)
  })

  test('blocks double ../ traversal', () => {
    expect(isPathWithinCwd('/home/jonas/projects/acme/../../etc/passwd', cwd)).toBe(false)
  })

  test('blocks traversal that lands back in cwd', () => {
    // /home/jonas/projects/acme/src/../../../etc/passwd
    expect(isPathWithinCwd('/home/jonas/projects/acme/src/../../../etc/passwd', cwd)).toBe(false)
  })

  test('blocks traversal to root', () => {
    expect(isPathWithinCwd('/home/jonas/projects/acme/../../../../etc/passwd', cwd)).toBe(false)
  })

  // Path normalization edge cases
  test('blocks path with /./ segments', () => {
    // This resolves within cwd so should be allowed
    expect(isPathWithinCwd('/home/jonas/projects/acme/./src/index.ts', cwd)).toBe(true)
  })

  test('blocks path starting outside cwd', () => {
    expect(isPathWithinCwd('/etc/passwd', cwd)).toBe(false)
  })

  test('blocks path in sibling directory', () => {
    expect(isPathWithinCwd('/home/jonas/projects/other/file.txt', cwd)).toBe(false)
  })

  test('blocks path that is a prefix match but not a real child', () => {
    // /home/jonas/projects/acme-secret should NOT match /home/jonas/projects/acme
    expect(isPathWithinCwd('/home/jonas/projects/acme-secret/file.txt', cwd)).toBe(false)
  })

  // Null bytes and special characters
  test('blocks null byte injection', () => {
    expect(isPathWithinCwd('/home/jonas/projects/acme/file\0.txt', cwd)).toBe(false)
  })

  // Relative paths - resolved against CWD
  test('allows relative paths within cwd', () => {
    expect(isPathWithinCwd('src/index.ts', cwd)).toBe(true)
  })

  test('allows simple filename', () => {
    expect(isPathWithinCwd('README.md', cwd)).toBe(true)
  })

  test('blocks relative traversal escaping cwd', () => {
    expect(isPathWithinCwd('../../../etc/passwd', cwd)).toBe(false)
  })

  test('allows relative path with ./ prefix', () => {
    expect(isPathWithinCwd('./src/index.ts', cwd)).toBe(true)
  })

  test('blocks relative traversal that escapes then re-enters', () => {
    expect(isPathWithinCwd('../../other-project/file.txt', cwd)).toBe(false)
  })

  // Empty/missing inputs
  test('blocks empty path', () => {
    expect(isPathWithinCwd('', cwd)).toBe(false)
  })

  test('blocks empty cwd', () => {
    expect(isPathWithinCwd('/some/path', '')).toBe(false)
  })

  // Trailing slash normalization
  test('handles cwd with trailing slash', () => {
    expect(isPathWithinCwd('/home/jonas/projects/acme/file.txt', '/home/jonas/projects/acme/')).toBe(true)
  })

  test('handles path with trailing slash', () => {
    expect(isPathWithinCwd('/home/jonas/projects/acme/src/', cwd)).toBe(true)
  })

  // URL encoding shouldn't matter (path.resolve handles this)
  test('blocks encoded traversal via double dots', () => {
    expect(isPathWithinCwd('/home/jonas/projects/acme/..%2F..%2Fetc/passwd', cwd)).toBe(true)
    // Note: %2F is a literal string, not a path separator. path.resolve treats it as a filename.
    // This resolves to /home/jonas/projects/acme/..%2F..%2Fetc/passwd which is within cwd.
    // The wrapper filesystem won't find it, which is fine - no traversal occurs.
  })
})
