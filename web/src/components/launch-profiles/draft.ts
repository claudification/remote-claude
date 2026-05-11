/**
 * Local "draft" mutation helpers for the manager editor.
 *
 * The manager works on a local copy of the profile list. Saves overwrite
 * the broker. These helpers keep the manager component free of array-
 * splicing logic.
 */

import type { LaunchProfile } from '@shared/launch-profile'
import { newLaunchProfileId } from '@shared/launch-profile'

export function blankProfile(nowMs: number = Date.now()): LaunchProfile {
  return {
    id: newLaunchProfileId(),
    name: 'New profile',
    spawn: { backend: 'claude' },
    immediate: true,
    createdAt: nowMs,
    updatedAt: nowMs,
  }
}

export function replaceProfile(list: LaunchProfile[], next: LaunchProfile): LaunchProfile[] {
  const i = list.findIndex(p => p.id === next.id)
  if (i < 0) return [...list, next]
  const copy = list.slice()
  copy[i] = next
  return copy
}

export function removeProfile(list: LaunchProfile[], id: string): LaunchProfile[] {
  return list.filter(p => p.id !== id)
}

export function moveProfile(list: LaunchProfile[], id: string, dir: 'up' | 'down'): LaunchProfile[] {
  const i = list.findIndex(p => p.id === id)
  if (i < 0) return list
  const j = dir === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= list.length) return list
  const copy = list.slice()
  ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  return copy
}

export function findProfile(list: LaunchProfile[], id: string | undefined): LaunchProfile | undefined {
  if (!id) return undefined
  return list.find(p => p.id === id)
}

export function findDuplicateChord(list: LaunchProfile[]): string | null {
  const seen = new Set<string>()
  for (const p of list) {
    if (!p.chord) continue
    if (seen.has(p.chord)) return p.chord
    seen.add(p.chord)
  }
  return null
}

export function findDuplicateName(list: LaunchProfile[]): string | null {
  const seen = new Set<string>()
  for (const p of list) {
    const key = p.name.trim().toLowerCase()
    if (!key) continue
    if (seen.has(key)) return p.name
    seen.add(key)
  }
  return null
}
