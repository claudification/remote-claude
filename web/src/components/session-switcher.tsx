import { Fzf } from 'fzf'
import { FileText, FolderPlus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileInfo } from '@/hooks/use-file-editor'
import { useSessionsStore } from '@/hooks/use-sessions'
import { canTerminal, type Session } from '@/lib/types'
import { cn, formatAge, lastPathSegments } from '@/lib/utils'
import { renderProjectIcon } from './project-settings-editor'

interface PaletteCommand {
  id: string
  label: string
  shortcut?: string
  action: () => void
}

function getPaletteCommands(onClose: () => void): PaletteCommand[] {
  const store = useSessionsStore.getState()
  const session = store.sessions.find(s => s.id === store.selectedSessionId)
  return [
    {
      id: 'debug-console',
      label: 'Toggle debug console',
      shortcut: 'Ctrl+Shift+D',
      action: () => { store.toggleDebugConsole(); onClose() },
    },
    {
      id: 'verbose',
      label: 'Toggle verbose / expand all',
      shortcut: 'Ctrl+O',
      action: () => { store.toggleExpandAll(); onClose() },
    },
    {
      id: 'quick-note',
      label: 'Quick note (append to NOTES.md)',
      shortcut: 'Ctrl+Shift+N',
      action: () => { window.dispatchEvent(new Event('open-quick-note')); onClose() },
    },
    ...(session && canTerminal(session) && session.wrapperIds?.[0]
      ? [{
          id: 'terminal',
          label: 'Open terminal for current session',
          shortcut: 'Ctrl+Shift+T',
          action: () => { store.openTerminal(session.wrapperIds![0]); onClose() },
        }]
      : []),
  ]
}

interface SessionSwitcherProps {
  onSelect: (sessionId: string) => void
  onFileSelect: (sessionId: string, path: string) => void
  onClose: () => void
}

