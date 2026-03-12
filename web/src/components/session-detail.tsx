import { ArrowLeft, ChevronDown, ChevronRight, ChevronUp, Terminal } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { fetchSubagentTranscript, reviveSession, sendInput, useSessionsStore } from '@/hooks/use-sessions'
import { canTerminal, type TranscriptEntry } from '@/lib/types'
import { cn, formatAge, formatModel, haptic, isMobileViewport } from '@/lib/utils'
import { BgTasksView } from './bg-tasks-view'
import { DiagView } from './diag-view'
import { EventsView } from './events-view'
import { FileEditor } from './file-editor'
import { MarkdownInput } from './markdown-input'
import { renderProjectIcon } from './project-settings-editor'
import { SubagentView } from './subagent-view'
import { TasksView } from './tasks-view'
import { TranscriptView } from './transcript-view'
import { WebTerminal } from './web-terminal'

type Tab = 'transcript' | 'events' | 'agents' | 'tasks' | 'files' | 'diag'

// Stable empty references to avoid re-render loops with Zustand selectors
// (Zustand uses Object.is - a new [] !== previous [], causing infinite re-renders)
const EMPTY_EVENTS: any[] = []
const EMPTY_TRANSCRIPT: TranscriptEntry[] = []

function ScrollToBottomButton({ onClick, direction = 'down' }: { onClick: () => void; direction?: 'down' | 'up' }) {
  const Icon = direction === 'up' ? ChevronUp : ChevronDown
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-22 right-3 z-50 w-8 h-8 flex items-center justify-center rounded-full bg-[#7aa2f7] text-[#1a1b26] shadow-lg shadow-[#7aa2f7]/20 hover:bg-[#89b4fa] transition-colors cursor-pointer"
      title={direction === 'up' ? 'Scroll to top' : 'Scroll to bottom'}
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}

// Isolated input bar - typing here does NOT rerender transcript/events
const InputBar = memo(function InputBar({ sessionId }: { sessionId: string }) {
  const [inputValue, setLocalInput] = useState(() => useSessionsStore.getState().inputDrafts[sessionId] ?? '')
  const [isSending, setIsSending] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef(inputValue)
  const sessionRef = useRef(sessionId)

  function setInputValue(text: string) {
    setLocalInput(text)
    inputRef.current = text
  }

  // Session switch: save old draft, restore new
  useEffect(() => {
    if (sessionRef.current !== sessionId) {
      useSessionsStore.getState().setInputDraft(sessionRef.current, inputRef.current)
      const restored = useSessionsStore.getState().inputDrafts[sessionId] ?? ''
      setLocalInput(restored)
      inputRef.current = restored
      sessionRef.current = sessionId
    }
  }, [sessionId])

  // Save draft on unmount
  useEffect(() => {
    return () => {
      useSessionsStore.getState().setInputDraft(sessionRef.current, inputRef.current)
    }
  }, [])

  async function handleSend() {
    if (!inputValue.trim() || isSending) return
    haptic('tap')
    setIsSending(true)
    try {
      const success = await sendInput(sessionId, inputValue)
      if (success) setInputValue('')
    } finally {
      setIsSending(false)
      // Re-focus on desktop only - on mobile this triggers the full-screen compose modal
      if (!isMobileViewport()) {
        requestAnimationFrame(() => containerRef.current?.querySelector('textarea')?.focus())
      }
    }
  }

  return (
    <div ref={containerRef} className="shrink-0 p-3 border-t border-border bg-background z-10">
      <div className="flex gap-2 items-stretch">
        <MarkdownInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSend}
          disabled={isSending}
          placeholder="Enter to send, Shift+Enter for new line"
          className="flex-1"
          autoFocus
        />
        <button
          type="button"
          onClick={() => {
            if (inputValue.trim() && !isSending) {
              handleSend()
            } else {
              // No input - focus the textarea instead (useful on mobile to avoid Siri zone)
              containerRef.current?.querySelector('textarea')?.focus()
            }
          }}
          disabled={isSending}
          className={cn(
            'shrink-0 px-4 py-2 text-xs font-bold font-mono border rounded transition-colors',
            inputValue.trim() && !isSending
              ? 'bg-accent text-accent-foreground border-accent hover:bg-accent/80'
              : 'bg-muted text-muted-foreground border-border cursor-not-allowed',
          )}
        >
          {isSending ? '...' : 'SEND'}
        </button>
      </div>
    </div>
  )
})

