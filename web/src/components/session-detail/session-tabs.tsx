import { Terminal } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { useSessionsStore } from '@/hooks/use-sessions'
import { cn, haptic } from '@/lib/utils'
import type { Session } from '@/lib/types'

export type Tab = 'transcript' | 'tty' | 'events' | 'agents' | 'tasks' | 'files' | 'shared' | 'project' | 'diag'

export interface SessionTabsProps {
  session: Session
  activeTab: Tab
  onSetActiveTab: (tab: Tab) => void
  hasTerminal: boolean
  canAdmin: boolean
  canReadTerminal: boolean
  canReadFiles: boolean
  showDiag: boolean
  expandAll: boolean
}

export function SessionTabs({
  session,
  activeTab,
  onSetActiveTab,
  hasTerminal,
  canAdmin,
  canReadTerminal,
  canReadFiles,
  showDiag,
  expandAll,
}: SessionTabsProps) {
  return (
    <div className="shrink-0 flex items-center border-b border-border overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
      <button
        type="button"
        onClick={() => {
          haptic('tick')
          onSetActiveTab('transcript')
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
      {hasTerminal && canReadTerminal && (
        <button
          type="button"
          onClick={e => {
            if (e.shiftKey) {
              const wid = session?.wrapperIds?.[0]
              if (wid)
                window.open(`/#popout-terminal/${wid}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no')
            } else {
              haptic('tick')
              onSetActiveTab(activeTab === 'tty' ? 'transcript' : 'tty')
            }
          }}
          className={cn(
            'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors flex items-center gap-1',
            activeTab === 'tty'
              ? 'border-accent text-accent'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
          title="Terminal (Shift+click to pop out)"
        >
          <Terminal className="w-3 h-3" />
          TTY
        </button>
      )}
      {canAdmin && (
        <button
          type="button"
          onClick={() => {
            haptic('tick')
            onSetActiveTab('events')
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
      )}
      {canAdmin &&
        (session.totalSubagentCount > 0 || session.activeSubagentCount > 0 || session.bgTasks.length > 0) && (
          <button
            type="button"
            onClick={() => {
              haptic('tick')
              onSetActiveTab('agents')
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
            onSetActiveTab('tasks')
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
      {canReadFiles && session.status !== 'ended' && (
        <button
          type="button"
          onClick={() => {
            haptic('tick')
            onSetActiveTab('files')
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
      {session.status !== 'ended' && (
        <button
          type="button"
          onClick={() => {
            haptic('tick')
            onSetActiveTab('project')
          }}
          className={cn(
            'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
            activeTab === 'project'
              ? 'border-accent text-accent'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          Project
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          haptic('tick')
          onSetActiveTab('shared')
        }}
        className={cn(
          'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
          activeTab === 'shared'
            ? 'border-accent text-accent'
            : 'border-transparent text-muted-foreground hover:text-foreground',
        )}
      >
        Shared
      </button>
      {canAdmin && showDiag && (
        <button
          type="button"
          onClick={() => {
            haptic('tick')
            onSetActiveTab('diag')
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
                if (checked !== expandAll) useSessionsStore.getState().toggleExpandAll()
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
