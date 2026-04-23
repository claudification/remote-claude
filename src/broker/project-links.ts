/**
 * Project Links - persistent project-pair links for inter-project communication.
 * Links are keyed by project URI (stable across restarts/rekeys).
 * Backed by StoreDriver KVStore (replaces JSON file persistence).
 */

import { cwdToProjectUri } from '../shared/project-uri'
import type { KVStore } from './store/types'

export interface PersistedLink {
  projectA: string // alphabetically first project URI
  projectB: string // alphabetically second project URI
  createdAt: number
  lastUsed: number
}

const KV_KEY = 'project-links'

let kv: KVStore | null = null
let links: PersistedLink[] = []

function toUri(value: string): string {
  if (value.includes('://')) return value
  return cwdToProjectUri(value)
}

function linkKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`
}

function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

function save(): void {
  if (!kv) return
  kv.set(KV_KEY, links)
}

function migrateLink(link: PersistedLink): boolean {
  const legacy = link as unknown as Record<string, unknown>
  let changed = false

  // Field rename: cwdA/cwdB -> projectA/projectB
  if ('cwdA' in legacy) {
    legacy.projectA = legacy.cwdA
    delete legacy.cwdA
    changed = true
  }
  if ('cwdB' in legacy) {
    legacy.projectB = legacy.cwdB
    delete legacy.cwdB
    changed = true
  }

  // Value migration: bare paths -> project URIs
  if (link.projectA && !link.projectA.includes('://')) {
    link.projectA = cwdToProjectUri(link.projectA)
    changed = true
  }
  if (link.projectB && !link.projectB.includes('://')) {
    link.projectB = cwdToProjectUri(link.projectB)
    changed = true
  }

  // Re-sort after URI conversion (alphabetical order may change)
  if (changed && link.projectA > link.projectB) {
    const tmp = link.projectA
    link.projectA = link.projectB
    link.projectB = tmp
  }

  return changed
}

export function initProjectLinks(store: KVStore): void {
  kv = store

  const raw = kv.get<PersistedLink[]>(KV_KEY)
  if (raw && Array.isArray(raw)) {
    links = raw
    let migrated = false
    for (const link of links) {
      if (migrateLink(link)) migrated = true
    }
    // Evict links not used in 90 days
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
    const before = links.length
    links = links.filter(l => l.lastUsed > cutoff)
    if (migrated || links.length < before) save()
    console.log(`[links] Loaded ${links.length} persisted project links (evicted ${before - links.length} stale)`)
  } else {
    links = []
  }
}

export function getPersistedLinks(): PersistedLink[] {
  return links
}

export function findLink(projectA: string, projectB: string): PersistedLink | null {
  const key = linkKey(toUri(projectA), toUri(projectB))
  return links.find(l => linkKey(l.projectA, l.projectB) === key) || null
}

export function addPersistedLink(projectA: string, projectB: string): PersistedLink {
  const existing = findLink(projectA, projectB)
  if (existing) {
    existing.lastUsed = Date.now()
    save()
    return existing
  }
  const [a, b] = sortedPair(toUri(projectA), toUri(projectB))
  const link: PersistedLink = { projectA: a, projectB: b, createdAt: Date.now(), lastUsed: Date.now() }
  links.push(link)
  save()
  console.log(`[links] Persisted: ${a} <-> ${b}`)
  return link
}

export function removePersistedLink(projectA: string, projectB: string): boolean {
  const key = linkKey(toUri(projectA), toUri(projectB))
  const idx = links.findIndex(l => linkKey(l.projectA, l.projectB) === key)
  if (idx >= 0) {
    const removed = links.splice(idx, 1)[0]
    save()
    console.log(`[links] Removed: ${removed.projectA} <-> ${removed.projectB}`)
    return true
  }
  return false
}

export function touchLink(projectA: string, projectB: string): void {
  const existing = findLink(projectA, projectB)
  if (existing) {
    existing.lastUsed = Date.now()
    save()
  }
}

export function getLinksForProject(project: string): PersistedLink[] {
  const uri = toUri(project)
  return links.filter(l => l.projectA === uri || l.projectB === uri)
}
