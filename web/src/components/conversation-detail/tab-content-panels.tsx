import type { HookEvent } from '@shared/protocol'
import { lazy, Suspense } from 'react'
import { type Conversation, projectPath, type TranscriptEntry } from '@/lib/types'
import { cn } from '@/lib/utils'
import { BgTasksView } from '../bg-tasks-view'
import { ConversationView } from '../conversation-view'
import { DiagView } from '../diag-view'
import { EventsView } from '../events-view'
import { FileEditor } from '../file-editor'
import { JsonStreamPanel } from '../json-stream-panel'
import { ProjectBoard } from '../project-board'
import { SharedView } from '../shared-view'
import { SubagentView } from '../subagent-view'
import { TasksView } from '../tasks-view'
import { TranscriptDropZone, TranscriptView } from '../transcript'
import { ScrollToBottomButton } from './conversation-input'
import type { Tab } from './conversation-tabs'

const InlineTerminal = lazy(() => import('../inline-terminal').then(m => ({ default: m.InlineTerminal })))

interface ConversationTarget {
  projectA: string
  projectB: string
  nameA: string
  nameB: string
}

interface TabContentPanelsProps {
  conversation: Conversation
  activeTab: Tab
  selectedConversationId: string
  transcript: TranscriptEntry[]
  events: HookEvent[]
  follow: boolean
  showThinking: boolean
  inPlanMode: boolean
  hasTerminal: boolean
  hasJsonStream: boolean
  showTerminal: boolean
  canSendInput: boolean
  canFiles: boolean
  conversationTarget: ConversationTarget | null
  onClearConversationTarget: () => void
  onDisableFollow: () => void
  onEnableFollow: () => void
}

export function TabContentPanels({
  conversation,
  activeTab,
  selectedConversationId,
  transcript,
  events,
  follow,
  showThinking,
  inPlanMode,
  hasTerminal,
  hasJsonStream,
  showTerminal,
  canSendInput,
  canFiles,
  conversationTarget,
  onClearConversationTarget,
  onDisableFollow,
  onEnableFollow,
}: TabContentPanelsProps) {
  return (
    <>
      {conversationTarget && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <ConversationView
            projectA={conversationTarget.projectA}
            projectB={conversationTarget.projectB}
            nameA={conversationTarget.nameA}
            nameB={conversationTarget.nameB}
            onBack={onClearConversationTarget}
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
            cacheKey={selectedConversationId}
            entries={transcript}
            follow={follow}
            showThinking={showThinking}
            onUserScroll={onDisableFollow}
            onReachedBottom={onEnableFollow}
          />
          {!follow && transcript.length > 0 && <ScrollToBottomButton onClick={onEnableFollow} direction="down" />}
        </TranscriptDropZone>
      )}
      {activeTab === 'tty' && hasTerminal && !showTerminal && conversation.connectionIds?.[0] && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <Suspense fallback={null}>
            <InlineTerminal conversationId={conversation.connectionIds[0]} />
          </Suspense>
        </div>
      )}
      {activeTab === 'json_stream' && hasJsonStream && conversation.connectionIds?.[0] && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <JsonStreamPanel conversationId={conversation.connectionIds[0]} />
        </div>
      )}
      {!conversationTarget && activeTab === 'events' && (
        <div className="flex-1 min-h-0 overflow-hidden relative">
          <EventsView
            key={selectedConversationId}
            events={events}
            follow={follow}
            onUserScroll={onDisableFollow}
            onReachedTop={onEnableFollow}
          />
          {!follow && events.length > 0 && <ScrollToBottomButton onClick={onEnableFollow} direction="up" />}
        </div>
      )}
      {!conversationTarget && activeTab === 'agents' && selectedConversationId && (
        <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 space-y-4">
          <SubagentView conversationId={selectedConversationId} />
          {conversation.bgTasks.length > 0 && (
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
          <TasksView conversationId={selectedConversationId} pendingCount={conversation.pendingTaskCount} />
        </div>
      )}
      {!conversationTarget && activeTab === 'files' && selectedConversationId && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <FileEditor conversationId={selectedConversationId} />
        </div>
      )}
      {!conversationTarget && activeTab === 'project' && selectedConversationId && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <ProjectBoard conversationId={selectedConversationId} />
        </div>
      )}
      {!conversationTarget && activeTab === 'shared' && conversation && (
        <SharedView projectPath={projectPath(conversation.project)} />
      )}
      {!conversationTarget && activeTab === 'diag' && selectedConversationId && (
        <DiagView conversationId={selectedConversationId} />
      )}
    </>
  )
}
