/**
 * Address Book: per-caller routing table with stable, locally-scoped IDs.
 *
 * Each caller CWD gets its own address book mapping short readable IDs
 * to target CWDs. IDs are auto-assigned from project name/label and
 * persisted across restarts. An ID is only meaningful to its owner --
 * leaked IDs are useless to other sessions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// callerCwd -> { localId -> targetCwd }
type BookMap = Record<string, Record<string, string>>

let filePath = ''
let books: BookMap = {}
let dirty = false
let saveTimer: ReturnType<typeof setTimeout> | null = null

export function initAddressBook(cacheDir: string): void {
  filePath = join(cacheDir, 'address-books.json')
  mkdirSync(dirname(filePath), { recursive: true })
  if (existsSync(filePath)) {
    try {
      books = JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch {
      books = {}
    }
  }
}

function scheduleSave(): void {
  if (saveTimer) return
  dirty = true
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (dirty && filePath) {
      writeFileSync(filePath, JSON.stringify(books, null, 2))
      dirty = false
    }
  }, 1000) // debounce 1s
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

/** Get or assign a local ID for a target CWD, scoped to the caller. */
export function getOrAssign(callerCwd: string, targetCwd: string, targetName: string): string {
  if (!books[callerCwd]) books[callerCwd] = {}
  const book = books[callerCwd]

  // Check if we already have an entry for this target
  for (const [id, cwd] of Object.entries(book)) {
    if (cwd === targetCwd) return id
  }

  // Assign a new ID based on the target name
  let slug = slugify(targetName)
  if (book[slug]) {
    // Collision -- append suffix
    let i = 2
    while (book[`${slug}-${i}`]) i++
    slug = `${slug}-${i}`
  }

  book[slug] = targetCwd
  scheduleSave()
  return slug
}

/** Resolve a local ID back to a target CWD. */
export function resolve(callerCwd: string, localId: string): string | undefined {
  return books[callerCwd]?.[localId]
}

/** Get all entries in a caller's address book. */
export function getBook(callerCwd: string): Record<string, string> {
  return books[callerCwd] || {}
}

/** Remove a specific entry from a caller's address book. */
export function removeEntry(callerCwd: string, localId: string): void {
  if (books[callerCwd]) {
    delete books[callerCwd][localId]
    if (Object.keys(books[callerCwd]).length === 0) {
      delete books[callerCwd]
    }
    scheduleSave()
  }
}

/** Clean up entries pointing to CWDs that no longer have any sessions. */
export function pruneStale(activeCwds: Set<string>): number {
  let removed = 0
  for (const [callerCwd, book] of Object.entries(books)) {
    for (const [id, targetCwd] of Object.entries(book)) {
      if (!activeCwds.has(targetCwd)) {
        delete book[id]
        removed++
      }
    }
    if (Object.keys(book).length === 0) delete books[callerCwd]
  }
  if (removed > 0) scheduleSave()
  return removed
}
