/**
 * Session frequency tracker - persisted in localStorage.
 *
 * Tracks how often each project (by project URI) is switched to via the command palette.
 * Used to sort the switcher list by frequency + recency (alt-tab style).
 */

const STORAGE_KEY = 'session-switch-frequency'
const MAX_ENTRIES = 200

interface FrequencyEntry {
  count: number
  lastUsed: number // timestamp
}

type FrequencyMap = Record<string, FrequencyEntry>

function load(): FrequencyMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function save(map: FrequencyMap) {
  // Prune old entries if over limit
  const entries = Object.entries(map)
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b[1].lastUsed - a[1].lastUsed)
    const pruned = Object.fromEntries(entries.slice(0, MAX_ENTRIES))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned))
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  }
}

/** Record a switch to a conversation (by project URI). Call when user selects via switcher. */
export function recordSwitch(project: string) {
  const map = load()
  const entry = map[project] || { count: 0, lastUsed: 0 }
  entry.count++
  entry.lastUsed = Date.now()
  map[project] = entry
  save(map)
}

/** Get all frequency data (for sorting). Cached per call to avoid repeated localStorage reads. */
export function getFrequencyMap(): FrequencyMap {
  return load()
}
