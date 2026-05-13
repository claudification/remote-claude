import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { BUILD_VERSION } from '../../../src/shared/version'
import { extractProjectLabel, projectPath } from './types'

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
 * Display name for a project identified by URI or path. Uses the user-provided
 * label when present, otherwise falls back to the last 3 path segments. Same
 * convention the project list + session switcher use -- keep all name
 * rendering going through this so un-labelled projects look consistent
 * everywhere. Pass `projectSettings[project]?.label` (or `undefined`) as the
 * label; caller handles the lookup so the helper stays map-shape-agnostic.
 *
 * Accepts both project URIs ("claude:///Users/jonas/foo") and raw paths.
 */
export function projectDisplayName(projectOrPath: string, label?: string): string {
  return label || lastPathSegments(projectPath(projectOrPath))
}

/**
 * Slug from an arbitrary display name. Lowercase, alphanumeric + hyphens,
 * capped at 24 chars. Mirrors `src/broker/address-book.ts` (server
 * side) and `components/transcript/session-tag.tsx` (client) so slugs
 * round-trip across the wire.
 */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'project'
  )
}

/**
 * Mirror of the addressable ID produced by list_conversations. ALWAYS compound
 * `project:session-slug` so the inserted id stays stable when a second
 * session spawns at the same project later. Server logic + rationale live in
 * `src/broker/handlers/channel-id.ts` (the canonical implementation
 * that round-trips through send_message).
 *
 * `siblingConversations` is the list of sessions at the same project (including
 * this one) -- used purely to disambiguate identical title slugs with a
 * 6-char id suffix.
 */
export function sessionAddressableSlug(
  session: { id: string; project: string; title?: string; agentName?: string },
  projectSettings: { [project: string]: { label?: string } },
  siblingConversations: ReadonlyArray<{ id: string; title?: string; agentName?: string }>,
): string {
  const projectName = projectSettings[session.project]?.label || extractProjectLabel(session.project) || 'project'
  const projectSlug = slugify(projectName)
  const titleFor = (s: { id: string; title?: string; agentName?: string }) =>
    slugify(s.title || s.agentName || s.id.slice(0, 8))
  const baseSlug = titleFor(session)
  const collides = siblingConversations.some(other => other.id !== session.id && titleFor(other) === baseSlug)
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

/** Format effort level to human-readable label + symbol */
export function formatEffort(effort: string | undefined): { label: string; symbol: string } | null {
  if (!effort) return null
  switch (effort) {
    case 'low':
      return { label: 'low', symbol: '\u25CB' } // ○
    case 'medium':
      return { label: 'medium', symbol: '\u25D0' } // ◐
    case 'high':
      return { label: 'high', symbol: '\u25CF' } // ●
    case 'xhigh':
      return { label: 'xhigh', symbol: '\u25C9' } // ◉
    case 'max':
      return { label: 'max', symbol: '\u2B24' } // ⬤
    default:
      return { label: effort, symbol: '\u25D0' }
  }
}

export function formatPermissionMode(
  mode: string | undefined,
): { label: string; title: string; color: string; bgColor: string } | null {
  if (!mode || mode === 'default') return null
  switch (mode) {
    case 'plan':
      return {
        label: 'P',
        title: 'Plan mode -- requires plan approval',
        color: 'text-blue-400',
        bgColor: 'bg-blue-500/10',
      }
    case 'acceptEdits':
      return {
        label: 'E',
        title: 'Accept edits -- auto-accept file changes',
        color: 'text-cyan-400',
        bgColor: 'bg-cyan-500/10',
      }
    case 'auto':
      return {
        label: 'A',
        title: 'Auto mode -- accept all actions',
        color: 'text-emerald-400',
        bgColor: 'bg-emerald-500/10',
      }
    case 'bypassPermissions':
      return {
        label: 'B',
        title: 'Bypass -- dangerously skip all permissions',
        color: 'text-red-400',
        bgColor: 'bg-red-500/10',
      }
    default:
      return {
        label: mode[0]?.toUpperCase() || '?',
        title: `Permission mode: ${mode}`,
        color: 'text-muted-foreground',
        bgColor: 'bg-muted/30',
      }
  }
}

export function formatRateBucketName(type: string | undefined): string {
  if (!type) return 'API'
  const map: Record<string, string> = {
    seven_day: '7-day',
    five_hour: '5-hour',
  }
  return map[type] || type
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

/** Nuclear reload: nuke ALL service workers, ALL caches, sessionStorage,
 * then hard-navigate with a cache-bust param. Guaranteed to fire the
 * reload within 2s even if cache/SW ops hang or reject. */
export function clearCacheAndReload(): void {
  try {
    localStorage.setItem(PRE_RELOAD_KEY, JSON.stringify({ hash: BUILD_VERSION.gitHashShort, ts: Date.now() }))
  } catch {}

  const deadline = setTimeout(hardNavigate, 2000)

  ;(async () => {
    try {
      const regs = await navigator.serviceWorker?.getRegistrations()
      if (regs) await Promise.allSettled(regs.map(r => r.unregister()))
    } catch {}
    try {
      const keys = await caches?.keys()
      if (keys) await Promise.allSettled(keys.map(k => caches.delete(k)))
    } catch {}
    try {
      sessionStorage.clear()
    } catch {}
    clearTimeout(deadline)
    hardNavigate()
  })()
}

function hardNavigate() {
  window.location.replace(`${window.location.origin}/?_cb=${Date.now()}${window.location.hash}`)
}
