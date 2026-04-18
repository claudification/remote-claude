/**
 * Project Order - persistent tree structure for the sidebar project list.
 *
 * Each leaf node represents a project (currently keyed by CWD as `cwd:<path>`,
 * but project identity is intended to become CWD-agnostic over time -- keep
 * renames pointed at "project", not "cwd").
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ProjectOrderGroup {
  id: string
  type: 'group'
  name: string
  children: ProjectOrderNode[]
  isOpen?: boolean
}

export interface ProjectOrderProject {
  id: string // "cwd:<path>" today; opaque project identity going forward
  type: 'project'
}

export type ProjectOrderNode = ProjectOrderGroup | ProjectOrderProject

export interface ProjectOrder {
  tree: ProjectOrderNode[]
}

let orderPath = ''
let order: ProjectOrder = { tree: [] }

/**
 * Normalize legacy in-memory shapes to the current format. Accepts:
 *   - Current: { tree: [...] } with node.type === 'project' | 'group'
 *   - Legacy v2: { version: 2, tree: [...] } with leaf node.type === 'session'
 * Anything else returns an empty tree.
 */
function normalize(raw: unknown): ProjectOrder {
  if (!raw || typeof raw !== 'object') return { tree: [] }
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.tree)) return { tree: [] }

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
        out.push({ id: node.id, type: 'project' })
      }
    }
    return out
  }

  return { tree: walk(obj.tree) }
}

export function initProjectOrder(cacheDir: string): void {
  orderPath = join(cacheDir, 'project-order.json')
  mkdirSync(dirname(orderPath), { recursive: true })

  // One-shot migration from the legacy filename.
  if (!existsSync(orderPath)) {
    const legacyPath = join(cacheDir, 'session-order.json')
    if (existsSync(legacyPath)) {
      try {
        renameSync(legacyPath, orderPath)
        console.log('[project-order] Migrated session-order.json -> project-order.json')
      } catch (err) {
        console.warn('[project-order] Legacy rename failed:', err)
      }
    }
  }

  if (existsSync(orderPath)) {
    try {
      const raw = JSON.parse(readFileSync(orderPath, 'utf-8'))
      const normalized = normalize(raw)
      // Persist if the on-disk shape was legacy (version/session type)
      const wasLegacy =
        (raw && typeof raw === 'object' && 'version' in raw) ||
        JSON.stringify(raw?.tree ?? []).includes('"type":"session"')
      order = normalized
      if (wasLegacy) save()
    } catch {
      order = { tree: [] }
    }
  }
}

function save(): void {
  if (!orderPath) return
  writeFileSync(orderPath, JSON.stringify(order, null, 2))
}

export function getProjectOrder(): ProjectOrder {
  return order
}

export function setProjectOrder(update: ProjectOrder): void {
  if (!update || !Array.isArray(update.tree)) return
  order = normalize(update)
  save()
}

/** Extract all CWD-keyed project IDs from a subtree. */
export function getAllTreeCwds(nodes: ProjectOrderNode[] = order.tree): Set<string> {
  const cwds = new Set<string>()
  for (const node of nodes) {
    if (node.type === 'project') {
      const cwd = node.id.startsWith('cwd:') ? node.id.slice(4) : node.id
      cwds.add(cwd)
    } else {
      for (const c of getAllTreeCwds(node.children)) cwds.add(c)
    }
  }
  return cwds
}
