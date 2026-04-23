/**
 * Project Settings - persistent label/icon/color per project.
 * Backed by StoreDriver KVStore (replaces JSON file persistence).
 * Keys are project URIs (claude:///path). Bare CWD inputs are transparently upgraded.
 */

import { cwdToProjectUri } from '../shared/project-uri'
import type { ProjectSettings } from '../shared/protocol'
import type { KVStore } from './store/types'

export type { ProjectSettings } from '../shared/protocol'

const KV_KEY = 'project-settings'

type SettingsMap = Record<string, ProjectSettings>

let kv: KVStore | null = null
let settings: SettingsMap = {}

function normalizeKey(project: string): string {
  if (project.startsWith('/')) return cwdToProjectUri(project)
  return project
}

export function initProjectSettings(store: KVStore): void {
  kv = store

  const raw = kv.get<SettingsMap>(KV_KEY)
  if (raw) {
    try {
      // Migrate legacy CWD keys to project URIs
      let migrated = false
      for (const [key, value] of Object.entries(raw)) {
        if (key.startsWith('/')) {
          const uri = cwdToProjectUri(key)
          settings[uri] = { ...(settings[uri] || {}), ...value }
          migrated = true
        } else {
          settings[key] = value
        }
      }
      if (migrated) save()
    } catch {
      settings = {}
    }
  }
}

function save(): void {
  if (!kv) return
  kv.set(KV_KEY, settings)
}

export function getAllProjectSettings(): SettingsMap {
  return settings
}

export function getProjectSettings(project: string): ProjectSettings | null {
  return settings[normalizeKey(project)] || null
}

export function setProjectSettings(project: string, update: ProjectSettings): void {
  const key = normalizeKey(project)
  const existing = settings[key] || {}
  settings[key] = { ...existing, ...update }
  // Remove empty string values
  for (const [k, val] of Object.entries(settings[key])) {
    if (val === '' || val === undefined) {
      delete (settings[key] as Record<string, unknown>)[k]
    }
  }
  // Remove entry if empty
  if (Object.keys(settings[key]).length === 0) {
    delete settings[key]
  }
  save()
}

export function deleteProjectSettings(project: string): void {
  delete settings[normalizeKey(project)]
  save()
}
