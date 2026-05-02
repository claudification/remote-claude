import type { HookEvent } from '@shared/protocol'
import { ArrowLeft } from 'lucide-react'
import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { fetchSubagentTranscript, useConversationsStore } from '@/hooks/use-conversations'
import { type TaskStatus, useProject } from '@/hooks/use-project'
import { canJsonStream, canTerminal, projectPath, type TranscriptEntry } from '@/lib/types'
import { setConversationTab } from '@/lib/ui-state'
import { cn, haptic } from '@/lib/utils'
import { BgTasksView } from './bg-tasks-view'
import { AskQuestionBanners, ClipboardBanners } from './conversation-detail/conversation-banners'
import { ConversationHeader } from './conversation-detail/conversation-header'
import { DialogOverlay, InputBar, ScrollToBottomButton } from './conversation-detail/conversation-input'
import { ConversationTabs, type Tab } from './conversation-detail/conversation-tabs'
import { ConversationView } from './conversation-view'
import { DiagView } from './diag-view'
import { EventsView } from './events-view'
import { FileEditor } from './file-editor'
import { InlineTerminal } from './inline-terminal'
import { JsonStreamPanel } from './json-stream-panel'
import { ProjectBoard, RunTaskDialog, TaskEditor } from './project-board'
import { openReviveDialog } from './revive-dialog'
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

