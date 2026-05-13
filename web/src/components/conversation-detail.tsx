import type { HookEvent } from '@shared/protocol'
import { memo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConversationsStore } from '@/hooks/use-conversations'
import { canJsonStream, canTerminal, projectPath, type TranscriptEntry } from '@/lib/types'
import { ClipboardBanners } from './conversation-detail/conversation-banners'
import { ConversationHeader } from './conversation-detail/conversation-header'
import { DialogOverlay, InputBar } from './conversation-detail/conversation-input'
import { ConversationTabs } from './conversation-detail/conversation-tabs'
import { EmptyState } from './conversation-detail/empty-state'
import { ProjectActionPanel } from './conversation-detail/project-action-panel'
import { ReviveFooter } from './conversation-detail/revive-footer'
import { SubagentDetailView } from './conversation-detail/subagent-detail-view'
import { TabContentPanels } from './conversation-detail/tab-content-panels'
import { TaskEditorOverlay } from './conversation-detail/task-editor-overlay'
import { TerminalOverlay } from './conversation-detail/terminal-overlay'
import { useConversationTab } from './conversation-detail/use-conversation-tab'
import { useSubagentFetch } from './conversation-detail/use-subagent-fetch'
import { useTaskEditor } from './conversation-detail/use-task-editor'
import { ShareBanner } from './share-panel'

const EMPTY_EVENTS: HookEvent[] = []
const EMPTY_TRANSCRIPT: TranscriptEntry[] = []

export const ConversationDetail = memo(function SessionDetail() {
  const showThinking = useConversationsStore(s => s.controlPanelPrefs.showThinking)
  const showDiag = useConversationsStore(s => s.controlPanelPrefs.showDiag)
  const showTerminal = useConversationsStore(state => state.showTerminal)
  const terminalWrapperId = useConversationsStore(state => state.terminalWrapperId)
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const expandAll = useConversationsStore(state => state.expandAll)

  const session = useConversationsStore(state =>
    state.selectedConversationId ? state.sessionsById[state.selectedConversationId] : undefined,
  )

  const {
    activeTab,
    setActiveTab,
    follow,
    setFollow,
    disableFollow,
    enableFollow,
    infoExpanded,
    setInfoExpanded,
    conversationTarget,
    setConversationTarget,
  } = useConversationTab(selectedConversationId, session?.status)

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

  const { selectedSubagentId, selectSubagent, subagentTranscript, subagentLoading } =
    useSubagentFetch(selectedConversationId)
  const { taskEditorTask, runTaskFromEditor, updateTask, moveTask, setRunTaskFromEditor, setTaskEditorTask } =
    useTaskEditor(selectedConversationId ?? null)

  const inPlanMode = session?.planMode ?? false

  const selectedProjectUri = useConversationsStore(state => state.selectedProjectUri)

  if (!session) {
    if (selectedProjectUri) return <ProjectActionPanel projectUri={selectedProjectUri} />
    return <EmptyState />
  }

  const model = (events.find(e => e.hookEvent === 'SessionStart')?.data as { model?: string } | undefined)?.model
  const canSendInput = session.status !== 'ended' && canChat
  const hasTerminal = canTerminal(session)
  const hasJsonStream = canJsonStream(session)
  const canRevive = session.status === 'ended' && sentinelConnected && canSpawn

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
      <ClipboardBanners />
      {canAdmin && session && <ShareBanner conversationProject={projectPath(session.project)} conversationId={session.id} />}
      {selectedConversationId && <DialogOverlay conversationId={selectedConversationId} />}

      {selectedConversationId && (
        <TaskEditorOverlay
          conversationId={selectedConversationId}
          taskEditorTask={taskEditorTask}
          runTaskFromEditor={runTaskFromEditor}
          onUpdateTask={updateTask}
          onMoveTask={moveTask}
          onRunTask={setRunTaskFromEditor}
          onCloseEditor={() => setTaskEditorTask(null)}
          onCloseRunDialog={() => setRunTaskFromEditor(null)}
          onSetTaskEditorTask={setTaskEditorTask}
        />
      )}

      <ConversationHeader
        session={session}
        projectSettings={projectSettings}
        model={model}
        inPlanMode={inPlanMode}
        infoExpanded={infoExpanded}
        onToggleExpanded={() => setInfoExpanded(!infoExpanded)}
        onSetConversationTarget={setConversationTarget}
      />

      {selectedSubagentId && (
        <SubagentDetailView
          subagent={session.subagents.find(a => a.agentId === selectedSubagentId)}
          subagentId={selectedSubagentId}
          transcript={subagentTranscript}
          loading={subagentLoading}
          showThinking={showThinking}
          follow={follow}
          onBack={() => {
            selectSubagent(null)
            setFollow(true)
          }}
          onUserScroll={disableFollow}
          onReachedBottom={enableFollow}
        />
      )}

      {!selectedSubagentId && (
        <>
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

          <TabContentPanels
            session={session}
            activeTab={activeTab}
            selectedConversationId={selectedConversationId!}
            transcript={transcript}
            events={events}
            follow={follow}
            showThinking={showThinking}
            inPlanMode={inPlanMode}
            hasTerminal={hasTerminal}
            hasJsonStream={hasJsonStream}
            showTerminal={showTerminal}
            canSendInput={canSendInput}
            canFiles={canFiles}
            conversationTarget={conversationTarget}
            onClearConversationTarget={() => setConversationTarget(null)}
            onDisableFollow={disableFollow}
            onEnableFollow={enableFollow}
          />
        </>
      )}

      {!conversationTarget &&
        canSendInput &&
        (activeTab === 'transcript' || (activeTab === 'tty' && !hasTerminal)) &&
        !selectedSubagentId &&
        selectedConversationId && <InputBar conversationId={selectedConversationId} />}

      {showTerminal && terminalWrapperId && <TerminalOverlay conversationId={terminalWrapperId} />}

      {session.status === 'ended' && canSpawn && (
        <ReviveFooter
          conversationId={selectedConversationId!}
          project={session.project}
          sentinelConnected={sentinelConnected}
          canRevive={!!canRevive}
          backend={session.backend}
        />
      )}
    </div>
  )
})
