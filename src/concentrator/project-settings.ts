/**
 * Project Settings - persistent label/icon/color per project.
 * Stored as a JSON file in the concentrator cache dir.
 * Keys are project URIs (claude:///path). Bare CWD inputs are transparently upgraded.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cwdToProjectUri } from '../shared/project-uri'
import type { ProjectSettings } from '../shared/protocol'

export type { ProjectSettings } from '../shared/protocol'

type SettingsMap = Record<string, ProjectSettings>

let settingsPath = ''
let settings: SettingsMap = {}

function normalizeKey(project: string): string {
  if (project.startsWith('/')) return cwdToProjectUri(project)
  return project
}

export function initProjectSettings(cacheDir: string): void {
  settingsPath = join(cacheDir, 'project-settings.json')
  mkdirSync(dirname(settingsPath), { recursive: true })

  if (existsSync(settingsPath)) {
    try {
      const raw: SettingsMap = JSON.parse(readFileSync(settingsPath, 'utf-8'))
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
  if (!settingsPath) return
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
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
