/**
 * Address Book: per-caller routing table with stable, locally-scoped IDs.
 *
 * Each caller project gets its own address book mapping short readable IDs
 * to target projects. IDs are auto-assigned from project name/label and
 * persisted across restarts. An ID is only meaningful to its owner --
 * leaked IDs are useless to other sessions.
 * Backed by StoreDriver KVStore (replaces JSON file persistence).
 */

import type { KVStore } from './store/types'

// callerProject -> { localId -> targetProject }
type BookMap = Record<string, Record<string, string>>

// Bump when the slug-generation rules change and existing books must be rebuilt.
// v2: project slugs are derived from project label/dirname, not session titles.
const CURRENT_VERSION = 2

const KV_KEY = 'address-books'

interface BookData {
  _version: number
  books: BookMap
}

let kv: KVStore | null = null
let books: BookMap = {}

export function initAddressBook(store: KVStore): void {
  kv = store
  const parsed = kv.get<BookData>(KV_KEY)
  if (parsed && typeof parsed === 'object' && parsed._version === CURRENT_VERSION) {
    books = parsed.books || {}
  } else if (parsed) {
    // Legacy (unversioned) or older-version data: slugs may be poisoned by the
    // pre-v2 rule that used session titles as project slugs. Rebuild lazily.
    books = {}
    save()
  } else {
    books = {}
  }
}

function save(): void {
  if (!kv) return
  const payload: BookData = { _version: CURRENT_VERSION, books }
  kv.set(KV_KEY, payload)
}

/** Generate a slug from a name. Lowercase, alphanumeric + hyphens. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'project'
  )
}

/** Get or assign a local ID for a target project, scoped to the caller. */
export function getOrAssign(callerProject: string, targetProject: string, targetName: string): string {
  if (!books[callerProject]) books[callerProject] = {}
  const book = books[callerProject]

  // Check if we already have an entry for this target
  for (const [id, proj] of Object.entries(book)) {
    if (proj === targetProject) return id
  }

  // Assign a new ID based on the target name
  let slug = slugify(targetName)
  if (book[slug]) {
    // Collision -- append suffix
    let i = 2
    while (book[`${slug}-${i}`]) i++
    slug = `${slug}-${i}`
  }

  book[slug] = targetProject
  save()
  return slug
}

/** Resolve a local ID back to a target project. */
export function resolve(callerProject: string, localId: string): string | undefined {
  return books[callerProject]?.[localId]
}

/** Get all entries in a caller's address book. */
export function getBook(callerProject: string): Record<string, string> {
  return books[callerProject] || {}
}

/** Remove a specific entry from a caller's address book. */
export function removeEntry(callerProject: string, localId: string): void {
  if (books[callerProject]) {
    delete books[callerProject][localId]
    if (Object.keys(books[callerProject]).length === 0) {
      delete books[callerProject]
    }
    save()
  }
}

/** Clean up entries pointing to projects that no longer have any conversation. */
export function pruneStale(activeProjects: Set<string>): number {
  let removed = 0
  for (const [callerProject, book] of Object.entries(books)) {
    for (const [id, targetProject] of Object.entries(book)) {
      if (!activeProjects.has(targetProject)) {
        delete book[id]
        removed++
      }
    }
    if (Object.keys(book).length === 0) delete books[callerProject]
  }
  if (removed > 0) save()
  return removed
}
