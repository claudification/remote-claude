import { Fzf } from 'fzf'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileInfo } from '@/hooks/use-file-editor'
import { useSessionsStore } from '@/hooks/use-sessions'
import type { Session } from '@/lib/types'
import { getPaletteCommands } from './commands'
import type { PaletteMode } from './types'

export function useCommandPalette(onClose: () => void) {
  const sessions = useSessionsStore(state => state.sessions)
  const selectedSessionId = useSessionsStore(state => state.selectedSessionId)
  const projectSettings = useSessionsStore(state => state.projectSettings)
  const sendWsMessage = useSessionsStore(state => state.sendWsMessage)
  const agentConnected = useSessionsStore(state => state.agentConnected)

  const [filter, setFilter] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Mode detection
  const isCommandMode = filter.startsWith('>')
  const isFileMode = !isCommandMode && filter.toLowerCase().startsWith('f:') && !filter.toLowerCase().startsWith('f:/')
  const isSpawnMode = !isCommandMode && filter.toLowerCase().startsWith('s:')

  const mode: PaletteMode = isCommandMode ? 'command' : isSpawnMode ? 'spawn' : isFileMode ? 'file' : 'session'

  // --- Command mode ---
  const commandFilter = isCommandMode ? filter.slice(1).trim().toLowerCase() : ''
  const commands = useMemo(() => getPaletteCommands(onClose), [onClose])
  const filteredCommands = isCommandMode ? commands.filter(c => c.label.toLowerCase().includes(commandFilter)) : []

  // --- Session mode ---
  const activeCwds = new Set(sessions.filter(s => s.status !== 'ended').map(s => s.cwd))
  const deduplicated = sessions.filter(s => s.status !== 'ended' || !activeCwds.has(s.cwd))
  const allSessions = [...deduplicated].sort((a, b) => b.startedAt - a.startedAt)

  const sessionFzf = useMemo(
    () =>
      new Fzf(allSessions, {
        selector: (s: Session) => {
          const ps = projectSettings[s.cwd]
          return `${s.cwd} ${ps?.label || ''} ${s.id} ${s.model || ''} ${s.status}`
        },
      }),
    [allSessions, projectSettings],
  )
  const filteredSessions =
    filter && !isFileMode && !isSpawnMode && !isCommandMode ? sessionFzf.find(filter).map(r => r.item) : allSessions

  // --- File mode ---
  const fileFilter = isFileMode ? filter.slice(2).trim().toLowerCase() : ''
  const [files, setFiles] = useState<FileInfo[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const filesFetched = useRef(false)

  const fileFzf = useMemo(() => new Fzf(files, { selector: (f: FileInfo) => `${f.name} ${f.path}` }), [files])
  const filteredFiles = fileFilter ? fileFzf.find(fileFilter).map(r => r.item) : files

  // Fetch file list when entering file mode
  useEffect(() => {
    if (!isFileMode || filesFetched.current) return
    if (!selectedSessionId) return
    const session = sessions.find(s => s.id === selectedSessionId)
    if (!session || (session.status !== 'active' && session.status !== 'idle')) return

    filesFetched.current = true
    setFilesLoading(true)

    const requestId = crypto.randomUUID()
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.requestId === requestId && msg.type === 'file_list_response') {
          setFiles(msg.files || [])
          setFilesLoading(false)
        }
      } catch {}
    }

    const ws = useSessionsStore.getState().ws
    if (ws) {
      ws.addEventListener('message', handler)
      sendWsMessage({ type: 'file_list_request', sessionId: selectedSessionId, requestId })
      const timeout = setTimeout(() => {
        ws.removeEventListener('message', handler)
        setFilesLoading(false)
      }, 5000)
      return () => {
        ws.removeEventListener('message', handler)
        clearTimeout(timeout)
      }
    }
    setFilesLoading(false)
  }, [isFileMode, selectedSessionId, sessions, sendWsMessage])

  // Reset file state when leaving file mode
  useEffect(() => {
    if (!isFileMode) {
      filesFetched.current = false
      setFiles([])
    }
  }, [isFileMode])

  // --- Spawn mode ---
  const spawnPath = isSpawnMode ? filter.slice(2).trim() : ''
  const [spawnDirs, setSpawnDirs] = useState<string[]>([])
  const [spawnLoading, setSpawnLoading] = useState(false)
  const [spawnError, setSpawnError] = useState<string | null>(null)
  const [spawning, setSpawning] = useState(false)
  const spawnFetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const spawnParentDir = spawnPath.includes('/') ? spawnPath.slice(0, spawnPath.lastIndexOf('/') + 1) : '/'
  const spawnPartial = spawnPath.includes('/')
    ? spawnPath.slice(spawnPath.lastIndexOf('/') + 1).toLowerCase()
    : spawnPath.toLowerCase()

  const fetchDirs = useCallback(
    (dirPath: string) => {
      if (!agentConnected) return
      setSpawnLoading(true)
      setSpawnError(null)
      fetch(`/api/dirs?path=${encodeURIComponent(dirPath)}`)
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
    [agentConnected],
  )

  useEffect(() => {
    if (!isSpawnMode) {
      setSpawnDirs([])
      setSpawnError(null)
      return
    }
    if (spawnFetchTimer.current) clearTimeout(spawnFetchTimer.current)
    spawnFetchTimer.current = setTimeout(() => fetchDirs(spawnParentDir), 200)
    return () => {
      if (spawnFetchTimer.current) clearTimeout(spawnFetchTimer.current)
    }
  }, [isSpawnMode, spawnParentDir, fetchDirs])

  const filteredSpawnDirs = spawnPartial ? spawnDirs.filter(d => d.toLowerCase().startsWith(spawnPartial)) : spawnDirs

  async function handleSpawn(cwd: string) {
    if (spawning || !cwd) return
    setSpawning(true)
    setSpawnError(null)
    try {
      const res = await fetch('/api/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd }),
      })
      const data = await res.json()
      if (data.success) {
        onClose()
      } else {
        setSpawnError(data.error || 'Spawn failed')
      }
    } catch (err: any) {
      setSpawnError(err.message || 'Network error')
    } finally {
      setSpawning(false)
    }
  }

  // --- Item count & index clamping ---
  const itemCount = isCommandMode
    ? filteredCommands.length
    : isSpawnMode
      ? filteredSpawnDirs.length
      : isFileMode
        ? filteredFiles.length
        : filteredSessions.length

  useEffect(() => {
    if (activeIndex >= itemCount) {
      setActiveIndex(Math.max(0, itemCount - 1))
    }
  }, [itemCount, activeIndex])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // --- Keyboard handler ---
  function handleKeyDown(
    e: React.KeyboardEvent,
    callbacks: {
      onSelectSession: (id: string) => void
      onFileSelect: (sessionId: string, path: string) => void
    },
  ) {
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        if (isFileMode || isSpawnMode || isCommandMode) {
          setFilter('')
          setActiveIndex(0)
        } else {
          onClose()
        }
        break
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex(i => Math.min(i + 1, itemCount - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex(i => Math.max(i - 1, 0))
        break
      case 'Tab':
        if (isSpawnMode && filteredSpawnDirs.length > 0) {
          e.preventDefault()
          const selected = filteredSpawnDirs[activeIndex]
          if (selected) {
            setFilter(`S:${spawnParentDir}${selected}/`)
            setActiveIndex(0)
          }
        }
        break
      case 'Enter':
        e.preventDefault()
        if (isCommandMode) {
          const cmd = filteredCommands[activeIndex]
          if (cmd) cmd.action()
        } else if (isSpawnMode) {
          if (filteredSpawnDirs.length > 0 && !spawnPath.endsWith('/')) {
            const selected = filteredSpawnDirs[activeIndex]
            if (selected) {
              setFilter(`S:${spawnParentDir}${selected}/`)
              setActiveIndex(0)
            }
          } else if (spawnPath) {
            handleSpawn(spawnPath.endsWith('/') ? spawnPath.slice(0, -1) : spawnPath)
          }
        } else if (isFileMode) {
          const file = filteredFiles[activeIndex]
          if (file && selectedSessionId) {
            callbacks.onFileSelect(selectedSessionId, file.path)
          }
        } else if (filteredSessions[activeIndex]) {
          callbacks.onSelectSession(filteredSessions[activeIndex].id)
        }
        break
    }
  }

  function handleDirSelect(dir: string) {
    setFilter(`S:${spawnParentDir}${dir}/`)
    setActiveIndex(0)
    inputRef.current?.focus()
  }

  return {
    // State
    filter,
    setFilter,
    activeIndex,
    setActiveIndex,
    inputRef,
    mode,

    // Store data
    sessions: filteredSessions,
    allSessions,
    selectedSessionId,
    projectSettings,
    agentConnected,

    // Command mode
    filteredCommands,

    // File mode
    filteredFiles,
    filesLoading,

    // Spawn mode
    filteredSpawnDirs,
    spawnPath,
    spawnParentDir,
    spawnLoading,
    spawnError,
    spawning,

    // Actions
    handleKeyDown,
    handleSpawn,
    handleDirSelect,
  }
}
