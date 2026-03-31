/**
 * Session Links - persistent CWD-pair links for inter-session communication.
 * Links are keyed by project CWD (stable across restarts/rekeys).
 * Storage: {cacheDir}/session-links.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface PersistedLink {
  cwdA: string // alphabetically first CWD (normalized)
  cwdB: string // alphabetically second CWD (normalized)
  createdAt: number
  lastUsed: number
}

interface LinksFile {
  version: 1
  links: PersistedLink[]
}

let linksPath = ''
let links: PersistedLink[] = []

function normalizeCwd(cwd: string): string {
  return resolve(cwd).replace(/\/+$/, '')
}

function cwdKey(a: string, b: string): string {
  const na = normalizeCwd(a)
  const nb = normalizeCwd(b)
  return na < nb ? `${na}\0${nb}` : `${nb}\0${na}`
}

function sortedPair(a: string, b: string): [string, string] {
  const na = normalizeCwd(a)
  const nb = normalizeCwd(b)
  return na < nb ? [na, nb] : [nb, na]
}

function save(): void {
  if (!linksPath) return
  const data: LinksFile = { version: 1, links }
  writeFileSync(linksPath, JSON.stringify(data, null, 2))
}

export function initSessionLinks(cacheDir: string): void {
  linksPath = join(cacheDir, 'session-links.json')
  mkdirSync(dirname(linksPath), { recursive: true })

  if (existsSync(linksPath)) {
    try {
      const raw = JSON.parse(readFileSync(linksPath, 'utf-8')) as LinksFile
      links = raw.links || []
      // Evict links not used in 90 days
      const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
      const before = links.length
      links = links.filter(l => l.lastUsed > cutoff)
      if (links.length < before) save()
      console.log(`[links] Loaded ${links.length} persisted links (evicted ${before - links.length} stale)`)
    } catch {
      links = []
    }
  }
}

export function getPersistedLinks(): PersistedLink[] {
  return links
}

export function findLink(cwdA: string, cwdB: string): PersistedLink | null {
  const key = cwdKey(cwdA, cwdB)
  return links.find(l => cwdKey(l.cwdA, l.cwdB) === key) || null
}

export function addPersistedLink(cwdA: string, cwdB: string): PersistedLink {
  const existing = findLink(cwdA, cwdB)
  if (existing) {
    existing.lastUsed = Date.now()
    save()
    return existing
  }
  const [a, b] = sortedPair(cwdA, cwdB)
  const link: PersistedLink = { cwdA: a, cwdB: b, createdAt: Date.now(), lastUsed: Date.now() }
  links.push(link)
  save()
  console.log(`[links] Persisted: ${a} <-> ${b}`)
  return link
}

export function removePersistedLink(cwdA: string, cwdB: string): boolean {
  const key = cwdKey(cwdA, cwdB)
  const idx = links.findIndex(l => cwdKey(l.cwdA, l.cwdB) === key)
  if (idx >= 0) {
    const removed = links.splice(idx, 1)[0]
    save()
    console.log(`[links] Removed: ${removed.cwdA} <-> ${removed.cwdB}`)
    return true
  }
  return false
}

export function touchLink(cwdA: string, cwdB: string): void {
  const existing = findLink(cwdA, cwdB)
  if (existing) {
    existing.lastUsed = Date.now()
    save()
  }
}

export function getLinksForCwd(cwd: string): PersistedLink[] {
  const n = normalizeCwd(cwd)
  return links.filter(l => l.cwdA === n || l.cwdB === n)
}
