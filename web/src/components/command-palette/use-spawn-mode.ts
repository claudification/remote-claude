import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { openSpawnDialog } from '@/components/spawn-dialog'

export interface SpawnModeState {
  spawnPath: string
  spawnParentDir: string
  filteredSpawnDirs: string[]
  spawnLoading: boolean
  spawnError: string | null
  spawning: boolean
  canCreateDir: boolean
  handleSpawn: (path: string, mkdir?: boolean) => void
  handleDirSelect: (dir: string) => void
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
 * endpoint, and exposes the Tab/Enter completion targets. `handleSpawn`
 * defers to the spawn dialog -- this hook does not actually launch sessions.
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

  const spawnParsed = useMemo(() => parseSpawnInput(spawnRawInput), [spawnRawInput])
  const spawnPath = spawnParsed.path
  const spawnSentinel = spawnParsed.sentinel

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
    if (!isSpawnMode) {
      setSpawnDirs([])
      setSpawnError(null)
      return
    }
    if (spawnFetchTimer.current) clearTimeout(spawnFetchTimer.current)
    spawnFetchTimer.current = setTimeout(() => fetchDirs(spawnParentDir, spawnSentinel), 200)
    return () => {
      if (spawnFetchTimer.current) clearTimeout(spawnFetchTimer.current)
    }
  }, [isSpawnMode, spawnParentDir, spawnSentinel, fetchDirs])

  const filteredSpawnDirs = spawnPartial ? spawnDirs.filter(d => d.toLowerCase().startsWith(spawnPartial)) : spawnDirs
  // Show "create & spawn" when the typed path doesn't match any existing directory
  const canCreateDir = isSpawnMode && spawnPartial.length > 0 && filteredSpawnDirs.length === 0 && !spawnLoading

  function handleSpawn(path: string, mkdir = false) {
    if (spawning || !path) return
    onClose()
    openSpawnDialog({ path, mkdir, sentinel: spawnSentinel })
  }

  function handleDirSelect(dir: string) {
    setFilter(`S:${spawnParentDir}${dir}/`)
    setActiveIndex(0)
    inputRef.current?.focus()
  }

  return {
    spawnPath,
    spawnParentDir,
    filteredSpawnDirs,
    spawnLoading,
    spawnError,
    spawning,
    canCreateDir,
    handleSpawn,
    handleDirSelect,
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
    const spaceIdx = input.indexOf(' ')
    if (spaceIdx === -1) return { sentinel: input.slice(1), path: '' }
    return { sentinel: input.slice(1, spaceIdx), path: input.slice(spaceIdx + 1) }
  }
  return { path: input }
}
