import { beforeEach, describe, expect, it } from 'bun:test'
import { getBook, getOrAssign, initAddressBook, resolve, slugify } from './address-book'
import type { KVStore } from './store/types'

function createTestKV(): KVStore {
  const data = new Map<string, unknown>()
  return {
    get<T = unknown>(key: string): T | null {
      return (data.get(key) as T) ?? null
    },
    set<T = unknown>(key: string, value: T): void {
      data.set(key, JSON.parse(JSON.stringify(value)))
    },
    delete(key: string): boolean {
      return data.delete(key)
    },
    keys(prefix?: string): string[] {
      const all = [...data.keys()]
      return prefix ? all.filter(k => k.startsWith(prefix)) : all
    },
  }
}

let testKV: KVStore

beforeEach(() => {
  testKV = createTestKV()
  initAddressBook(testKV)
})

describe('address book', () => {
  it('assigns the project slug from the target name (caller-scoped)', () => {
    const id = getOrAssign('/callers/cwd', '/projects/arr', 'Arr')
    expect(id).toBe('arr')
    expect(resolve('/callers/cwd', 'arr')).toBe('/projects/arr')
  })

  it('returns the same slug for repeated getOrAssign on the same target', () => {
    const a = getOrAssign('/callers/cwd', '/projects/arr', 'Arr')
    const b = getOrAssign('/callers/cwd', '/projects/arr', 'Arr')
    expect(a).toBe(b)
  })

  it('does NOT re-slug when the same CWD is reported under different names (project identity is sticky)', () => {
    // First conversation registers with project name "Arr"
    const first = getOrAssign('/callers/cwd', '/projects/arr', 'Arr')
    expect(first).toBe('arr')
    // A second conversation in the same project reports an inconsistent name; the
    // slug must stick to what the project was registered as the first time.
    const second = getOrAssign('/callers/cwd', '/projects/arr', 'something-else')
    expect(second).toBe('arr')
  })

  it('scopes IDs to the caller (leaked IDs are useless elsewhere)', () => {
    getOrAssign('/caller/a', '/projects/arr', 'Arr')
    expect(resolve('/caller/b', 'arr')).toBeUndefined()
  })

  it('collision-suffixes when two different CWDs slug to the same base', () => {
    const one = getOrAssign('/caller', '/projects/arr', 'arr')
    const two = getOrAssign('/caller', '/projects/arr-clone', 'arr')
    expect(one).toBe('arr')
    expect(two).toBe('arr-2')
  })

  it('slugifies reasonably', () => {
    expect(slugify('FRST :: MUSIC :: SITE')).toBe('frst-music-site')
    expect(slugify('  Arr  ')).toBe('arr')
    expect(slugify('')).toBe('project')
  })

  it('wipes legacy (unversioned) data on init', () => {
    // Pre-v2 format: bare map, no _version marker -- slugs may be poisoned by
    // the old rule that keyed project slugs off conversation titles.
    const kvWithLegacy = createTestKV()
    kvWithLegacy.set('address-books', { '/caller': { 'blazing-igloo': '/projects/arr' } })
    initAddressBook(kvWithLegacy)
    expect(getBook('/caller')).toEqual({})
  })

  it('preserves entries from same-version data on init', () => {
    const kvWithData = createTestKV()
    kvWithData.set('address-books', { _version: 2, books: { '/caller': { arr: '/projects/arr' } } })
    initAddressBook(kvWithData)
    expect(resolve('/caller', 'arr')).toBe('/projects/arr')
  })

  it('persists with the current version marker on save', () => {
    getOrAssign('/caller', '/projects/arr', 'Arr')
    // KV writes are synchronous now (no debounce)
    const stored = testKV.get<{ _version: number; books: Record<string, Record<string, string>> }>('address-books')
    expect(stored).not.toBeNull()
    expect(stored?._version).toBe(2)
    expect(stored?.books['/caller'].arr).toBe('/projects/arr')
  })
})
