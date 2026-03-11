import { describe, it, expect } from 'vitest'
import { Fzf } from 'fzf'

describe('Fzf case-insensitive matching', () => {
  const items = [
    { id: '1', label: 'iran', cwd: '/home/user/projects/iran' },
    { id: '2', label: 'remote-claude', cwd: '/home/user/projects/remote-claude' },
    { id: '3', label: 'Northstar', cwd: '/home/user/projects/Northstar' },
  ]

  it('smart-case (default) fails on uppercase query matching lowercase item', () => {
    const fzf = new Fzf(items, {
      selector: (s) => `${s.cwd} ${s.label}`,
      // default is smart-case
    })
    // "Iran" has uppercase I, so smart-case treats it as case-sensitive
    const results = fzf.find('Iran')
    // This should NOT find "iran" (lowercase) because smart-case goes sensitive
    const ids = results.map(r => r.item.id)
    expect(ids).not.toContain('1')
  })

  it('case-insensitive matches regardless of query casing', () => {
    const fzf = new Fzf(items, {
      selector: (s) => `${s.cwd} ${s.label}`,
      casing: 'case-insensitive',
    })

    // Uppercase query should find lowercase item
    const upper = fzf.find('Iran')
    expect(upper.map(r => r.item.id)).toContain('1')

    // Lowercase query should also find it
    const lower = fzf.find('iran')
    expect(lower.map(r => r.item.id)).toContain('1')

    // Mixed case should find PascalCase item
    const mixed = fzf.find('northstar')
    expect(mixed.map(r => r.item.id)).toContain('3')

    const mixedUpper = fzf.find('NORTHSTAR')
    expect(mixedUpper.map(r => r.item.id)).toContain('3')
  })

  it('case-insensitive works with file selector too', () => {
    const files = [
      { name: 'README.md', path: '/project/README.md' },
      { name: 'package.json', path: '/project/package.json' },
      { name: 'Dockerfile', path: '/project/Dockerfile' },
    ]

    const fzf = new Fzf(files, {
      selector: (f) => `${f.name} ${f.path}`,
      casing: 'case-insensitive',
    })

    // lowercase query should find README (uppercase)
    const results = fzf.find('readme')
    expect(results.map(r => r.item.name)).toContain('README.md')

    // uppercase query should find lowercase file
    const results2 = fzf.find('PACKAGE')
    expect(results2.map(r => r.item.name)).toContain('package.json')

    // Mixed case for Dockerfile
    const results3 = fzf.find('dockerfile')
    expect(results3.map(r => r.item.name)).toContain('Dockerfile')

    const results4 = fzf.find('DOCKERFILE')
    expect(results4.map(r => r.item.name)).toContain('Dockerfile')
  })
})
