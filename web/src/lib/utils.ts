import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Tailwind `sm` breakpoint - below this is mobile */
export const MOBILE_BREAKPOINT = 640

export function isMobileViewport() {
  return window.innerWidth < MOBILE_BREAKPOINT
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

export function truncatePath(path: string, maxLen = 40): string {
  if (path.length <= maxLen) return path
  return `...${path.slice(-maxLen + 3)}`
}

export function lastPathSegments(path: string, n = 3): string {
  // Strip home directory prefix (/Users/xxx/ or /home/xxx/)
  const homeStripped = path.replace(/^\/(Users|home)\/[^/]+\//, '')

  const segments = homeStripped.split('/').filter(Boolean)
  if (segments.length <= n) return homeStripped.startsWith('/') ? homeStripped.slice(1) : homeStripped
  return segments.slice(-n).join('/')
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

/** Context window size for a given model string. Opus 4.6 has 1M, everything else 200K. */
export function contextWindowSize(model: string | undefined): number {
  if (!model) return 200_000
  const m = model.toLowerCase()
  if (m.includes('opus-4-6') || m.includes('opus-4.6')) return 1_000_000
  return 200_000
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