export function SessionSwitcher({ onSelect, onFileSelect, onClose }: SessionSwitcherProps) {
  const sessions = useSessionsStore(state => state.sessions)
  const selectedSessionId = useSessionsStore(state => state.selectedSessionId)
  const projectSettings = useSessionsStore(state => state.projectSettings)
  const sendWsMessage = useSessionsStore(state => state.sendWsMessage)
  const [filter, setFilter] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Command mode (> prefix, like VS Code)
  const isCommandMode = filter.startsWith('>')
  const commandFilter = isCommandMode ? filter.slice(1).trim().toLowerCase() : ''
  const commands = useMemo(() => getPaletteCommands(onClose), [onClose])
  const filteredCommands = isCommandMode
    ? commands.filter(c => c.label.toLowerCase().includes(commandFilter))
    : []

  // File picker mode
  const isFileMode = !isCommandMode && filter.toLowerCase().startsWith('f:') && !filter.toLowerCase().startsWith('f:/')
  const fileFilter = isFileMode ? filter.slice(2).trim().toLowerCase() : ''
  const [files, setFiles] = useState<FileInfo[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const filesFetched = useRef(false)

  // Spawn mode
  const agentConnected = useSessionsStore(state => state.agentConnected)
  const isSpawnMode = !isCommandMode && filter.toLowerCase().startsWith('s:')
  const spawnPath = isSpawnMode ? filter.slice(2).trim() : ''
  const [spawnDirs, setSpawnDirs] = useState<string[]>([])
  const [spawnLoading, setSpawnLoading] = useState(false)
  const [spawnError, setSpawnError] = useState<string | null>(null)
  const [spawning, setSpawning] = useState(false)
  const spawnFetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Compute the parent directory and partial name for autocomplete
  const spawnParentDir = spawnPath.includes('/') ? spawnPath.slice(0, spawnPath.lastIndexOf('/') + 1) : '/'
  const spawnPartial = spawnPath.includes('/')
    ? spawnPath.slice(spawnPath.lastIndexOf('/') + 1).toLowerCase()
    : spawnPath.toLowerCase()

  // Fetch dirs with debounce as user types
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

    // Listen directly on the WS for the response
    const ws = useSessionsStore.getState().ws
    if (ws) {
      ws.addEventListener('message', handler)
      sendWsMessage({ type: 'file_list_request', sessionId: selectedSessionId, requestId })
      // Cleanup after timeout
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

  // Hide ended sessions if an active/idle session exists in the same cwd
  const activeCwds = new Set(sessions.filter(s => s.status !== 'ended').map(s => s.cwd))
  const deduplicated = sessions.filter(s => s.status !== 'ended' || !activeCwds.has(s.cwd))
  const allSessions = [...deduplicated].sort((a, b) => b.startedAt - a.startedAt)

  // Fuzzy matching for sessions
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
    filter && !isFileMode && !isSpawnMode ? sessionFzf.find(filter).map(r => r.item) : allSessions

  // Fuzzy matching for files
  const fileFzf = useMemo(() => new Fzf(files, { selector: (f: FileInfo) => `${f.name} ${f.path}` }), [files])
  const filteredFiles = fileFilter ? fileFzf.find(fileFilter).map(r => r.item) : files

  const itemCount = isCommandMode
    ? filteredCommands.length
    : isSpawnMode
      ? filteredSpawnDirs.length
      : isFileMode
        ? filteredFiles.length
        : filteredSessions.length

  // Clamp active index
  useEffect(() => {
    if (activeIndex >= itemCount) {
      setActiveIndex(Math.max(0, itemCount - 1))
    }
  }, [itemCount, activeIndex])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function handleKeyDown(e: React.KeyboardEvent) {
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
          // If a dir is highlighted, complete it; if path ends with /, spawn there
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
            onFileSelect(selectedSessionId, file.path)
          }
        } else if (filteredSessions[activeIndex]) {
          onSelect(filteredSessions[activeIndex].id)
        }
        break
    }
  }

  function statusIndicator(s: Session) {
    if (canTerminal(s)) return '\u25B6' // ▶ terminal available
    if (s.id === selectedSessionId) return '\u25C9' // ◉ current
    if (s.status === 'active') return '\u25CF' // ●
    if (s.status === 'idle') return '\u25CB' // ○
    return '\u2716' // ✖ ended
  }

  function statusColor(s: Session) {
    if (canTerminal(s)) return s.status === 'active' ? 'text-[#9ece6a]' : 'text-[#e0af68]'
    if (s.id === selectedSessionId) return 'text-[#7aa2f7]'
    if (s.status === 'active') return 'text-[#9ece6a]'
    if (s.status === 'idle') return 'text-[#e0af68]'
    return 'text-[#565f89]'
  }

  function actionLabel(s: Session) {
    if (canTerminal(s)) return s.id === selectedSessionId ? 'TTY (current)' : 'TTY'
    if (s.status === 'ended') return 'revive'
    return ''
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-[#16161e] border border-[#33467c] shadow-2xl font-mono"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="px-3 py-2 border-b border-[#33467c] flex items-center gap-2">
          {isSpawnMode && <FolderPlus className="w-4 h-4 text-[#9ece6a] shrink-0" />}
          {isFileMode && !isSpawnMode && <FileText className="w-4 h-4 text-[#7aa2f7] shrink-0" />}
          <input
            ref={inputRef}
            type="text"
            value={filter}
            onChange={e => {
              setFilter(e.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              isCommandMode
                ? 'Type a command...'
                : isSpawnMode
                  ? 'Path to spawn (e.g. projects/my-app or /absolute/path)...'
                  : isFileMode
                    ? 'Search files...'
                    : 'Switch session... (>cmd  F:files  S:spawn)'
            }
            className="w-full bg-transparent text-[19px] sm:text-sm text-[#a9b1d6] placeholder:text-[#565f89] outline-none"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* List */}
        <div className="max-h-[40vh] overflow-y-auto">
          {isCommandMode ? (
            <>
              {filteredCommands.length === 0 && (
                <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">No matching commands</div>
              )}
              {filteredCommands.map((cmd, i) => (
                <button
                  key={cmd.id}
                  type="button"
                  onClick={cmd.action}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={cn(
                    'w-full px-3 py-2 flex items-center justify-between text-left transition-colors',
                    i === activeIndex ? 'bg-[#33467c]/50' : 'hover:bg-[#33467c]/25',
                  )}
                >
                  <span className="text-xs text-[#a9b1d6]">{cmd.label}</span>
                  {cmd.shortcut && (
                    <kbd className="px-1.5 py-0.5 bg-[#33467c]/30 text-[10px] text-[#565f89]">{cmd.shortcut}</kbd>
                  )}
                </button>
              ))}
            </>
          ) : isSpawnMode ? (
            <>
              {!agentConnected && (
                <div className="px-3 py-4 text-center text-[10px] text-red-400">No host agent connected</div>
              )}
              {agentConnected && spawnLoading && (
                <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">Loading directories...</div>
              )}
              {agentConnected && spawnError && (
                <div className="px-3 py-4 text-center text-[10px] text-red-400">{spawnError}</div>
              )}
              {agentConnected && !spawnLoading && filteredSpawnDirs.length === 0 && spawnPath && !spawnError && (
                <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">
                  {spawnPath.endsWith('/') ? 'No subdirectories' : 'No matches'}
                </div>
              )}
              {agentConnected && !spawnLoading && !spawnPath && (
                <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">
                  Type a path (e.g. ~/projects/my-app)
                </div>
              )}
              {filteredSpawnDirs.map((dir, i) => (
                <button
                  key={dir}
                  type="button"
                  onClick={() => {
                    setFilter(`S:${spawnParentDir}${dir}/`)
                    setActiveIndex(0)
                    inputRef.current?.focus()
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={cn(
                    'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
                    i === activeIndex ? 'bg-[#33467c]/50' : 'hover:bg-[#33467c]/25',
                  )}
                >
                  <FolderPlus className="w-3.5 h-3.5 text-[#9ece6a] shrink-0" />
                  <span className="text-xs text-[#a9b1d6]">{dir}/</span>
                </button>
              ))}
              {agentConnected && spawnPath && spawnPath.endsWith('/') && !spawning && (
                <button
                  type="button"
                  onClick={() => handleSpawn(spawnPath.slice(0, -1))}
                  className="w-full px-3 py-2 flex items-center gap-3 text-left bg-[#9ece6a]/10 hover:bg-[#9ece6a]/20 transition-colors border-t border-[#33467c]/50"
                >
                  <FolderPlus className="w-3.5 h-3.5 text-[#9ece6a] shrink-0" />
                  <span className="text-xs text-[#9ece6a] font-bold">Spawn session at {spawnPath.slice(0, -1)}</span>
                </button>
              )}
              {spawning && (
                <div className="px-3 py-4 text-center text-[10px] text-[#9ece6a] animate-pulse">
                  Spawning session...
                </div>
              )}
            </>
          ) : isFileMode ? (
            <>
              {filesLoading && <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">Loading files...</div>}
              {!filesLoading && filteredFiles.length === 0 && (
                <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">
                  {files.length === 0 ? 'No .md files found' : 'No matches'}
                </div>
              )}
              {filteredFiles.map((file, i) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => selectedSessionId && onFileSelect(selectedSessionId, file.path)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={cn(
                    'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
                    i === activeIndex ? 'bg-[#33467c]/50' : 'hover:bg-[#33467c]/25',
                  )}
                >
                  <FileText className="w-3.5 h-3.5 text-[#7aa2f7] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-[#a9b1d6] truncate">{file.path}</div>
                  </div>
                  <span className="text-[10px] text-[#565f89]">{formatFileSize(file.size)}</span>
                </button>
              ))}
            </>
          ) : (
            <>
              {filteredSessions.length === 0 && (
                <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">
                  {allSessions.length === 0 ? 'No sessions' : 'No matches'}
                </div>
              )}
              {filteredSessions.map((session, i) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onSelect(session.id)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={cn(
                    'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
                    i === activeIndex ? 'bg-[#33467c]/50' : 'hover:bg-[#33467c]/25',
                  )}
                >
                  <span className={cn('text-sm', statusColor(session))}>{statusIndicator(session)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-[#a9b1d6] truncate flex items-center gap-1.5">
                      {projectSettings[session.cwd]?.icon && (
                        <span
                          style={
                            projectSettings[session.cwd]?.color
                              ? { color: projectSettings[session.cwd].color }
                              : undefined
                          }
                        >
                          {renderProjectIcon(projectSettings[session.cwd].icon!, 'w-3 h-3 inline')}
                        </span>
                      )}
                      <span
                        style={
                          projectSettings[session.cwd]?.color
                            ? { color: projectSettings[session.cwd].color }
                            : undefined
                        }
                      >
                        {projectSettings[session.cwd]?.label || lastPathSegments(session.cwd, 3)}
                      </span>
                    </div>
                    <div className="text-[10px] text-[#565f89] flex items-center gap-2">
                      <span>{session.id.slice(0, 8)}</span>
                      <span>{formatAge(session.lastActivity)}</span>
                      {session.model && <span>{session.model.replace('claude-', '').replace(/-\d{8}$/, '')}</span>}
                    </div>
                  </div>
                  {actionLabel(session) && (
                    <span className={cn('text-[10px]', canTerminal(session) ? 'text-[#9ece6a]' : 'text-[#565f89]')}>
                      {actionLabel(session)}
                    </span>
                  )}
                </button>
              ))}
            </>
          )}
        </div>

        {/* Footer hints */}
        <div className="px-3 py-1.5 border-t border-[#33467c]/50 flex items-center gap-3 text-[10px] text-[#565f89]">
          <span>
            <kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">↑↓</kbd> navigate
          </span>
          {isSpawnMode ? (
            <>
              <span>
                <kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">tab</kbd> complete
              </span>
              <span>
                <kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">⏎</kbd> spawn
              </span>
              <span>
                <kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">esc</kbd> back
              </span>
            </>
          ) : isFileMode ? (
            <>
              <span>
                <kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">⏎</kbd> open file
              </span>
              <span>
                <kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">esc</kbd> back
              </span>
            </>
          ) : (
            <>
              <span>
                <kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">⏎</kbd> select
              </span>
              <span>
                <kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">F:</kbd> files
              </span>
              {agentConnected && (
                <span>
                  <kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">S:</kbd> spawn
                </span>
              )}
              <span>
                <kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">esc</kbd> close
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
