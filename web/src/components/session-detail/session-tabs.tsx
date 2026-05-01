import { Braces, Terminal } from 'lucide-react'
import type { ReactNode } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { useConversationsStore } from '@/hooks/use-sessions'
import type { Session } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'

export type Tab =
  | 'transcript'
  | 'tty'
  | 'json_stream'
  | 'events'
  | 'agents'
  | 'tasks'
  | 'files'
  | 'shared'
  | 'project'
  | 'diag'

interface SessionTabsProps {
  session: Session
  activeTab: Tab
  onSetActiveTab: (tab: Tab) => void
  hasTerminal: boolean
  hasJsonStream: boolean
  canAdmin: boolean
  canReadTerminal: boolean
  canReadFiles: boolean
  showDiag: boolean
  expandAll: boolean
}

interface TabButtonProps {
  active: boolean
  onClick: (event: React.MouseEvent) => void
  children: ReactNode
  title?: string
  /** Extra classes for the button (beyond the shared tab shape). */
  className?: string
}

function TabButton({ active, onClick, children, title, className }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
        active ? 'border-accent text-accent' : 'border-transparent text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** Tap-to-switch handler factory with haptic feedback. Not a hook -- plain function. */
function tabClickHandler(target: Tab, onSetActiveTab: (tab: Tab) => void) {
  return () => {
    haptic('tick')
    onSetActiveTab(target)
  }
}

export function SessionTabs({
  session,
  activeTab,
  onSetActiveTab,
  hasTerminal,
  hasJsonStream,
  canAdmin,
  canReadTerminal,
  canReadFiles,
  showDiag,
  expandAll,
}: SessionTabsProps) {
  return (
    <div className="shrink-0 flex items-center border-b border-border overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
      <TabButton active={activeTab === 'transcript'} onClick={tabClickHandler('transcript', onSetActiveTab)}>
        Transcript
      </TabButton>

      {hasTerminal && canReadTerminal && (
        <TabButton
          active={activeTab === 'tty'}
          className="flex items-center gap-1"
          title="Terminal (Shift+click to pop out)"
          onClick={e => {
            if (e.shiftKey) {
              const wid = session?.conversationIds?.[0]
              if (wid) window.open(`/#popout-terminal/${wid}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no')
            } else {
              haptic('tick')
              onSetActiveTab(activeTab === 'tty' ? 'transcript' : 'tty')
            }
          }}
        >
          <Terminal className="w-3 h-3" />
          TTY
        </TabButton>
      )}

      {hasJsonStream && canReadTerminal && (
        <TabButton
          active={activeTab === 'json_stream'}
          className="flex items-center gap-1"
          onClick={() => {
            haptic('tick')
            onSetActiveTab(activeTab === 'json_stream' ? 'transcript' : 'json_stream')
          }}
        >
          <Braces className="w-3 h-3" />
          JSON
        </TabButton>
      )}

      {canAdmin && (
        <TabButton active={activeTab === 'events'} onClick={tabClickHandler('events', onSetActiveTab)}>
          Events
        </TabButton>
      )}

      {canAdmin &&
        (session.totalSubagentCount > 0 || session.activeSubagentCount > 0 || session.bgTasks.length > 0) && (
          <TabButton active={activeTab === 'agents'} onClick={tabClickHandler('agents', onSetActiveTab)}>
            Agents
            {(session.activeSubagentCount > 0 || session.runningBgTaskCount > 0) && (
              <span className="ml-1.5 px-1.5 py-0.5 bg-active/20 text-active text-[10px] font-bold">
                {session.activeSubagentCount + session.runningBgTaskCount}
              </span>
            )}
          </TabButton>
        )}

      {(session.taskCount > 0 || (session.archivedTaskCount ?? 0) > 0) && (
        <TabButton active={activeTab === 'tasks'} onClick={tabClickHandler('tasks', onSetActiveTab)}>
          Tasks
          {session.pendingTaskCount > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 bg-amber-500/20 text-amber-400 text-[10px] font-bold">
              {session.pendingTaskCount}
            </span>
          )}
        </TabButton>
      )}

      {canReadFiles && session.status !== 'ended' && (
        <TabButton active={activeTab === 'files'} onClick={tabClickHandler('files', onSetActiveTab)}>
          Files
        </TabButton>
      )}

      {session.status !== 'ended' && (
        <TabButton active={activeTab === 'project'} onClick={tabClickHandler('project', onSetActiveTab)}>
          Project
        </TabButton>
      )}

      <TabButton active={activeTab === 'shared'} onClick={tabClickHandler('shared', onSetActiveTab)}>
        Shared
      </TabButton>

      {canAdmin && showDiag && (
        <TabButton active={activeTab === 'diag'} onClick={tabClickHandler('diag', onSetActiveTab)}>
          Diag
        </TabButton>
      )}

      {/* Follow/verbose - pushed to right */}
      <div className="ml-auto pr-3 flex items-center gap-2">
        <div className="w-px h-4 bg-border" />
      </div>
      {canAdmin && (
        <div className="pr-3 hidden sm:flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Checkbox
              id="verbose"
              checked={expandAll}
              onCheckedChange={checked => {
                if (checked !== expandAll) useConversationsStore.getState().toggleExpandAll()
              }}
              className="h-3.5 w-3.5"
            />
            <label htmlFor="verbose" className="text-[10px] text-muted-foreground cursor-pointer select-none">
              verbose
            </label>
          </div>
        </div>
      )}
    </div>
  )
}
