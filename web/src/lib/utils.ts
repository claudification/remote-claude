import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { BUILD_VERSION } from '../../../src/shared/version'

/** Key used to detect post-reload outcome and surface a feedback toast. */
export const PRE_RELOAD_KEY = 'rclaude-pre-reload'

/** Tailwind `sm` breakpoint - below this is mobile */
const MOBILE_BREAKPOINT = 640

export function isMobileViewport() {
  return window.innerWidth < MOBILE_BREAKPOINT
}

const IS_TOUCH = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
export function isTouchDevice() {
  return IS_TOUCH
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', { hour12: false })
}

export function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m ago`
}

export function formatDurationMs(ms: number): string {
  const totalMinutes = Math.round(ms / 60000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}

export function lastPathSegments(path: string, n = 3): string {
  // Strip home directory prefix (/Users/xxx/ or /home/xxx/)
  const homeStripped = path.replace(/^\/(Users|home)\/[^/]+\//, '')

  const segments = homeStripped.split('/').filter(Boolean)
  if (segments.length <= n) return homeStripped.startsWith('/') ? homeStripped.slice(1) : homeStripped
  return segments.slice(-n).join('/')
}

/**
 * Display name for a project rooted at `cwd`. Uses the user-provided label
 * when present, otherwise falls back to the last 3 path segments. Same
 * convention the project list + session switcher use — keep all name
 * rendering going through this so un-labelled projects look consistent
 * everywhere. Pass `projectSettings[cwd]?.label` (or `undefined`) as the
 * label; caller handles the lookup so the helper stays map-shape-agnostic.
 */
export function projectDisplayName(cwd: string, label?: string): string {
  return label || lastPathSegments(cwd)
}

/**
 * Slug from an arbitrary display name. Lowercase, alphanumeric + hyphens,
 * capped at 24 chars. Mirrors `src/concentrator/address-book.ts` (server
 * side) and `components/transcript/session-tag.tsx` (client) so slugs
 * round-trip across the wire.
 */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'project'
  )
}

/**
 * Mirror of the addressable ID produced by list_sessions. ALWAYS compound
 * `project:session-slug` so the inserted id stays stable when a second
 * session spawns at the same cwd later. Server logic + rationale live in
 * `src/concentrator/handlers/channel-id.ts` (the canonical implementation
 * that round-trips through send_message).
 *
 * `siblingSessions` is the list of sessions at the same cwd (including this
 * one) -- used purely to disambiguate identical title slugs with a 6-char
 * id suffix.
 */
export function sessionAddressableSlug(
  session: { id: string; cwd: string; title?: string; agentName?: string },
  projectSettings: { [cwd: string]: { label?: string } },
  siblingSessions: ReadonlyArray<{ id: string; title?: string; agentName?: string }>,
): string {
  const projectName = projectSettings[session.cwd]?.label || session.cwd.split('/').filter(Boolean).pop() || 'project'
  const projectSlug = slugify(projectName)
  const titleFor = (s: { id: string; title?: string; agentName?: string }) =>
    slugify(s.title || s.agentName || s.id.slice(0, 8))
  const baseSlug = titleFor(session)
  const collides = siblingSessions.some(other => other.id !== session.id && titleFor(other) === baseSlug)
  const sessionSlug = collides ? `${baseSlug}-${session.id.slice(0, 6)}` : baseSlug
  return `${projectSlug}:${sessionSlug}`
}

export function truncate(text: string, maxLen: number): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}...`
}

export function formatModel(model: string | undefined): string {
  if (!model) return 'unknown'
  return model
    .replace('claude-', '')
    .replace('-20250514', '')
    .replace(/-\d{8}$/, '')
}

/** Context window size for a given model string. Uses LiteLLM DB with hardcoded fallback. */
export { contextWindowFromDb as contextWindowSize } from './model-db'

/** Format effort level from API 'speed' field to human-readable label + symbol */
export function formatEffort(speed: string | undefined): { label: string; symbol: string } | null {
  if (!speed) return null
  switch (speed) {
    case 'fast':
      return { label: 'low', symbol: '\u25CB' } // ○
    case 'standard':
      return { label: 'medium', symbol: '\u25D0' } // ◐
    case 'extended':
      return { label: 'high', symbol: '\u25CF' } // ●
    default:
      return { label: speed, symbol: '\u25D0' }
  }
}

/**
 * Haptic feedback via web-haptics (works on iOS + Android).
 * Uses hidden <input type="checkbox" switch> trick for iOS Safari Taptic Engine.
 * Falls back to Vibration API on Android.
 *
 * Patterns: tap (default), double, success, error, tick
 */
import { WebHaptics } from 'web-haptics'

let _haptics: WebHaptics | null = null
function getHaptics(): WebHaptics {
  if (!_haptics) _haptics = new WebHaptics()
  return _haptics
}

export function haptic(pattern: 'tap' | 'double' | 'success' | 'error' | 'tick' = 'tap') {
  // Don't guard on WebHaptics.isSupported -- it checks navigator.vibrate which iOS lacks.
  // The library works on iOS via a hidden <input switch> DOM trick (the !isSupported path).
  const h = getHaptics()
  switch (pattern) {
    case 'tap':
      h.trigger('light')
      break
    case 'tick':
      h.trigger('selection')
      break
    case 'double':
      h.trigger('medium')
      break
    case 'success':
      h.trigger('success')
      break
    case 'error':
      h.trigger('error')
      break
  }
}

/** Clear all SW caches, unregister service worker, and reload.
 * Stashes the current build hash so the next page load can show feedback
 * (success: hash changed; no-op: hash identical). */
export async function clearCacheAndReload(): Promise<void> {
  try {
    localStorage.setItem(PRE_RELOAD_KEY, JSON.stringify({ hash: BUILD_VERSION.gitHashShort, ts: Date.now() }))
  } catch {}
  const keys = await caches.keys()
  await Promise.all(keys.map(k => caches.delete(k)))
  const reg = await navigator.serviceWorker?.getRegistration('/sw.js')
  if (reg) await reg.unregister()
  window.location.reload()
}
