import type { HookEvent } from '@shared/protocol'
import { ArrowLeft } from 'lucide-react'
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { type TaskStatus, useProject } from '@/hooks/use-project'
import { fetchSubagentTranscript, useSessionsStore } from '@/hooks/use-sessions'
import { canTerminal, type TranscriptEntry } from '@/lib/types'
import { setSessionTab } from '@/lib/ui-state'
import { cn, haptic } from '@/lib/utils'
import { BgTasksView } from './bg-tasks-view'
import { ConversationView } from './conversation-view'
import { DiagView } from './diag-view'
import { EventsView } from './events-view'
import { FileEditor } from './file-editor'
import { InlineTerminal } from './inline-terminal'
import { ProjectBoard, RunTaskDialog, TaskEditor } from './project-board'
import { ReviveMonitor } from './revive-monitor'
import {
  AskQuestionBanners,
  ClipboardBanners,
  LinkRequestBanners,
  PermissionBanners,
} from './session-detail/session-banners'
import { SessionHeader } from './session-detail/session-header'
import { DialogOverlay, InputBar, ScrollToBottomButton } from './session-detail/session-input'
import { SessionTabs, type Tab } from './session-detail/session-tabs'
import { ShareBanner } from './share-panel'
import { SharedView } from './shared-view'
import { SubagentView } from './subagent-view'
import { TasksView } from './tasks-view'
import { TranscriptDropZone, TranscriptView } from './transcript'

const WebTerminal = lazy(() => import('./web-terminal').then(m => ({ default: m.WebTerminal })))

// Stable empty references to avoid re-render loops with Zustand selectors
// (Zustand uses Object.is - a new [] !== previous [], causing infinite re-renders)
const EMPTY_EVENTS: HookEvent[] = []
const EMPTY_TRANSCRIPT: TranscriptEntry[] = []

