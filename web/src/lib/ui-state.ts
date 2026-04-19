/**
 * Batched, resilient localStorage persistence for ephemeral UI state.
 *
 * Debounces writes to avoid hammering localStorage on every tab switch or
 * session select. Flushes on beforeunload so nothing is lost.
 */

const STORAGE_KEY = 'ui-state'
const FLUSH_DELAY_MS = 2000
const MAX_TAB_ENTRIES = 100
const PRUNE_TO = 50

interface UIState {
  /** Last selected session ID (supplements URL hash for reload resilience) */
  lastSessionId: string | null
  /** Remembered tab per session */
  tabPerSession: Record<string, string>
}

const defaults: UIState = {
  lastSessionId: null,
  tabPerSession: {},
}

let cache: UIState | undefined
let flushTimer: ReturnType<typeof setTimeout> | null = null
let dirty = false

function load(): UIState {
  if (cache !== undefined) return cache
  let parsed: UIState
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    parsed = raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults }
  } catch {
    parsed = { ...defaults }
  }
  cache = parsed
  return parsed
}

function scheduleFlush() {
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS)
}

/** Flush pending state to localStorage immediately. Safe to call any time. */
function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!dirty || !cache) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // Quota exceeded or private browsing -- silently drop
  }
  dirty = false
}

// ─── Accessors ───────────────────────────────────────────────────────

export function getLastSessionId(): string | null {
  return load().lastSessionId
}

export function setLastSessionId(id: string | null) {
  const state = load()
  if (state.lastSessionId === id) return
  state.lastSessionId = id
  scheduleFlush()
}

export function getSessionTab(sessionId: string): string | null {
  return load().tabPerSession[sessionId] ?? null
}

export function setSessionTab(sessionId: string, tab: string) {
  const state = load()
  if (state.tabPerSession[sessionId] === tab) return
  state.tabPerSession[sessionId] = tab
  // Prune if over limit -- keep the most recently written entries
  const keys = Object.keys(state.tabPerSession)
  if (keys.length > MAX_TAB_ENTRIES) {
    const pruned: Record<string, string> = {}
    for (const k of keys.slice(-PRUNE_TO)) {
      pruned[k] = state.tabPerSession[k]
    }
    state.tabPerSession = pruned
  }
  scheduleFlush()
}

// ─── Lifecycle ───────────────────────────────────────────────────────

/** Call once at app startup to register the beforeunload flush. */
export function initUIState() {
  // Warm the cache
  load()
  window.addEventListener('beforeunload', flush)
}
