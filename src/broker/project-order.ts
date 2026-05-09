/**
 * Project Order - persistent tree structure for the sidebar project list.
 *
 * Each leaf node represents a project keyed by its project URI
 * (e.g. `claude:///Users/jonas/projects/remote-claude`).
 * Legacy `cwd:<path>` node IDs are migrated on load.
 * Backed by StoreDriver KVStore (replaces JSON file persistence).
 */

import { cwdToProjectUri } from '../shared/project-uri'
import type { KVStore } from './store/types'

export interface ProjectOrderGroup {
  id: string
  type: 'group'
  name: string
  children: ProjectOrderNode[]
  isOpen?: boolean
}

export interface ProjectOrderProject {
  id: string // project URI (e.g. claude:///path)
  type: 'project'
}

export type ProjectOrderNode = ProjectOrderGroup | ProjectOrderProject

export interface ProjectOrder {
  tree: ProjectOrderNode[]
}

const KV_KEY = 'project-order'

let kv: KVStore | null = null
let order: ProjectOrder = { tree: [] }

/** Migrate a node ID from legacy `cwd:<path>` format to project URI. */
function migrateNodeId(id: string): string {
  if (id.startsWith('cwd:')) {
    return cwdToProjectUri(id.slice(4))
  }
  return id
}

/**
 * Normalize legacy in-memory shapes to the current format. Accepts:
 *   - Current: { tree: [...] } with node.type === 'project' | 'group'
 *   - Legacy v2: { version: 2, tree: [...] } with leaf node.type === 'session'
 *   - Legacy node IDs: `cwd:<path>` -> project URI
 * Anything else returns an empty tree.
 */
function normalize(raw: unknown): { order: ProjectOrder; migrated: boolean } {
  if (!raw || typeof raw !== 'object') return { order: { tree: [] }, migrated: false }
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.tree)) return { order: { tree: [] }, migrated: false }

  let migrated = false

  function walk(nodes: unknown[]): ProjectOrderNode[] {
    const out: ProjectOrderNode[] = []
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue
      const node = n as Record<string, unknown>
      if (node.type === 'group' && typeof node.id === 'string' && typeof node.name === 'string') {
        const children = Array.isArray(node.children) ? walk(node.children) : []
        out.push({
          id: node.id,
          type: 'group',
          name: node.name,
          children,
          ...(typeof node.isOpen === 'boolean' ? { isOpen: node.isOpen } : {}),
        })
      } else if ((node.type === 'project' || node.type === 'session') && typeof node.id === 'string') {
        const newId = migrateNodeId(node.id)
        if (newId !== node.id) migrated = true
        out.push({ id: newId, type: 'project' })
      }
    }
    return out
  }

  return { order: { tree: walk(obj.tree) }, migrated }
}

export function initProjectOrder(store: KVStore): void {
  kv = store

  const raw = kv.get<Record<string, unknown>>(KV_KEY)
  if (raw) {
    try {
      const wasLegacyFormat =
        'version' in raw || JSON.stringify((raw as { tree?: unknown }).tree ?? []).includes('"type":"session"')

      const { order: normalized, migrated: hadCwdIds } = normalize(raw)
      order = normalized

      if (wasLegacyFormat || hadCwdIds) save()
    } catch {
      order = { tree: [] }
    }
  }
}

function save(): void {
  if (!kv) return
  kv.set(KV_KEY, order)
}

export function getProjectOrder(): ProjectOrder {
  return order
}

export function setProjectOrder(update: ProjectOrder): void {
  if (!update || !Array.isArray(update.tree)) return
  const { order: normalized } = normalize(update)
  order = normalized
  save()
}

/** Extract all project URIs from a subtree. */
function getAllTreeProjects(nodes: ProjectOrderNode[] = order.tree): Set<string> {
  const uris = new Set<string>()
  for (const node of nodes) {
    if (node.type === 'project') {
      const uri = node.id.startsWith('cwd:') ? cwdToProjectUri(node.id.slice(4)) : node.id
      uris.add(uri)
    } else {
      for (const u of getAllTreeProjects(node.children)) uris.add(u)
    }
  }
  return uris
}

/** @deprecated Use getAllTreeProjects() instead. */
function _getAllTreeCwds(nodes: ProjectOrderNode[] = order.tree): Set<string> {
  return getAllTreeProjects(nodes)
}