export const ConversationDetail = memo(function SessionDetail() {
  const [activeTab, setActiveTab] = useState<Tab>('transcript')
  const [follow, setFollow] = useState(true)
  const showThinking = useConversationsStore(s => s.controlPanelPrefs.showThinking)
  const showDiag = useConversationsStore(s => s.controlPanelPrefs.showDiag)
  const [conversationTarget, setConversationTarget] = useState<{
    projectA: string
    projectB: string
    nameA: string
    nameB: string
  } | null>(null)
  const disableFollow = useCallback(() => setFollow(false), [])
  const enableFollow = useCallback(() => setFollow(true), [])
  const [infoExpanded, setInfoExpanded] = useState(false)
  const showTerminal = useConversationsStore(state => state.showTerminal)
  const terminalWrapperId = useConversationsStore(state => state.terminalWrapperId)
  const setShowTerminal = useConversationsStore(state => state.setShowTerminal)
  const requestedTab = useConversationsStore(state => state.requestedTab)
  const requestedTabSeq = useConversationsStore(state => state.requestedTabSeq)
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const expandAll = useConversationsStore(state => state.expandAll)

  // Reset follow state on conversation switch
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedConversationId is the trigger dep, setters are stable React dispatch functions
  useEffect(() => {
    setFollow(true)
    setConversationTarget(null)
  }, [selectedConversationId])

  // Apply requested tab - fires on selectConversation (always 'transcript'), openTab, and badge clicks
  // requestedTabSeq ensures re-clicks on the same session still trigger
  // biome-ignore lint/correctness/useExhaustiveDependencies: requestedTabSeq is a counter dep key to re-trigger on same-tab clicks, not accessed in the body
  useEffect(() => {
    if (requestedTab) {
      setActiveTab(requestedTab as Tab)
    }
  }, [requestedTab, requestedTabSeq])

  const session = useConversationsStore(state =>
    state.selectedConversationId ? state.sessionsById[state.selectedConversationId] : undefined,
  )

  // Fall back to transcript if current tab is hidden for ended conversations
  useEffect(() => {
    if (session?.status === 'ended' && (activeTab === 'files' || activeTab === 'project')) {
      setActiveTab('transcript')
    }
  }, [session?.status, activeTab])

  // Persist active tab to localStorage (batched) so it survives reloads
  useEffect(() => {
    if (selectedConversationId) setConversationTab(selectedConversationId, activeTab)
  }, [selectedConversationId, activeTab])
  const { canAdmin, canChat, canReadTerminal, canReadFiles, canFiles, canSpawn } = useConversationsStore(
    useShallow(s => {
      const p = (s.selectedConversationId && s.sessionPermissions[s.selectedConversationId]) || s.permissions
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

  const events = useConversationsStore(state => {
    const tab = activeTabRef.current
    if (tab !== 'events' && tab !== 'transcript' && tab !== 'tty') return EMPTY_EVENTS
    return selectedConversationId ? state.events[selectedConversationId] || EMPTY_EVENTS : EMPTY_EVENTS
  })
  const transcript = useConversationsStore(state => {
    const tab = activeTabRef.current
    if (tab !== 'transcript' && tab !== 'tty') return EMPTY_TRANSCRIPT
    return selectedConversationId ? state.transcripts[selectedConversationId] || EMPTY_TRANSCRIPT : EMPTY_TRANSCRIPT
  })
  const sentinelConnected = useConversationsStore(state => state.sentinelConnected)
  const projectSettings = useConversationsStore(state =>
    session?.project ? state.projectSettings[session.project] : undefined,
  )
  const selectedSubagentId = useConversationsStore(state => state.selectedSubagentId)
  const selectSubagent = useConversationsStore(state => state.selectSubagent)

  // Subagent transcript: store (live WS push) + initial HTTP fetch
  const subagentKey =
    selectedConversationId && selectedSubagentId ? `${selectedConversationId}:${selectedSubagentId}` : ''
  const subagentTranscriptRaw = useConversationsStore(state =>
    subagentKey ? state.subagentTranscripts[subagentKey] : undefined,
  )
  const subagentTranscript = subagentTranscriptRaw || EMPTY_TRANSCRIPT

  const [subagentLoading, setSubagentLoading] = useState(false)

  // Fetch initial subagent transcript via HTTP, seed into store
  useEffect(() => {
    if (!selectedConversationId || !selectedSubagentId) return
    let cancelled = false
    setSubagentLoading(true)
    fetchSubagentTranscript(selectedConversationId, selectedSubagentId).then(entries => {
      if (cancelled) return
      setSubagentLoading(false)
      if (entries.length > 0) {
        const key = `${selectedConversationId}:${selectedSubagentId}`
        useConversationsStore.setState(state => ({
          subagentTranscripts: { ...state.subagentTranscripts, [key]: entries },
        }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [selectedConversationId, selectedSubagentId])

  // @ / t: command palette -> task editor overlay (no tab switch, transcript stays mounted)
  const pendingTaskEdit = useConversationsStore(s => s.pendingTaskEdit)
  const { tasks: projectTasks, readTask, updateTask, moveTask } = useProject(selectedConversationId ?? null)
  const [taskEditorTask, setTaskEditorTask] = useState<import('@/hooks/use-project').ProjectTask | null>(null)
  const [runTaskFromEditor, setRunTaskFromEditor] = useState<import('@/hooks/use-project').ProjectTask | null>(null)
  useEffect(() => {
    if (!pendingTaskEdit) return
    useConversationsStore.getState().setPendingTaskEdit(null)
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

  // Plan mode: trust broker state (set by session_update from wrapper).
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
  const hasJsonStream = session ? canJsonStream(session) : false
  const canRevive = session?.status === 'ended' && sentinelConnected && canSpawn

  function handleRevive() {
    if (!selectedConversationId) return
    haptic('tap')
    openReviveDialog({ conversationId: selectedConversationId })
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
      {/* Permission + Link Request banners are rendered inline at the transcript
          bottom (see TranscriptView) as blocking UI gates, not here in the header. */}
      {/* AskUserQuestion Banners */}
      <AskQuestionBanners />
      {/* Clipboard Capture Banners */}
      <ClipboardBanners />
      {/* Share banner - always visible when shares active (admin only) */}
      {canAdmin && session && <ShareBanner sessionProject={projectPath(session.project)} />}
      {/* Dialog Modal */}
      {selectedConversationId && <DialogOverlay conversationId={selectedConversationId} />}
      {/* Task Editor Modal (from @ / t: command palette, renders over any tab) */}
      {taskEditorTask && selectedConversationId && (
        <TaskEditor
          task={taskEditorTask}
          sessionId={selectedConversationId}
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
      {runTaskFromEditor && selectedConversationId && (
        <RunTaskDialog
          task={runTaskFromEditor}
          sessionId={selectedConversationId}
          onClose={() => setRunTaskFromEditor(null)}
        />
      )}
      {/* Session Info - Collapsible */}
      <ConversationHeader
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
              <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
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
                    onReachedBottom={enableFollow}
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
          <ConversationTabs
            session={session}
            activeTab={activeTab}
            onSetActiveTab={setActiveTab}
            hasTerminal={hasTerminal}
            hasJsonStream={hasJsonStream}
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
                projectA={conversationTarget.projectA}
                projectB={conversationTarget.projectB}
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
                key={selectedConversationId}
                entries={transcript}
                follow={follow}
                showThinking={showThinking}
                onUserScroll={disableFollow}
                onReachedBottom={enableFollow}
              />
              {!follow && transcript.length > 0 && <ScrollToBottomButton onClick={enableFollow} direction="down" />}
            </TranscriptDropZone>
          )}
          {activeTab === 'tty' && hasTerminal && !showTerminal && session.ccSessionIds?.[0] && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <InlineTerminal conversationId={session.ccSessionIds[0]} />
            </div>
          )}
          {activeTab === 'json_stream' && hasJsonStream && session.ccSessionIds?.[0] && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <JsonStreamPanel conversationId={session.ccSessionIds[0]} />
            </div>
          )}
          {!conversationTarget && activeTab === 'events' && (
            <div className="flex-1 min-h-0 overflow-hidden relative">
              <EventsView
                key={selectedConversationId}
                events={events}
                follow={follow}
                onUserScroll={disableFollow}
                onReachedTop={enableFollow}
              />
              {!follow && events.length > 0 && <ScrollToBottomButton onClick={enableFollow} direction="up" />}
            </div>
          )}
          {!conversationTarget && activeTab === 'agents' && selectedConversationId && (
            <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 space-y-4">
              <SubagentView conversationId={selectedConversationId} />
              {session.bgTasks.length > 0 && (
                <>
                  <div className="border-t border-border pt-3">
                    <h3 className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider mb-2">
                      Background Tasks
                    </h3>
                  </div>
                  <BgTasksView conversationId={selectedConversationId} />
                </>
              )}
            </div>
          )}
          {!conversationTarget && activeTab === 'tasks' && selectedConversationId && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <TasksView conversationId={selectedConversationId} pendingCount={session.pendingTaskCount} />
            </div>
          )}
          {!conversationTarget && activeTab === 'files' && selectedConversationId && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <FileEditor conversationId={selectedConversationId} />
            </div>
          )}
          {!conversationTarget && activeTab === 'project' && selectedConversationId && (
            <div className="flex-1 min-h-0 overflow-hidden">
              <ProjectBoard sessionId={selectedConversationId} />
            </div>
          )}
          {!conversationTarget && activeTab === 'shared' && session && (
            <SharedView projectPath={projectPath(session.project)} />
          )}
          {!conversationTarget && activeTab === 'diag' && selectedConversationId && (
            <DiagView conversationId={selectedConversationId} />
          )}
        </>
      )}

      {/* Input box - isolated to prevent transcript rerenders on typing */}
      {!conversationTarget &&
        canSendInput &&
        (activeTab === 'transcript' || (activeTab === 'tty' && !hasTerminal)) &&
        !selectedSubagentId &&
        selectedConversationId && <InputBar conversationId={selectedConversationId} />}

      {/* Terminal overlay - routed by conversationId (physical PTY) */}
      {showTerminal && terminalWrapperId && (
        <Suspense
          fallback={
            <div className="absolute inset-0 flex items-center justify-center bg-background text-muted-foreground">
              Loading terminal...
            </div>
          }
        >
          <WebTerminal
            conversationId={terminalWrapperId}
            onClose={() => {
              setShowTerminal(false)
              const store = useConversationsStore.getState()
              if (store.selectedConversationId) store.openTab(store.selectedConversationId, 'transcript')
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
                Spawns new rclaude in tmux at {projectPath(session.project).split('/').slice(-2).join('/')}
              </p>
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground text-center">
              {sentinelConnected ? 'Session ended' : 'No sentinel connected -- revive unavailable'}
            </p>
          )}
        </div>
      )}
    </div>
  )
})
