import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { openSpawnDialog } from '@/components/spawn-dialog'
import { type SentinelStatusInfo, useConversationsStore } from '@/hooks/use-conversations'

/** Default sentinel name (mirrors src/shared/project-uri.ts DEFAULT_SENTINEL_NAME).
 *  Used as the implicit authority when no `@sentinel` token is given. */
const DEFAULT_SENTINEL = 'default'

export interface SentinelSuggestion {
  alias: string
  connected: boolean
  isDefault: boolean
}

export interface SpawnModeState {
  spawnPath: string
  spawnParentDir: string
  spawnSentinel: string
  filteredSpawnDirs: string[]
  filteredSentinels: SentinelSuggestion[]
  isSentinelEntry: boolean
  spawnLoading: boolean
  spawnError: string | null
  spawning: boolean
  canCreateDir: boolean
  handleSpawn: (path: string, mkdir?: boolean) => void
  handleDirSelect: (dir: string) => void
  handleSentinelSelect: (alias: string) => void
}

interface UseSpawnModeArgs {
  filter: string
  isSpawnMode: boolean
  sentinelConnected: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
  setFilter: (value: string) => void
  setActiveIndex: (value: number) => void
  onClose: () => void
}

/**
 * Spawn-mode (`s:` prefix) derivations. Parses the optional `@sentinel`
 * authority + path, debounces directory listings via the broker's `/api/dirs`
 * endpoint, and exposes the Tab/Enter completion targets. While the user is
 * still typing the `@sentinel` token (no space yet), the hook skips the dir
 * fetch and exposes a sentinel suggestion list with the default sentinel
 * first. `handleSpawn` defers to the spawn dialog -- this hook does not
 * actually launch conversations.
 */
export function useSpawnMode({
  filter,
  isSpawnMode,
  sentinelConnected,
  inputRef,
  setFilter,
  setActiveIndex,
  onClose,
}: UseSpawnModeArgs): SpawnModeState {
  const spawnRawInput = isSpawnMode ? filter.slice(2).trim() : ''
  const [spawnDirs, setSpawnDirs] = useState<string[]>([])
  const [spawnLoading, setSpawnLoading] = useState(false)
  const [spawnError, setSpawnError] = useState<string | null>(null)
  const spawning = false // spawn now handled by SpawnDialog
  const spawnFetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sentinels = useConversationsStore(s => s.sentinels)

  const spawnParsed = useMemo(() => parseSpawnInput(spawnRawInput), [spawnRawInput])
  const spawnPath = spawnParsed.path
  // Always resolve to a concrete sentinel name. No `@` token => 'default'.
  const spawnSentinel = spawnParsed.sentinel || DEFAULT_SENTINEL
  // Sentinel-entry mode: input has a leading `@` token but no space yet, so
  // the user is still typing the sentinel alias. Show suggestions instead of
  // calling /api/dirs (which would 503 on partial alias names).
  const isSentinelEntry = isSpawnMode && spawnRawInput.startsWith('@') && !spawnRawInput.includes(' ')
  const sentinelTypedPrefix = isSentinelEntry ? spawnRawInput.slice(1).toLowerCase() : ''

  const spawnParentDir = spawnPath.includes('/') ? spawnPath.slice(0, spawnPath.lastIndexOf('/') + 1) : '/'
  const spawnPartial = spawnPath.includes('/')
    ? spawnPath.slice(spawnPath.lastIndexOf('/') + 1).toLowerCase()
    : spawnPath.toLowerCase()

  const fetchDirs = useCallback(
    (dirPath: string, sentinel?: string) => {
      if (!sentinelConnected) return
      setSpawnLoading(true)
      setSpawnError(null)
      const params = new URLSearchParams({ path: dirPath })
      if (sentinel) params.set('sentinel', sentinel)
      fetch(`/api/dirs?${params}`)
        .then(r => r.json())
        .then(data => {
          setSpawnDirs(data.dirs || [])
          setSpawnError(data.error || null)
          setSpawnLoading(false)
        })
        .catch(err => {
          setSpawnError(err.message)
          setSpawnLoading(false)
        })
    },
    [sentinelConnected],
  )

  useEffect(() => {
    if (!isSpawnMode || isSentinelEntry) {
      setSpawnDirs([])
      setSpawnError(null)
      return
    }
    if (spawnFetchTimer.current) clearTimeout(spawnFetchTimer.current)
    spawnFetchTimer.current = setTimeout(() => fetchDirs(spawnParentDir, spawnSentinel), 200)
    return () => {
      if (spawnFetchTimer.current) clearTimeout(spawnFetchTimer.current)
    }
  }, [isSpawnMode, isSentinelEntry, spawnParentDir, spawnSentinel, fetchDirs])

  const filteredSpawnDirs = spawnPartial ? spawnDirs.filter(d => d.toLowerCase().startsWith(spawnPartial)) : spawnDirs
  const canCreateDir =
    isSpawnMode && !isSentinelEntry && spawnPartial.length > 0 && filteredSpawnDirs.length === 0 && !spawnLoading

  const filteredSentinels = useMemo<SentinelSuggestion[]>(() => {
    if (!isSentinelEntry) return []
    return buildSentinelSuggestions(sentinels, sentinelTypedPrefix)
  }, [isSentinelEntry, sentinels, sentinelTypedPrefix])

  function handleSpawn(path: string, mkdir = false) {
    if (spawning || !path) return
    onClose()
    openSpawnDialog({ path, mkdir, sentinel: spawnSentinel })
  }

  function handleDirSelect(dir: string) {
    const prefix = sentinelPrefixFor(spawnRawInput)
    setFilter(`S:${prefix}${spawnParentDir}${dir}/`)
    setActiveIndex(0)
    inputRef.current?.focus()
  }

  function handleSentinelSelect(alias: string) {
    setFilter(`S:@${alias} `)
    setActiveIndex(0)
    inputRef.current?.focus()
  }

  return {
    spawnPath,
    spawnParentDir,
    spawnSentinel,
    filteredSpawnDirs,
    filteredSentinels,
    isSentinelEntry,
    spawnLoading,
    spawnError,
    spawning,
    canCreateDir,
    handleSpawn,
    handleDirSelect,
    handleSentinelSelect,
  }
}

