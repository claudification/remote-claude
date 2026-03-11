/**
 * Global Settings - shared config between backend and frontend
 * Stored as JSON in the concentrator cache dir.
 * Uses Zod for validation with soft-fail (strips unknown/invalid fields).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'

export const GlobalSettingsSchema = z.object({
  idleTimeoutMinutes: z.number().min(1).max(120).default(10),
  userLabel: z.string().max(20).default(''),
  agentLabel: z.string().max(20).default(''),
})

export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>

let settingsPath = ''
let settings: GlobalSettings = GlobalSettingsSchema.parse({})

export function initGlobalSettings(cacheDir: string): void {
  settingsPath = join(cacheDir, 'global-settings.json')
  mkdirSync(dirname(settingsPath), { recursive: true })

  if (existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      settings = GlobalSettingsSchema.parse(raw)
    } catch {
      // Soft fail - use defaults
      settings = GlobalSettingsSchema.parse({})
    }
  }
}

function save(): void {
  if (!settingsPath) return
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

export function getGlobalSettings(): GlobalSettings {
  return { ...settings }
}

export function updateGlobalSettings(update: unknown): { settings: GlobalSettings; errors?: string[] } {
  const errors: string[] = []

  if (typeof update !== 'object' || update === null) {
    return { settings: { ...settings }, errors: ['Invalid input: expected object'] }
  }

  // Merge with existing, then validate
  const merged = { ...settings, ...update }
  const result = GlobalSettingsSchema.safeParse(merged)

  if (result.success) {
    settings = result.data
    save()
    return { settings: { ...settings } }
  }

  // Soft fail: apply only valid fields, collect errors and log warnings
  for (const issue of result.error.issues) {
    const msg = `${issue.path.join('.')}: ${issue.message}`
    errors.push(msg)
    console.warn(`[settings] Rejected field: ${msg}`)
  }

  // Try field-by-field merge - only apply fields that pass validation
  const input = update as Record<string, unknown>
  for (const key of Object.keys(input)) {
    const testMerge = { ...settings, [key]: input[key] }
    const fieldResult = GlobalSettingsSchema.safeParse(testMerge)
    if (fieldResult.success) {
      settings = fieldResult.data
    }
  }
  save()
  console.log(`[settings] Updated (with ${errors.length} rejected field${errors.length !== 1 ? 's' : ''})`)
  return { settings: { ...settings }, errors }
}