export const SessionDetail = memo(function SessionDetail() {
  const [activeTab, setActiveTab] = useState<Tab>('transcript')
  const [follow, setFollow] = useState(true)
  const showThinking = useSessionsStore(s => s.dashboardPrefs.showThinking)
  const showDiag = useSessionsStore(s => s.dashboardPrefs.showDiag)
  const [showReviveMonitor, setShowReviveMonitor] = useState(false)
  const [conversationTarget, setConversationTarget] = useState<{
    cwdA: string
    cwdB: string
    nameA: string
    nameB: string
  } | null>(null)
  const disableFollow = useCallback(() => setFollow(false), [])
  const enableFollow = useCallback(() => setFollow(true), [])
  const [infoExpanded, setInfoExpanded] = useState(false)
  const showTerminal = useSessionsStore(state => state.showTerminal)
  const terminalWrapperId = useSessionsStore(state => state.terminalWrapperId)
  const setShowTerminal = useSessionsStore(state => state.setShowTerminal)
  const requestedTab = useSessionsStore(state => state.requestedTab)
  const requestedTabSeq = useSessionsStore(state => state.requestedTabSeq)
  const selectedSessionId = useSessionsStore(state => state.selectedSessionId)
  const expandAll = useSessionsStore(state => state.expandAll)

  // Reset follow + revive state on session switch
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedSessionId is the trigger dep, setters are stable React dispatch functions
  useEffect(() => {
    setFollow(true)
    setShowReviveMonitor(false)
    setConversationTarget(null)
  }, [selectedSessionId])

  // Apply requested tab - fires on selectSession (always 'transcript'), openTab, and badge clicks
  // requestedTabSeq ensures re-clicks on the same session still trigger
  // biome-ignore lint/correctness/useExhaustiveDependencies: requestedTabSeq is a counter dep key to re-trigger on same-tab clicks, not accessed in the body
  useEffect(() => {
    if (requestedTab) {
      setActiveTab(requestedTab as Tab)
    }
  }, [requestedTab, requestedTabSeq])

  const session = useSessionsStore(state =>
    state.selectedSessionId ? state.sessionsById[state.selectedSessionId] : undefined,
  )

  // Fall back to transcript if current tab is hidden for ended sessions
  useEffect(() => {
    if (session?.status === 'ended' && (activeTab === 'files' || activeTab === 'project')) {
      setActiveTab('transcript')
    }
  }, [session?.status, activeTab])

  // Persist active tab to localStorage (batched) so it survives reloads
  useEffect(() => {
    if (selectedSessionId) setSessionTab(selectedSessionId, activeTab)
  }, [selectedSessionId, activeTab])
  const { canAdmin, canChat, canReadTerminal, canReadFiles, canFiles, canSpawn } = useSessionsStore(
    useShallow(s => {
      const p = (s.selectedSessionId && s.sessionPermissions[s.selectedSessionId]) || s.permissions
      return {
        canAdmin: p.canAdmin,
        canChat: p.canChat,
        canReadTerminal: p.canReadTerminal,
        canReadFiles: p.canReadFiles,
        canFiles: p.canFiles,
        canSpawn: p.canSpawn,
      }
    }),
  )

  // Track activeTab in a ref so selectors can skip updates when data isn't visible.
  // This prevents transcript/event updates from re-rendering the file editor and vice versa.
  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab

  const events = useSessionsStore(state => {
    const tab = activeTabRef.current
    if (tab !== 'events' && tab !== 'transcript' && tab !== 'tty') return EMPTY_EVENTS
    return selectedSessionId ? state.events[selectedSessionId] || EMPTY_EVENTS : EMPTY_EVENTS
  })
  const transcript = useSessionsStore(state => {
    const tab = activeTabRef.current
    if (tab !== 'transcript' && tab !== 'tty') return EMPTY_TRANSCRIPT
    return selectedSessionId ? state.transcripts[selectedSessionId] || EMPTY_TRANSCRIPT : EMPTY_TRANSCRIPT
  })
  const agentConnected = useSessionsStore(state => state.agentConnected)
  const projectSettings = useSessionsStore(state => (session?.cwd ? state.projectSettings[session.cwd] : undefined))
  const selectedSubagentId = useSessionsStore(state => state.selectedSubagentId)
  const selectSubagent = useSessionsStore(state => state.selectSubagent)

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

  // T: command palette -> task editor overlay (no tab switch, transcript stays mounted)
  const pendingTaskEdit = useSessionsStore(s => s.pendingTaskEdit)
  const { tasks: projectTasks, readTask, updateTask, moveTask } = useProject(selectedSessionId ?? null)
  const [taskEditorTask, setTaskEditorTask] = useState<import('@/hooks/use-project').ProjectTask | null>(null)
  const [runTaskFromEditor, setRunTaskFromEditor] = useState<import('@/hooks/use-project').ProjectTask | null>(null)
  useEffect(() => {
    if (!pendingTaskEdit) return
    useSessionsStore.getState().setPendingTaskEdit(null)
    readTask(pendingTaskEdit.slug, pendingTaskEdit.status as TaskStatus).then(full => {
      if (full) setTaskEditorTask(full)
    })
  }, [pendingTaskEdit, readTask])
  // Sync taskEditorTask metadata when project tasks update (e.g. project_changed)
  useEffect(() => {
    if (!taskEditorTask) return
    const updated = projectTasks.find(t => t.slug === taskEditorTask.slug)
    if (updated && (updated.status !== taskEditorTask.status || updated.priority !== taskEditorTask.priority)) {
      setTaskEditorTask(prev =>
        prev ? { ...prev, status: updated.status, priority: updated.priority, tags: updated.tags } : prev,
      )
    }
  }, [projectTasks, taskEditorTask])

  // HOOKS MUST BE BEFORE EARLY RETURNS - React rules!

  // Plan mode: trust concentrator state (set by session_update from wrapper).
  // Previous implementation scanned the entire transcript on every length change -- expensive for large transcripts.
  const inPlanMode = session?.planMode ?? false

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

  const model = (events.find(e => e.hookEvent === 'SessionStart')?.data as { model?: string } | undefined)?.model

  const canSendInput = session != null && session.status !== 'ended' && canChat
  const hasTerminal = session ? canTerminal(session) : false
  const canRevive = session?.status === 'ended' && agentConnected && canSpawn

  function handleRevive() {
    if (!selectedSessionId) return
    haptic('tap')
    setShowReviveMonitor(true)
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
      {/* Link Request Banners */}
      <LinkRequestBanners />
      {/* Permission Relay Banners */}
      <PermissionBanners />
      {/* AskUserQuestion Banners */}
      <AskQuestionBanners />
      {/* Clipboard Capture Banners */}
      <ClipboardBanners />
      {/* Share banner - always visible when shares active (admin only) */}
      {canAdmin && session && <ShareBanner sessionCwd={session.cwd} />}
      {/* Dialog Modal */}
      {selectedSessionId && <DialogOverlay sessionId={selectedSessionId} />}
      {/* Task Editor Modal (from T: command palette, renders over any tab) */}
      {taskEditorTask && selectedSessionId && (
        <TaskEditor
          task={taskEditorTask}
          sessionId={selectedSessionId}
          onSave={async (slug, status, patch) => {
            await updateTask(slug, status, patch)
          }}
          onMove={async (slug, from, to) => {
            const result = await moveTask(slug, from, to)
            if (result)
              setTaskEditorTask(prev => (prev && prev.slug === slug ? { ...prev, slug: result, status: to } : prev))
            return !!result
          }}
          onRun={task => {
            setTaskEditorTask(null)
            setRunTaskFromEditor(task)
          }}
          onClose={() => setTaskEditorTask(null)}
        />
      )}
      {runTaskFromEditor && selectedSessionId && (
        <RunTaskDialog
          task={runTaskFromEditor}
          sessionId={selectedSessionId}
          onClose={() => setRunTaskFromEditor(null)}
        />
      )}
      {/* Session Info - Collapsible */}
      <SessionHeader
        session={session}
        projectSettings={projectSettings}
        model={model}
        inPlanMode={inPlanMode}
        infoExpanded={infoExpanded}
        onToggleExpanded={() => setInfoExpanded(!infoExpanded)}
        onSetConversationTarget={setConversationTarget}
      />

      {/* Subagent Detail View - replaces entire panel content */}
      {selectedSubagentId &&
        (() => {
          const agent = session.subagents.find(a => a.agentId === selectedSubagentId)
          return (
            <>
              <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border bg-pink-400/5">
                <button
                  type="button"
                  onClick={() => {
                    selectSubagent(null)
                    setFollow(true)
                  }}
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
          <SessionTabs
            session={session}
            activeTab={activeTab}
            onSetActiveTab={setActiveTab}
            hasTerminal={hasTerminal}
            canAdmin={canAdmin}
            canReadTerminal={canReadTerminal}
            canReadFiles={canReadFiles}
            showDiag={showDiag}
            expandAll={expandAll}
          />

          {/* Conversation view overlay - replaces content when viewing inter-session messages */}
          {conversationTarget && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <ConversationView
                cwdA={conversationTarget.cwdA}
                cwdB={conversationTarget.cwdB}
                nameA={conversationTarget.nameA}
                nameB={conversationTarget.nameB}
                onBack={() => setConversationTarget(null)}
              />
            </div>
          )}

          {!conversationTarget && (activeTab === 'transcript' || (activeTab === 'tty' && !hasTerminal)) && (
            <TranscriptDropZone
              enabled={canSendInput && canFiles}
              className={cn(
                'flex-1 min-h-0 overflow-hidden flex flex-col transition-colors duration-300',
                inPlanMode && 'bg-blue-950/20',
              )}
            >
              {inPlanMode && (
                <div className="sticky top-0 z-10 px-3 py-1.5 bg-blue-600/20 border-b border-blue-500/30 text-blue-400 text-[11px] font-mono font-bold tracking-wider text-center backdrop-blur-sm">
                  PLANNING MODE
                </div>
              )}
              <TranscriptView
                key={selectedSessionId}
                entries={transcript}
                follow={follow}
                showThinking={showThinking}
                onUserScroll={disableFollow}
                onReachedBottom={enableFollow}
              />
              {!follow && transcript.length > 0 && <ScrollToBottomButton onClick={enableFollow} direction="down" />}
            </TranscriptDropZone>
          )}
          {activeTab === 'tty' && hasTerminal && !showTerminal && session.wrapperIds?.[0] && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <InlineTerminal wrapperId={session.wrapperIds[0]} />
            </div>
          )}
          {!conversationTarget && activeTab === 'events' && (
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
          {!conversationTarget && activeTab === 'agents' && selectedSessionId && (
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
          {!conversationTarget && activeTab === 'tasks' && selectedSessionId && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <TasksView sessionId={selectedSessionId} pendingCount={session.pendingTaskCount} />
            </div>
          )}
          {!conversationTarget && activeTab === 'files' && selectedSessionId && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <FileEditor sessionId={selectedSessionId} />
            </div>
          )}
          {!conversationTarget && activeTab === 'project' && selectedSessionId && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <ProjectBoard sessionId={selectedSessionId} />
            </div>
          )}
          {!conversationTarget && activeTab === 'shared' && session && <SharedView cwd={session.cwd} />}
          {!conversationTarget && activeTab === 'diag' && selectedSessionId && (
            <DiagView sessionId={selectedSessionId} />
          )}
        </>
      )}

      {/* Input box - isolated to prevent transcript rerenders on typing */}
      {!conversationTarget &&
        canSendInput &&
        (activeTab === 'transcript' || (activeTab === 'tty' && !hasTerminal)) &&
        !selectedSubagentId &&
        selectedSessionId && <InputBar sessionId={selectedSessionId} />}

      {/* Terminal overlay - routed by wrapperId (physical PTY) */}
      {showTerminal && terminalWrapperId && (
        <Suspense
          fallback={
            <div className="absolute inset-0 flex items-center justify-center bg-background text-muted-foreground">
              Loading terminal...
            </div>
          }
        >
          <WebTerminal
            wrapperId={terminalWrapperId}
            onClose={() => {
              setShowTerminal(false)
              const store = useSessionsStore.getState()
              if (store.selectedSessionId) store.openTab(store.selectedSessionId, 'transcript')
            }}
          />
        </Suspense>
      )}

      {/* Revive button for ended sessions (hidden without spawn permission) */}
      {session?.status === 'ended' && canSpawn && (
        <div className="shrink-0 p-3 border-t border-border">
          {canRevive ? (
            <div>
              <Button
                onClick={handleRevive}
                size="sm"
                className="w-full text-xs border bg-active/20 text-active border-active/50 hover:bg-active/30"
              >
                Revive Session
              </Button>
              <p className="text-[10px] text-muted-foreground mt-1">
                Spawns new rclaude in tmux at {session.cwd.split('/').slice(-2).join('/')}
              </p>
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground text-center">
              {agentConnected ? 'Session ended' : 'No host agent connected -- revive unavailable'}
            </p>
          )}
        </div>
      )}

      {/* Revive launch monitor modal */}
      {showReviveMonitor && session && (
        <ReviveMonitor
          sessionId={session.id}
          sessionTitle={session.title}
          cwd={session.cwd}
          onClose={() => setShowReviveMonitor(false)}
        />
      )}
    </div>
  )
})
