/**
 * Session Order - persistent pin/organize metadata for sessions
 * Stored as a JSON file in the concentrator cache dir.
 * Pure metadata - old clients that don't know about this just ignore it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface SessionOrderEntry {
  cwd: string
  group?: string
}

export interface SessionOrder {
  organized: SessionOrderEntry[]
}

let orderPath = ''
let order: SessionOrder = { organized: [] }

export function initSessionOrder(cacheDir: string): void {
  orderPath = join(cacheDir, 'session-order.json')
  mkdirSync(dirname(orderPath), { recursive: true })

  if (existsSync(orderPath)) {
    try {
      const raw = JSON.parse(readFileSync(orderPath, 'utf-8'))
      order = { organized: Array.isArray(raw.organized) ? raw.organized : [] }
    } catch {
      order = { organized: [] }
    }
  }
}

function save(): void {
  if (!orderPath) return
  writeFileSync(orderPath, JSON.stringify(order, null, 2))
}

export function getSessionOrder(): SessionOrder {
  return order
}

export function setSessionOrder(update: SessionOrder): void {
  order = { organized: Array.isArray(update.organized) ? update.organized : [] }
  save()
}

export function pinSession(cwd: string): void {
  if (!order.organized.some(e => e.cwd === cwd)) {
    order.organized.push({ cwd })
    save()
  }
}

export function unpinSession(cwd: string): void {
  order.organized = order.organized.filter(e => e.cwd !== cwd)
  save()
}

export function moveSession(cwd: string, toIndex: number): void {
  const fromIndex = order.organized.findIndex(e => e.cwd === cwd)
  if (fromIndex === -1) return
  const [entry] = order.organized.splice(fromIndex, 1)
  order.organized.splice(Math.max(0, Math.min(toIndex, order.organized.length)), 0, entry)
  save()
}
