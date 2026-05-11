/**
 * Module-level cache for the current user's launch profiles.
 *
 * Source of truth = the broker. State lifecycle:
 *  1. App boot   -> loadLaunchProfiles() fills the cache via HTTP
 *  2. Save       -> putLaunchProfiles() returns the canonical list, cache updates
 *  3. Other tab  -> broker pushes launch_profiles_updated, handler calls
 *                   setLaunchProfiles() so every tab stays in sync
 */

import type { LaunchProfile } from '@shared/launch-profile'

type Listener = (profiles: LaunchProfile[] | null) => void

let cache: LaunchProfile[] | null = null
let loading = false
const listeners = new Set<Listener>()

function notify(): void {
  for (const l of listeners) l(cache)
}

export function subscribeLaunchProfiles(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getLaunchProfilesSnapshot(): LaunchProfile[] | null {
  return cache
}

export function isLaunchProfilesLoading(): boolean {
  return loading
}

export function setLaunchProfilesLoading(value: boolean): void {
  loading = value
}

export function setLaunchProfiles(profiles: LaunchProfile[]): void {
  cache = profiles
  notify()
}

export function resetLaunchProfilesCache(): void {
  cache = null
  loading = false
  notify()
}
