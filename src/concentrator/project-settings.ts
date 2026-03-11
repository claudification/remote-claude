/**
 * Project Settings - persistent label/icon/color per project path
 * Stored as a JSON file in the concentrator cache dir.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ProjectSettings {
  label?: string
  icon?: string
  color?: string
  keyterms?: string[]
}

type SettingsMap = Record<string, ProjectSettings>

let settingsPath = ''
let settings: SettingsMap = {}

export function initProjectSettings(cacheDir: string): void {
  settingsPath = join(cacheDir, 'project-settings.json')
  mkdirSync(dirname(settingsPath), { recursive: true })

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
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

export function getProjectSettings(cwd: string): ProjectSettings | null {
  return settings[cwd] || null
}

export function setProjectSettings(cwd: string, update: ProjectSettings): void {
  const existing = settings[cwd] || {}
  settings[cwd] = { ...existing, ...update }
  // Remove empty string values
  for (const [key, val] of Object.entries(settings[cwd])) {
    if (val === '' || val === undefined) {
      delete (settings[cwd] as any)[key]
    }
  }
  // Remove entry if empty
  if (Object.keys(settings[cwd]).length === 0) {
    delete settings[cwd]
  }
  save()
}

export function deleteProjectSettings(cwd: string): void {
  delete settings[cwd]
  save()
}
