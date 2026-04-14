import { Fzf } from 'fzf'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { openSpawnDialog } from '@/components/spawn-dialog'
import type { FileInfo } from '@/hooks/use-file-editor'
import { useSessionsStore } from '@/hooks/use-sessions'
import { formatShortcut, getCommandGeneration, getCommands } from '@/lib/commands'
import { getFrequencyMap, recordSwitch } from '@/lib/session-frequency'
import type { Session } from '@/lib/types'
import type { PaletteMode, TaskItem } from './types'

export function useCommandPalette(onClose: () => void) {
  const sessions = useSessionsStore(state => state.sessions)
  const selectedSessionId = useSessionsStore(state => state.selectedSessionId)
  const sessionMru = useSessionsStore(state => state.sessionMru)
  const projectSettings = useSessionsStore(state => state.projectSettings)
  const sendWsMessage = useSessionsStore(state => state.sendWsMessage)
  const agentConnected = useSessionsStore(state => state.agentConnected)

  const switcherInitialFilter = useSessionsStore(state => state.switcherInitialFilter)
  const [filter, setFilter] = useState(switcherInitialFilter)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Apply initial filter when switcher opens with a prefilled value
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - runs once on mount to consume the initial filter; switcherInitialFilter read from closure at mount time
  useEffect(() => {
    if (switcherInitialFilter) {
      setFilter(switcherInitialFilter)
      useSessionsStore.getState().openSwitcherWithFilter('')
    }
  }, [])

  // Mode detection
  const isCommandMode = filter.startsWith('>')
  const isFileMode = !isCommandMode && filter.toLowerCase().startsWith('f:') && !filter.toLowerCase().startsWith('f:/')
  const isSpawnMode = !isCommandMode && filter.toLowerCase().startsWith('s:')
  const isTaskMode = !isCommandMode && filter.toLowerCase().startsWith('t:')

  const mode: PaletteMode = isCommandMode
    ? 'command'
    : isSpawnMode
      ? 'spawn'
      : isFileMode
        ? 'file'
        : isTaskMode
          ? 'task'
          : 'session'

  // --- Command mode ---
  // Parse: "> effort high" -> commandSearch="effort high", commandArgs parsed on execute
  const commandRaw = isCommandMode ? filter.slice(1).trim() : ''
  const commandSearch = commandRaw.toLowerCase()
  const _gen = getCommandGeneration()
  // biome-ignore lint/correctness/useExhaustiveDependencies: _gen is a generation counter dep key that invalidates memoized command list when registry changes
  const registryCommands = useMemo(
    () =>
      getCommands().map(c => ({
        id: c.id,
        label: c.label,
        shortcut: c.shortcut ? formatShortcut(c.shortcut) : undefined,
        action: (...args: string[]) => {
          c.action(...args)
          onClose()
        },
      })),
    [_gen, onClose],
  )
  // Match by label or id, parse args from remainder
  const filteredCommands = isCommandMode
    ? registryCommands.filter(c => {
        const id = c.id.toLowerCase()
        const label = c.label.toLowerCase()
        // "effort high" matches command "effort" -- the "high" part is an arg
        return label.includes(commandSearch) || id.includes(commandSearch) || commandSearch.startsWith(id)
      })
    : []

  // Extract args: if filter is "> effort high", and selected command is "effort", args = ["high"]
  function getCommandArgs(cmd: (typeof registryCommands)[0]): string[] {
    const parts = commandRaw.split(/\s+/)
    const idLower = cmd.id.toLowerCase()
    if (parts[0]?.toLowerCase() === idLower && parts.length > 1) {
      return parts.slice(1)
    }
    return []
  }

  // --- Session mode ---
  // Sort by: MRU top 2 (alt-tab), then frequency-weighted for the rest
  const activeCwds = new Set(sessions.filter(s => s.status !== 'ended').map(s => s.cwd))
  const deduplicated = sessions.filter(s => s.status !== 'ended' || !activeCwds.has(s.cwd))
  const mruIndex = new Map(sessionMru.map((id, i) => [id, i]))
  const freqMap = useMemo(() => getFrequencyMap(), [])
  const allSessions = [...deduplicated].sort((a, b) => {
    const ai = mruIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const bi = mruIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER
    // Top 2 MRU spots are sacred (alt-tab behavior)
    const aTop = ai < 2
    const bTop = bi < 2
    if (aTop !== bTop) return aTop ? -1 : 1
    if (aTop && bTop) return ai - bi
    // Rest sorted by frequency (descending), then recency as tiebreaker
    const af = freqMap[a.cwd]?.count || 0
    const bf = freqMap[b.cwd]?.count || 0
    if (af !== bf) return bf - af
    return b.lastActivity - a.lastActivity
  })

  const sessionFzf = useMemo(
    () =>
      new Fzf(allSessions, {
        selector: (s: Session) => {
          const ps = projectSettings[s.cwd]
          return `${s.cwd} ${ps?.label || ''} ${s.title || ''} ${s.agentName || ''} ${s.id} ${s.model || ''} ${s.status}`
        },
        casing: 'case-insensitive',
      }),
    [allSessions, projectSettings],
  )
  const filteredSessions =
    filter && !isFileMode && !isSpawnMode && !isCommandMode
      ? sessionFzf
          .find(filter)
          .sort((a, b) => {
            const aLive = a.item.status !== 'ended' ? 1 : 0
            const bLive = b.item.status !== 'ended' ? 1 : 0
            return bLive - aLive // active/idle first, fzf order preserved within tier
          })
          .map(r => r.item)
      : allSessions.filter(s => s.status !== 'ended' && s.id !== selectedSessionId)

  // --- File mode ---
  const fileFilter = isFileMode ? filter.slice(2).trim().toLowerCase() : ''
  const [files, setFiles] = useState<FileInfo[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const filesFetched = useRef(false)

  const fileFzf = useMemo(
    () => new Fzf(files, { selector: (f: FileInfo) => `${f.name} ${f.path}`, casing: 'case-insensitive' }),
    [files],
  )
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
  const spawning = false // spawn now handled by SpawnDialog
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
  // Show "create & spawn" when the typed path doesn't match any existing directory
  const canCreateDir = isSpawnMode && spawnPartial.length > 0 && filteredSpawnDirs.length === 0 && !spawnLoading

  function handleSpawn(cwd: string, mkdir = false) {
    if (spawning || !cwd) return
    onClose()
    openSpawnDialog({ cwd, mkdir })
  }

  // --- Task mode ---
  const taskFilter = isTaskMode ? filter.slice(2).trim().toLowerCase() : ''
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [tasksLoading, setTasksLoading] = useState(false)
  const tasksFetched = useRef(false)

  useEffect(() => {
    if (isTaskMode && !tasksFetched.current && selectedSessionId) {
      tasksFetched.current = true
      setTasksLoading(true)
      const requestId = crypto.randomUUID()
      const handler = (msg: Record<string, unknown>) => {
        if (msg.requestId === requestId && msg.type === 'project_list_response') {
          const notes = (msg.notes as TaskItem[]) || []
          setTasks(notes)
          setTasksLoading(false)
          useSessionsStore.setState({ projectHandler: prev })
        }
      }
      const prev = useSessionsStore.getState().projectHandler
      useSessionsStore.setState({ projectHandler: handler })
      sendWsMessage({ type: 'project_list', requestId, sessionId: selectedSessionId })
    }
    if (!isTaskMode) {
      tasksFetched.current = false
      setTasks([])
    }
  }, [isTaskMode, selectedSessionId, sendWsMessage])

  const taskFzf = useMemo(
    () =>
      new Fzf(tasks, {
        selector: (t: TaskItem) => `${t.title} ${t.slug} ${t.status} ${t.priority || ''}`,
        casing: 'case-insensitive',
      }),
    [tasks],
  )
  const statusBoost = (status: string) => (status === 'in-progress' ? 1.5 : status === 'open' ? 1.3 : 1)
  const filteredTasks = taskFilter
    ? taskFzf
        .find(taskFilter)
        .sort((a, b) => b.score * statusBoost(b.item.status) - a.score * statusBoost(a.item.status))
        .map(r => r.item)
    : // Default order: in-progress first, then open, then rest
      [...tasks].sort((a, b) => statusBoost(b.status) - statusBoost(a.status))

  // --- Item count & index clamping ---
  const itemCount = isCommandMode
    ? filteredCommands.length
    : isSpawnMode
      ? filteredSpawnDirs.length
      : isFileMode
        ? filteredFiles.length
        : isTaskMode
          ? filteredTasks.length
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

  // Track frequency when selecting via switcher (keyboard or click)
  function selectSessionWithTracking(session: Session, onSelectSession: (id: string) => void) {
    recordSwitch(session.cwd)
    onSelectSession(session.id)
  }

  // --- Keyboard handler ---
  function handleKeyDown(
    e: React.KeyboardEvent,
    callbacks: {
      onSelectSession: (id: string) => void
      onFileSelect: (sessionId: string, path: string) => void
    },
  ) {
    switch (e.key) {
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
          if (cmd) cmd.action(...getCommandArgs(cmd))
        } else if (isSpawnMode) {
          if (filteredSpawnDirs.length > 0 && !spawnPath.endsWith('/')) {
            const selected = filteredSpawnDirs[activeIndex]
            if (selected) {
              setFilter(`S:${spawnParentDir}${selected}/`)
              setActiveIndex(0)
            }
          } else if (spawnPath) {
            const cleanPath = spawnPath.endsWith('/') ? spawnPath.slice(0, -1) : spawnPath
            handleSpawn(cleanPath, canCreateDir)
          }
        } else if (isFileMode) {
          const file = filteredFiles[activeIndex]
          if (file && selectedSessionId) {
            callbacks.onFileSelect(selectedSessionId, file.path)
          }
        } else if (isTaskMode) {
          const task = filteredTasks[activeIndex]
          if (task) {
            useSessionsStore.getState().setPendingTaskEdit({ slug: task.slug, status: task.status })
            onClose()
          }
        } else if (filteredSessions[activeIndex]) {
          selectSessionWithTracking(filteredSessions[activeIndex], callbacks.onSelectSession)
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
    canCreateDir,

    // Task mode
    filteredTasks,
    tasksLoading,

    // Actions
    handleKeyDown,
    handleSpawn,
    handleDirSelect,
    selectSessionWithTracking,
  }
}