export function SessionDetail() {
  const [activeTab, setActiveTab] = useState<Tab>('transcript')
  const [follow, setFollow] = useState(true)
  const showThinking = useSessionsStore(s => s.dashboardPrefs.showThinking)
  const [reviveState, setReviveState] = useState<'idle' | 'sending' | 'waiting' | 'error'>('idle')
  const [reviveError, setReviveError] = useState<string | null>(null)
  const [reviveCountdown, setReviveCountdown] = useState(0)
  const disableFollow = useCallback(() => setFollow(false), [])
  const enableFollow = useCallback(() => setFollow(true), [])
  const reviveStartRef = useRef(0) // timestamp when revive started, to ignore pre-existing sessions
  const [infoExpanded, setInfoExpanded] = useState(false)
  const showTerminal = useSessionsStore(state => state.showTerminal)
  const terminalWrapperId = useSessionsStore(state => state.terminalWrapperId)
  const setShowTerminal = useSessionsStore(state => state.setShowTerminal)
  const requestedTab = useSessionsStore(state => state.requestedTab)
  const requestedTabSeq = useSessionsStore(state => state.requestedTabSeq)
  const selectedSessionId = useSessionsStore(state => state.selectedSessionId)
  const expandAll = useSessionsStore(state => state.expandAll)

  // Apply requested tab - fires on selectSession (always 'transcript'), openTab, and badge clicks
  // requestedTabSeq ensures re-clicks on the same session still trigger
  useEffect(() => {
    if (requestedTab) {
      setActiveTab(requestedTab as Tab)
      useSessionsStore.setState({ requestedTab: null })
    }
  }, [requestedTab, requestedTabSeq])

  const sessions = useSessionsStore(state => state.sessions)
  const events = useSessionsStore(state =>
    selectedSessionId ? state.events[selectedSessionId] || EMPTY_EVENTS : EMPTY_EVENTS,
  )
  const transcript = useSessionsStore(state =>
    selectedSessionId ? state.transcripts[selectedSessionId] || EMPTY_TRANSCRIPT : EMPTY_TRANSCRIPT,
  )
  const agentConnected = useSessionsStore(state => state.agentConnected)
  const projectSettings = useSessionsStore(state => state.projectSettings)
  const selectedSubagentId = useSessionsStore(state => state.selectedSubagentId)
  const selectSubagent = useSessionsStore(state => state.selectSubagent)
  const session = sessions.find(s => s.id === selectedSessionId)

  // Subagent transcript: store (live WS push) + initial HTTP fetch
  const subagentKey = selectedSessionId && selectedSubagentId ? `${selectedSessionId}:${selectedSubagentId}` : ''
  const subagentTranscriptRaw = useSessionsStore(state =>
    subagentKey ? state.subagentTranscripts[subagentKey] : undefined,
  )
  const subagentTranscript = subagentTranscriptRaw || EMPTY_TRANSCRIPT
  const [subagentLoading, setSubagentLoading] = useState(false)

  // Fetch initial subagent transcript via HTTP, seed into store
  useEffect(() => {
    if (!selectedSessionId || !selectedSubagentId) return
    let cancelled = false
    setSubagentLoading(true)
    fetchSubagentTranscript(selectedSessionId, selectedSubagentId).then(entries => {
      if (cancelled) return
      setSubagentLoading(false)
      if (entries.length > 0) {
        const key = `${selectedSessionId}:${selectedSubagentId}`
        useSessionsStore.setState(state => ({
          subagentTranscripts: { ...state.subagentTranscripts, [key]: entries },
        }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [selectedSessionId, selectedSubagentId])

  // HOOKS MUST BE BEFORE EARLY RETURNS - React rules!

  // Countdown timer while waiting for revived session
  useEffect(() => {
    if (reviveState !== 'waiting') return
    if (reviveCountdown <= 0) {
      setReviveState('error')
      setReviveError('Timed out - no session connected within 30s')
      return
    }
    const t = setTimeout(() => setReviveCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [reviveState, reviveCountdown])

  // Watch for new session connecting in same cwd (revive success)
  const reviveCwd = session?.cwd
  const reviveSessionId = session?.id
  useEffect(() => {
    if (reviveState !== 'waiting' || !reviveCwd || !reviveSessionId) return
    const reviveTime = reviveStartRef.current
    if (reviveTime === 0) return
    const newSession = sessions.find(
      s =>
        s.id !== reviveSessionId &&
        s.cwd === reviveCwd &&
        (s.status === 'active' || s.status === 'idle') &&
        s.startedAt > reviveTime,
    )
    if (newSession) {
      setReviveState('idle')
      setReviveCountdown(0)
      reviveStartRef.current = 0
      useSessionsStore.getState().selectSession(newSession.id)
    }
  }, [reviveState, reviveCwd, reviveSessionId, sessions])

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <pre className="text-xs" style={{ lineHeight: 0.95 }}>
          {`
┌───────────────────────────┐
│                           │
│   Select a session to     │
│   view details            │
│                           │
│   _                       │
│                           │
└───────────────────────────┘
`.trim()}
        </pre>
      </div>
    )
  }

  const model = events.find(e => e.hookEvent === 'SessionStart' && e.data?.model)?.data?.model as string | undefined

  const canSendInput = session?.status === 'active' || session?.status === 'idle'
  const hasTerminal = session ? canTerminal(session) : false
  const canRevive = session?.status === 'ended' && agentConnected

  async function handleRevive() {
    if (!selectedSessionId || reviveState !== 'idle') return
    setReviveState('sending')
    setReviveError(null)
    try {
      const result = await reviveSession(selectedSessionId)
      if (!result.success) {
        setReviveError(result.error || 'Revive failed')
        setReviveState('error')
        return
      }
      // Signal sent - now wait for new session to connect
      reviveStartRef.current = Date.now()
      setReviveState('waiting')
      setReviveCountdown(30)
    } catch {
      setReviveError('Network error')
      setReviveState('error')
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
      {/* Session Info - Collapsible */}
      <div className="shrink-0 border-b border-border max-h-[30vh] overflow-y-auto">
        <button
          type="button"
          onClick={() => setInfoExpanded(!infoExpanded)}
          className="w-full p-3 sm:p-4 flex items-center gap-2 hover:bg-muted/30 transition-colors"
        >
          {infoExpanded ? (
            <ChevronDown className="w-3 h-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
          )}
          <span className="text-accent text-xs uppercase tracking-wider">Session Info</span>
          {!infoExpanded &&
            (() => {
              const ps = projectSettings[session.cwd]
              return (
                <span className="text-muted-foreground text-[10px] ml-2 inline-flex items-center gap-1">
                  {ps?.icon && (
                    <span style={ps?.color ? { color: ps.color } : undefined}>
                      {renderProjectIcon(ps.icon, 'w-3 h-3')}
                    </span>
                  )}
                  <span style={ps?.color ? { color: ps.color } : undefined}>
                    {ps?.label || session.cwd.split('/').slice(-2).join('/')}
                  </span>
                  <span>
                    {' · '}
                    {formatModel(model || session.model)}
                  </span>
                  {session.tokenUsage &&
                    (() => {
                      const { input, cacheCreation, cacheRead } = session.tokenUsage
                      const total = input + cacheCreation + cacheRead
                      const maxTokens = 200_000
                      const pct = Math.min(100, Math.round((total / maxTokens) * 100))
                      const totalK = Math.round(total / 1000)
                      return (
                        <span className="inline-flex items-center gap-1 ml-1">
                          <span className="text-muted-foreground">·</span>
                          <span className="inline-block w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                            <span
                              className={cn(
                                'block h-full rounded-full',
                                pct < 60 ? 'bg-emerald-400' : pct < 85 ? 'bg-amber-400' : 'bg-red-400',
                              )}
                              style={{ width: `${pct}%` }}
                            />
                          </span>
                          <span
                            className={cn(
                              'text-[10px] font-mono',
                              pct < 60 ? 'text-emerald-400/70' : pct < 85 ? 'text-amber-400/70' : 'text-red-400/70',
                            )}
                          >
                            {totalK}K ({pct}%)
                          </span>
                        </span>
                      )
                    })()}
                </span>
              )
            })()}
        </button>
        {infoExpanded &&
          (() => {
            const s = session.stats
            const tu = session.tokenUsage
            const contextTotal = tu ? tu.input + tu.cacheCreation + tu.cacheRead : 0
            const contextPct = tu ? Math.min(100, Math.round((contextTotal / 200_000) * 100)) : 0

            // Cost estimation (per 1M tokens, Opus pricing)
            const inputCostPer1M = 15
            const outputCostPer1M = 75
            const cacheCostPer1M = 1.875 // cache read
            const cacheWriteCostPer1M = 18.75 // cache creation
            const estimatedCost = s
              ? ((s.totalInputTokens - s.totalCacheCreation - s.totalCacheRead) * inputCostPer1M +
                  s.totalOutputTokens * outputCostPer1M +
                  s.totalCacheRead * cacheCostPer1M +
                  s.totalCacheCreation * cacheWriteCostPer1M) /
                1_000_000
              : 0

            return (
              <div className="px-3 sm:px-4 pb-3 sm:pb-4 text-xs font-mono space-y-3">
                {/* Row 1: Status + Git + Model */}
                <div className="flex items-center gap-3 flex-wrap">
                  <span
                    className={cn(
                      'px-2 py-0.5 text-[10px] uppercase font-bold',
                      session.status === 'active' && 'bg-active text-background',
                      session.status === 'idle' && 'bg-idle text-background',
                      session.status === 'ended' && 'bg-ended text-foreground',
                    )}
                  >
                    {session.status}
                  </span>
                  <span className="text-foreground">{formatModel(model || session.model)}</span>
                  {session.gitBranch && (
                    <span className="text-purple-400 text-[10px]">
                      <span className="text-muted-foreground">branch:</span> {session.gitBranch}
                    </span>
                  )}
                  <span className="text-muted-foreground text-[10px]">{session.id.slice(0, 8)}</span>
                </div>

                {/* Row 2: Context window bar */}
                {tu && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-[10px] w-16">context</span>
                      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className={cn(
                            'h-full rounded-full transition-all',
                            contextPct < 60 ? 'bg-emerald-400' : contextPct < 85 ? 'bg-amber-400' : 'bg-red-400',
                          )}
                          style={{ width: `${contextPct}%` }}
                        />
                      </div>
                      <span
                        className={cn(
                          'text-[10px] w-16 text-right',
                          contextPct < 60 ? 'text-emerald-400' : contextPct < 85 ? 'text-amber-400' : 'text-red-400',
                        )}
                      >
                        {Math.round(contextTotal / 1000)}K / 200K
                      </span>
                    </div>
                  </div>
                )}

                {/* Row 3: Token stats */}
                {s && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-[10px]">
                    <div>
                      <span className="text-muted-foreground">in </span>
                      <span className="text-cyan-400">{(s.totalInputTokens / 1000).toFixed(0)}K</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">out </span>
                      <span className="text-orange-400">{(s.totalOutputTokens / 1000).toFixed(0)}K</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">cache r/w </span>
                      <span className="text-blue-400">{(s.totalCacheRead / 1000).toFixed(0)}K</span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="text-purple-400">{(s.totalCacheCreation / 1000).toFixed(0)}K</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">cost </span>
                      <span className="text-emerald-400">${estimatedCost.toFixed(2)}</span>
                    </div>
                  </div>
                )}

                {/* Row 4: Session stats */}
                <div className="flex items-center gap-4 text-[10px] flex-wrap">
                  {s && s.turnCount > 0 && (
                    <span>
                      <span className="text-muted-foreground">turns </span>
                      <span className="text-foreground">{s.turnCount}</span>
                    </span>
                  )}
                  {s && s.toolCallCount > 0 && (
                    <span>
                      <span className="text-muted-foreground">tools </span>
                      <span className="text-foreground">{s.toolCallCount}</span>
                    </span>
                  )}
                  {session.totalSubagentCount > 0 && (
                    <span>
                      <span className="text-muted-foreground">agents </span>
                      <span className="text-foreground">{session.totalSubagentCount}</span>
                    </span>
                  )}
                  {s && s.compactionCount > 0 && (
                    <span>
                      <span className="text-muted-foreground">compactions </span>
                      <span className="text-amber-400">{s.compactionCount}</span>
                    </span>
                  )}
                  <span>
                    <span className="text-muted-foreground">started </span>
                    <span className="text-foreground">
                      {new Date(session.startedAt).toLocaleTimeString('en-US', { hour12: false })}
                    </span>
                  </span>
                  <span>
                    <span className="text-muted-foreground">last </span>
                    <span className="text-foreground">{formatAge(session.lastActivity)}</span>
                  </span>
                </div>

                {/* CWD */}
                <div className="text-[10px] text-muted-foreground truncate">{session.cwd}</div>
              </div>
            )
          })()}
      </div>

      {/* Subagent Detail View - replaces entire panel content */}
      {selectedSubagentId &&
        (() => {
          const agent = session.subagents.find(a => a.agentId === selectedSubagentId)
          return (
            <>
              <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border bg-pink-400/5">
                <button
                  type="button"
                  onClick={() => selectSubagent(null)}
                  className="flex items-center gap-1 text-xs text-pink-400 hover:text-pink-300 transition-colors"
                >
                  <ArrowLeft className="w-3 h-3" />
                  Back
                </button>
                <div className="w-px h-4 bg-border" />
                <span className="text-xs text-pink-400 font-bold">
                  {agent?.description || agent?.agentType || 'agent'}
                </span>
                <span className="text-[10px] text-pink-400/50 font-mono">{selectedSubagentId.slice(0, 8)}</span>
                {agent && (
                  <span
                    className={cn(
                      'ml-auto px-1.5 py-0.5 text-[10px] uppercase font-bold',
                      agent.status === 'running' ? 'bg-active text-background' : 'bg-ended text-foreground',
                    )}
                  >
                    {agent.status}
                  </span>
                )}
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                {subagentLoading && subagentTranscript.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
                    Loading transcript...
                  </div>
                ) : subagentTranscript.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
                    No transcript entries yet
                  </div>
                ) : (
                  <TranscriptView
                    entries={subagentTranscript}
                    follow={follow}
                    showThinking={showThinking}
                    onUserScroll={disableFollow}
                  />
                )}
              </div>
            </>
          )
        })()}

      {/* Normal session view */}
      {!selectedSubagentId && (
        <>
          {/* Tabs with follow checkbox */}
          <div className="shrink-0 flex items-center border-b border-border overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            <button
              type="button"
              onClick={() => {
                haptic('tick')
                setActiveTab('transcript')
              }}
              className={cn(
                'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
                activeTab === 'transcript'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              Transcript
            </button>
            <button
              type="button"
              onClick={() => {
                haptic('tick')
                setActiveTab('events')
              }}
              className={cn(
                'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
                activeTab === 'events'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              Events
            </button>
            {(session.totalSubagentCount > 0 || session.activeSubagentCount > 0 || session.bgTasks.length > 0) && (
              <button
                type="button"
                onClick={() => {
                  haptic('tick')
                  setActiveTab('agents')
                }}
                className={cn(
                  'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
                  activeTab === 'agents'
                    ? 'border-accent text-accent'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                Agents
                {(session.activeSubagentCount > 0 || session.runningBgTaskCount > 0) && (
                  <span className="ml-1.5 px-1.5 py-0.5 bg-active/20 text-active text-[10px] font-bold">
                    {session.activeSubagentCount + session.runningBgTaskCount}
                  </span>
                )}
              </button>
            )}
            {(session.taskCount > 0 || (session.archivedTaskCount ?? 0) > 0) && (
              <button
                type="button"
                onClick={() => {
                  haptic('tick')
                  setActiveTab('tasks')
                }}
                className={cn(
                  'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
                  activeTab === 'tasks'
                    ? 'border-accent text-accent'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                Tasks
                {session.pendingTaskCount > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 bg-amber-500/20 text-amber-400 text-[10px] font-bold">
                    {session.pendingTaskCount}
                  </span>
                )}
              </button>
            )}
            {session.status === 'active' && (
              <button
                type="button"
                onClick={() => {
                  haptic('tick')
                  setActiveTab('files')
                }}
                className={cn(
                  'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
                  activeTab === 'files'
                    ? 'border-accent text-accent'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                Files
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                haptic('tick')
                setActiveTab('diag')
              }}
              className={cn(
                'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
                activeTab === 'diag'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              Diag
            </button>
            {/* Terminal + Follow - pushed to right */}
            <div className="ml-auto pr-3 flex items-center gap-2">
              {hasTerminal && (
                <button
                  type="button"
                  onClick={e => {
                    const wid = session?.wrapperIds?.[0]
                    if (!wid) return
                    if (e.shiftKey) {
                      window.open(`/#popout-terminal/${wid}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no')
                    } else {
                      useSessionsStore.getState().openTerminal(wid)
                    }
                  }}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono text-muted-foreground hover:text-accent transition-colors"
                  title="Open terminal (Shift+click to pop out)"
                >
                  <Terminal className="w-3 h-3" />
                  TTY
                </button>
              )}
              <div className="w-px h-4 bg-border" />
            </div>
            <div className="pr-3 flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <Checkbox
                  id="verbose"
                  checked={expandAll}
                  onCheckedChange={checked => {
                    if (checked !== expandAll) useSessionsStore.getState().toggleExpandAll()
                  }}
                  className="h-3.5 w-3.5"
                />
                <label htmlFor="verbose" className="text-[10px] text-muted-foreground cursor-pointer select-none">
                  verbose
                </label>
              </div>
            </div>
          </div>

          {activeTab === 'transcript' && (
            <div className="flex-1 min-h-0 overflow-hidden relative">
              <TranscriptView
                key={selectedSessionId}
                entries={transcript}
                follow={follow}
                showThinking={showThinking}
                onUserScroll={disableFollow}
                onReachedBottom={enableFollow}
              />
              {!follow && transcript.length > 0 && <ScrollToBottomButton onClick={enableFollow} direction="down" />}
            </div>
          )}
          {activeTab === 'events' && (
            <div className="flex-1 min-h-0 overflow-hidden relative">
              <EventsView
                key={selectedSessionId}
                events={events}
                follow={follow}
                onUserScroll={disableFollow}
                onReachedTop={enableFollow}
              />
              {!follow && events.length > 0 && <ScrollToBottomButton onClick={enableFollow} direction="up" />}
            </div>
          )}
          {activeTab === 'agents' && selectedSessionId && (
            <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 space-y-4">
              <SubagentView sessionId={selectedSessionId} />
              {session.bgTasks.length > 0 && (
                <>
                  <div className="border-t border-border pt-3">
                    <h3 className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider mb-2">
                      Background Tasks
                    </h3>
                  </div>
                  <BgTasksView sessionId={selectedSessionId} />
                </>
              )}
            </div>
          )}
          {activeTab === 'tasks' && selectedSessionId && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <TasksView sessionId={selectedSessionId} pendingCount={session.pendingTaskCount} />
            </div>
          )}
          {activeTab === 'files' && selectedSessionId && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <FileEditor sessionId={selectedSessionId} />
            </div>
          )}
          {activeTab === 'diag' && selectedSessionId && <DiagView sessionId={selectedSessionId} />}
        </>
      )}

      {/* Input box - isolated to prevent transcript rerenders on typing */}
      {canSendInput && activeTab === 'transcript' && !selectedSubagentId && selectedSessionId && (
        <InputBar sessionId={selectedSessionId} />
      )}

      {/* Terminal overlay - routed by wrapperId (physical PTY) */}
      {showTerminal && terminalWrapperId && (
        <WebTerminal
          wrapperId={terminalWrapperId}
          onClose={() => setShowTerminal(false)}
          onSwitchWrapper={wid => {
            useSessionsStore.getState().openTerminal(wid)
          }}
        />
      )}

      {/* Revive button for ended sessions */}
      {session?.status === 'ended' && (
        <div className="shrink-0 p-3 border-t border-border">
          {canRevive ? (
            <div>
              <Button
                onClick={
                  reviveState === 'error'
                    ? () => {
                        setReviveState('idle')
                        setReviveError(null)
                      }
                    : handleRevive
                }
                disabled={reviveState === 'sending' || reviveState === 'waiting'}
                size="sm"
                className={cn(
                  'w-full text-xs border',
                  reviveState === 'waiting'
                    ? 'bg-amber-400/20 text-amber-400 border-amber-400/50'
                    : reviveState === 'error'
                      ? 'bg-red-400/20 text-red-400 border-red-400/50 hover:bg-red-400/30'
                      : 'bg-active/20 text-active border-active/50 hover:bg-active/30',
                )}
              >
                {reviveState === 'sending' && 'Sending signal...'}
                {reviveState === 'waiting' && `Waiting for connection... ${reviveCountdown}s`}
                {reviveState === 'error' && 'Retry'}
                {reviveState === 'idle' && 'Revive Session'}
              </Button>
              {reviveError && <p className="text-[10px] text-red-400 mt-1">{reviveError}</p>}
              {reviveState === 'idle' && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  Spawns new rclaude in tmux at {session.cwd.split('/').slice(-2).join('/')}
                </p>
              )}
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground text-center">
              {agentConnected ? 'Session ended' : 'No host agent connected -- revive unavailable'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
