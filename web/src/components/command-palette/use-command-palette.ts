import { Fzf } from 'fzf'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { openSpawnDialog } from '@/components/spawn-dialog'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { FileInfo } from '@/hooks/use-file-editor'
import { useProject } from '@/hooks/use-project'
import { formatShortcut, getCommandGeneration, getCommands } from '@/lib/commands'
import { getFrequencyMap, recordSwitch } from '@/lib/conversation-frequency'
import { scoreAndSortTasks } from '@/lib/task-scoring'
import { projectPath, type Session } from '@/lib/types'
import type { PaletteMode } from './types'

export function useCommandPalette(onClose: () => void) {
  const sessions = useConversationsStore(state => state.sessions)
  const sessionsById = useConversationsStore(state => state.sessionsById)
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const sessionMru = useConversationsStore(state => state.sessionMru)
  const projectSettings = useConversationsStore(state => state.projectSettings)
  const sendWsMessage = useConversationsStore(state => state.sendWsMessage)
  const sentinelConnected = useConversationsStore(state => state.sentinelConnected)

  const switcherInitialFilter = useConversationsStore(state => state.switcherInitialFilter)
  const [filter, setFilter] = useState(switcherInitialFilter)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Apply initial filter when switcher opens with a prefilled value
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - runs once on mount to consume the initial filter; switcherInitialFilter read from closure at mount time
  useEffect(() => {
    if (switcherInitialFilter) {
      setFilter(switcherInitialFilter)
      useConversationsStore.getState().openSwitcherWithFilter('')
    }
  }, [])

  // Mode detection
  const isCommandMode = filter.startsWith('>')
  const isFileMode = !isCommandMode && filter.toLowerCase().startsWith('f:') && !filter.toLowerCase().startsWith('f:/')
  const isSpawnMode = !isCommandMode && filter.toLowerCase().startsWith('s:')
  // Tasks: "@" (VSCode-style) or legacy "t:"
  const isTaskMode = !isCommandMode && (filter.startsWith('@') || filter.toLowerCase().startsWith('t:'))

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
  const registryCommands = useMemo(() => {
    const raw = getCommands().map(c => ({
      id: c.id,
      label: c.label,
      shortcut: c.shortcut ? formatShortcut(c.shortcut) : undefined,
      action: (...args: string[]) => {
        c.action(...args)
        onClose()
      },
    }))
    // Deduplicate by label, merging shortcuts into a list
    const byLabel = new Map<string, (typeof raw)[0] & { shortcuts?: string[] }>()
    for (const cmd of raw) {
      const existing = byLabel.get(cmd.label)
      if (existing) {
        const shortcuts = existing.shortcuts ?? (existing.shortcut ? [existing.shortcut] : [])
        if (cmd.shortcut) shortcuts.push(cmd.shortcut)
        existing.shortcuts = shortcuts
      } else {
        byLabel.set(cmd.label, cmd)
      }
    }
    return Array.from(byLabel.values())
  }, [_gen, onClose])
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
  const activeProjects = new Set(sessions.filter(s => s.status !== 'ended').map(s => s.project))
  const deduplicated = sessions.filter(s => s.status !== 'ended' || !activeProjects.has(s.project))
  const mruIndex = new Map(sessionMru.map((id, i) => [id, i]))
  const freqMap = useMemo(() => getFrequencyMap(), [])
  const allConversations = [...deduplicated].sort((a, b) => {
    const ai = mruIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const bi = mruIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER
    // Top 2 MRU spots are sacred (alt-tab behavior)
    const aTop = ai < 2
    const bTop = bi < 2
    if (aTop !== bTop) return aTop ? -1 : 1
    if (aTop && bTop) return ai - bi
    // Rest sorted by frequency (descending), then recency as tiebreaker
    const af = freqMap[a.project]?.count || 0
    const bf = freqMap[b.project]?.count || 0
    if (af !== bf) return bf - af
    return b.lastActivity - a.lastActivity
  })

  const sessionFzf = useMemo(
    () =>
      new Fzf(allConversations, {
        selector: (s: Session) => {
          const ps = projectSettings[s.project]
          return `${projectPath(s.project)} ${ps?.label || ''} ${s.title || ''} ${s.agentName || ''} ${s.id} ${s.model || ''} ${s.status}`
        },
        casing: 'case-insensitive',
      }),
    [allConversations, projectSettings],
  )
  // Fzf over commands for the merged-into-sessions result list (no prefix).
  const paletteCommandFzf = useMemo(
    () => new Fzf(registryCommands, { selector: c => `${c.label} ${c.id}`, casing: 'case-insensitive' }),
    [registryCommands],
  )
  const isConversationMode = !isFileMode && !isSpawnMode && !isCommandMode && !isTaskMode

  // Unified fuzzy results for session mode: sessions + commands-at-low-score.
  // Sessions are the primary surface, commands appear below for matching filter text.
  const sessionSearchResults = useMemo(() => {
    if (!isConversationMode || !filter) return []
    return sessionFzf.find(filter).map(r => ({
      kind: 'session' as const,
      session: r.item,
      score: r.score,
      live: r.item.status !== 'ended',
    }))
  }, [isConversationMode, filter, sessionFzf])

  const commandSearchResults = useMemo(() => {
    if (!isConversationMode || !filter) return []
    // Penalty keeps commands below equally-scored sessions ("low score")
    const COMMAND_SCORE_PENALTY = 0.5
    return paletteCommandFzf.find(filter).map(r => ({
      kind: 'command' as const,
      command: r.item,
      score: r.score * COMMAND_SCORE_PENALTY,
      live: false,
    }))
  }, [isConversationMode, filter, paletteCommandFzf])

  type MergedItem =
    | { kind: 'session'; session: Session; score: number; live: boolean }
    | { kind: 'command'; command: (typeof registryCommands)[0]; score: number; live: boolean }

  const mergedItems: MergedItem[] = useMemo(() => {
    if (!isConversationMode) return []
    if (!filter) {
      return allConversations
        .filter(s => s.status !== 'ended' && s.id !== selectedConversationId)
        .map(s => ({ kind: 'session' as const, session: s, score: 0, live: true }))
    }
    const merged: MergedItem[] = [...sessionSearchResults, ...commandSearchResults]
    merged.sort((a, b) => {
      // Live sessions always above everything else (ended conversations + commands)
      if (a.live !== b.live) return a.live ? -1 : 1
      return b.score - a.score
    })
    return merged
  }, [isConversationMode, filter, allConversations, selectedConversationId, sessionSearchResults, commandSearchResults])

  // Preserved for consumers that only want the conversation subset (footer hints etc.)
  const filteredSessions = useMemo(
    () =>
      mergedItems
        .filter((i): i is Extract<MergedItem, { kind: 'session' }> => i.kind === 'session')
        .map(i => i.session),
    [mergedItems],
  )

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
    if (!selectedConversationId) return
    const session = selectedConversationId ? sessionsById[selectedConversationId] : undefined
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

    const ws = useConversationsStore.getState().ws
    if (ws) {
      ws.addEventListener('message', handler)
      sendWsMessage({ type: 'file_list_request', conversationId: selectedConversationId, requestId })
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
  }, [isFileMode, selectedConversationId, sessions, sendWsMessage])

  // Reset file state when leaving file mode
  useEffect(() => {
    if (!isFileMode) {
      filesFetched.current = false
      setFiles([])
    }
  }, [isFileMode])

  // --- Spawn mode ---
  const spawnRawInput = isSpawnMode ? filter.slice(2).trim() : ''
  const [spawnDirs, setSpawnDirs] = useState<string[]>([])
  const [spawnLoading, setSpawnLoading] = useState(false)
  const [spawnError, setSpawnError] = useState<string | null>(null)
  const spawning = false // spawn now handled by SpawnDialog
  const spawnFetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Parse @alias prefix from spawn input
  const spawnParsed = useMemo(() => {
    const input = spawnRawInput
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
  }, [spawnRawInput])

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
    openSpawnDialog({ cwd: path, mkdir, sentinel: spawnSentinel })
  }

  // --- Task mode ---
  // Strip either "@" (1 char) or "t:" / "T:" (2 chars)
  const taskFilter = isTaskMode
    ? filter.startsWith('@')
      ? filter.slice(1).trim().toLowerCase()
      : filter.slice(2).trim().toLowerCase()
    : ''
  const { tasks: projectTasks, loading: tasksLoading } = useProject(isTaskMode ? selectedConversationId : null)

  const filteredTasks = useMemo(() => scoreAndSortTasks(projectTasks, taskFilter), [projectTasks, taskFilter])

  // --- Item count & index clamping ---
  const itemCount = isCommandMode
    ? filteredCommands.length
    : isSpawnMode
      ? filteredSpawnDirs.length
      : isFileMode
        ? filteredFiles.length
        : isTaskMode
          ? filteredTasks.length
          : mergedItems.length

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
  function selectConversationWithTracking(session: Session, onSelectConversation: (id: string) => void) {
    recordSwitch(session.project)
    onSelectConversation(session.id)
  }

  // --- Keyboard handler ---
  function handleKeyDown(
    e: React.KeyboardEvent,
    callbacks: {
      onSelectConversation: (id: string) => void
      onFileSelect: (conversationId: string, path: string) => void
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
          if (file && selectedConversationId) {
            callbacks.onFileSelect(selectedConversationId, file.path)
          }
        } else if (isTaskMode) {
          const task = filteredTasks[activeIndex]
          if (task) {
            useConversationsStore.getState().setPendingTaskEdit({ slug: task.slug, status: task.status })
            onClose()
          }
        } else {
          const item = mergedItems[activeIndex]
          if (item?.kind === 'session') {
            selectConversationWithTracking(item.session, callbacks.onSelectConversation)
          } else if (item?.kind === 'command') {
            item.command.action()
          }
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
    mergedItems,
    allConversations,
    selectedConversationId,
    projectSettings,
    sentinelConnected,

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
    selectConversationWithTracking,
  }
}
