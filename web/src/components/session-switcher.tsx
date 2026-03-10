import { FileText } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FileInfo } from '@/hooks/use-file-editor'
import { useSessionsStore } from '@/hooks/use-sessions'
import { canTerminal, type Session } from '@/lib/types'
import { cn, formatAge, lastPathSegments } from '@/lib/utils'
import { renderProjectIcon } from './project-settings-editor'

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

  // File picker mode
  const isFileMode = filter.toLowerCase().startsWith('f:')
  const fileFilter = isFileMode ? filter.slice(2).trim().toLowerCase() : ''
  const [files, setFiles] = useState<FileInfo[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const filesFetched = useRef(false)

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

  const filteredSessions = filter
    ? allSessions.filter(s => {
        const ps = projectSettings[s.cwd]
        const haystack = `${s.cwd} ${ps?.label || ''} ${s.id} ${s.model || ''} ${s.status}`.toLowerCase()
        return filter
          .toLowerCase()
          .split(/\s+/)
          .every(word => haystack.includes(word))
      })
    : allSessions

  const filteredFiles = fileFilter
    ? files.filter(f => f.name.toLowerCase().includes(fileFilter) || f.path.toLowerCase().includes(fileFilter))
    : files

  const itemCount = isFileMode ? filteredFiles.length : filteredSessions.length

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
        if (isFileMode) {
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
      case 'Enter':
        e.preventDefault()
        if (isFileMode) {
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
          {isFileMode && <FileText className="w-4 h-4 text-[#7aa2f7] shrink-0" />}
          <input
            ref={inputRef}
            type="text"
            value={filter}
            onChange={e => {
              setFilter(e.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder={isFileMode ? 'Search files...' : 'Switch session... (F: for files)'}
            className="w-full bg-transparent text-sm text-[#a9b1d6] placeholder:text-[#565f89] outline-none"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* List */}
        <div className="max-h-[40vh] overflow-y-auto">
          {isFileMode ? (
            <>
              {filesLoading && (
                <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">Loading files...</div>
              )}
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
          <span>
            <kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">⏎</kbd>{' '}
            {isFileMode ? 'open file' : 'open terminal'}
          </span>
          {isFileMode ? (
            <span>
              <kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">esc</kbd> back
            </span>
          ) : (
            <>
              <span>
                <kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">F:</kbd> files
              </span>
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