interface SpawnInput {
  sentinel?: string
  path: string
}

function parseSpawnInput(input: string): SpawnInput {
  if (input.startsWith('claude://')) {
    try {
      const url = new URL(input)
      return { sentinel: url.hostname || undefined, path: url.pathname }
    } catch {
      return { path: input }
    }
  }
  if (input.startsWith('@')) {
    // Only the LEADING @token is treated as a sentinel; subsequent `@`
    // characters are part of the path. Naturally enforces a single sentinel
    // per spawn line.
    const spaceIdx = input.indexOf(' ')
    if (spaceIdx === -1) return { sentinel: input.slice(1), path: '' }
    return { sentinel: input.slice(1, spaceIdx), path: input.slice(spaceIdx + 1) }
  }
  return { path: input }
}

/** Returns the verbatim leading `@sentinel ` portion (including trailing
 *  space) so dir selection preserves the user's sentinel choice when the
 *  filter string is rebuilt. */
function sentinelPrefixFor(rawInput: string): string {
  if (!rawInput.startsWith('@')) return ''
  const spaceIdx = rawInput.indexOf(' ')
  if (spaceIdx === -1) return ''
  return rawInput.slice(0, spaceIdx + 1)
}

/** Build sentinel suggestion list. Default sentinel (whichever has
 *  `isDefault: true`, or the literal alias `default` as a fallback) is
 *  always first. Filtered by alias prefix (case-insensitive). */
function buildSentinelSuggestions(sentinels: SentinelStatusInfo[], prefix: string): SentinelSuggestion[] {
  const seen = new Set<string>()
  const out: SentinelSuggestion[] = []

  function push(s: SentinelSuggestion) {
    const key = s.alias.toLowerCase()
    if (seen.has(key)) return
    if (prefix && !key.startsWith(prefix)) return
    seen.add(key)
    out.push(s)
  }

  const defaultEntry = sentinels.find(s => s.isDefault) || sentinels.find(s => s.alias === DEFAULT_SENTINEL)
  if (defaultEntry) {
    push({ alias: defaultEntry.alias, connected: defaultEntry.connected, isDefault: true })
  } else {
    push({ alias: DEFAULT_SENTINEL, connected: sentinels.some(s => s.connected), isDefault: true })
  }

  for (const s of sentinels) {
    if (s.isDefault) continue
    push({ alias: s.alias, connected: s.connected, isDefault: false })
  }

  return out
}
