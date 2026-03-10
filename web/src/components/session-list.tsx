import { useEffect, useState } from 'react'
import { fetchSessionEvents, fetchTranscript, useSessionsStore } from '@/hooks/use-sessions'
import type { Session } from '@/lib/types'
import { cn, formatAge, formatModel, lastPathSegments } from '@/lib/utils'
import { ProjectSettingsButton, ProjectSettingsEditor, renderProjectIcon } from './project-settings-editor'
import { usePrefs } from './settings-page'

function StatusIndicator({ status, lastActivity }: { status: Session['status']; lastActivity?: number }) {
  if (status === 'ended') {
    return <span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-ended text-foreground">ended</span>
  }
  // Active with recent activity (last 4 min) gets a spinning work indicator
  if (status === 'active' && lastActivity && Date.now() - lastActivity < 4 * 60 * 1000) {
    return (
      <span className="w-3 h-3 shrink-0 flex items-center justify-center" title="working">
        <span className="w-2.5 h-2.5 border-2 border-active border-t-transparent rounded-full animate-spin" />
      </span>
    )
  }
  // Server determines idle status via idleTimeoutMinutes setting
  return (
    <span className={cn('w-2 h-2 rounded-full shrink-0', status === 'idle' ? 'bg-idle' : 'bg-active')} title={status} />
  )
}

function SessionItemContent({ session, compact }: { session: Session; compact?: boolean }) {
  const {
    selectedSessionId,
    selectedSubagentId,
    selectSession,
    selectSubagent,
    openTab,
    setEvents,
    setTranscript,
    events,
    projectSettings,
  } = useSessionsStore()
  const isSelected = selectedSessionId === session.id
  const cachedEvents = events[session.id] || []
  const model = cachedEvents.find(e => e.hookEvent === 'SessionStart' && e.data?.model)?.data?.model as
    | string
    | undefined
  const ps = projectSettings[session.cwd]

  async function handleClick() {
    selectSession(session.id)
    const [evts, transcript] = await Promise.all([fetchSessionEvents(session.id), fetchTranscript(session.id)])
    setEvents(session.id, evts)
    setTranscript(session.id, transcript)
  }

  const displayName = ps?.label || lastPathSegments(session.cwd)
  const displayColor = ps?.color

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'w-full text-left border transition-colors group',
        compact ? 'p-2 pl-4 text-[11px]' : 'p-3',
        isSelected
          ? 'border-accent bg-accent/15 ring-1 ring-accent/50 shadow-[0_0_8px_rgba(122,162,247,0.15)]'
          : displayColor
            ? 'border-border hover:border-primary'
            : 'border-border hover:border-primary hover:bg-card',
      )}
      style={
        displayColor && !isSelected
          ? { borderLeftColor: displayColor, borderLeftWidth: '3px', backgroundColor: `${displayColor}15` }
          : undefined
      }
      title={`${session.id}\n${formatModel(model || session.model)}`}
    >
      {/* Path - most important */}
      {!compact && (
        <div className="flex items-center gap-1.5">
          <StatusIndicator status={session.status} lastActivity={session.lastActivity} />
          {ps?.icon && (
            <span style={displayColor && !isSelected ? { color: displayColor } : undefined}>
              {renderProjectIcon(ps.icon)}
            </span>
          )}
          <span
            className={cn('font-bold text-sm flex-1 truncate', isSelected ? 'text-accent' : 'text-primary')}
            style={displayColor && !isSelected ? { color: displayColor } : undefined}
          >
            {displayName}
          </span>
          {session.compacting && (
            <span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-amber-400/20 text-amber-400 border border-amber-400/50 animate-pulse">
              compacting
            </span>
          )}
        </div>
      )}
      {compact && (
        <div className="flex items-center gap-1.5">
          <StatusIndicator status={session.status} lastActivity={session.lastActivity} />
          <span
            className={cn(
              'font-mono text-[11px] flex-1 truncate',
              isSelected ? 'text-accent' : 'text-muted-foreground',
            )}
          >
            {session.id.slice(0, 8)}
          </span>
          {session.compacting && <span className="text-[9px] text-amber-400 font-bold animate-pulse">COMPACT</span>}
        </div>
      )}
      {/* Active tasks + pending tasks + subagents + working teammates */}
      {(session.activeTasks.length > 0 ||
        session.pendingTasks.length > 0 ||
        session.subagents.length > 0 ||
        session.teammates.some(t => t.status === 'working')) && (
        <div className="mt-1 space-y-0.5">
          {session.activeTasks.slice(0, 3).map(task => (
            <div key={task.id} className="text-[11px] text-active/80 font-mono truncate pl-1">
              <span className="text-active mr-1">{'\u25B8'}</span>
              {task.subject}
            </div>
          ))}
          {session.activeTasks.length > 3 && (
            <div className="text-[10px] text-muted-foreground pl-1 font-mono">
              +{session.activeTasks.length - 3} more
            </div>
          )}
          {session.pendingTasks.slice(0, 4).map(task => (
            <div key={task.id} className="text-[11px] text-amber-400/50 font-mono truncate pl-1">
              <span className="text-amber-400/40 mr-1">{'\u25CB'}</span>
              {task.subject}
            </div>
          ))}
          {session.subagents
            .filter(a => a.status === 'running')
            .map(a => (
              <div
                key={a.agentId}
                className={cn(
                  'text-[11px] text-pink-400/80 font-mono truncate pl-1 cursor-pointer hover:text-pink-300',
                  selectedSubagentId === a.agentId && 'text-pink-300 font-bold',
                )}
                onClick={e => {
                  e.stopPropagation()
                  selectSession(session.id)
                  selectSubagent(a.agentId)
                }}
              >
                <span className="text-pink-400 mr-1">{'\u25CF'}</span>
                {a.description || a.agentType} <span className="text-pink-400/50">{a.agentId.slice(0, 6)}</span>
              </div>
            ))}
          {session.subagents
            .filter(a => a.status === 'stopped' && a.stoppedAt && Date.now() - a.stoppedAt < 30 * 60 * 1000)
            .map(a => (
              <div
                key={a.agentId}
                className={cn(
                  'text-[11px] text-pink-400/40 font-mono truncate pl-1 cursor-pointer hover:text-pink-400/70',
                  selectedSubagentId === a.agentId && 'text-pink-400/80 font-bold',
                )}
                onClick={e => {
                  e.stopPropagation()
                  selectSession(session.id)
                  selectSubagent(a.agentId)
                }}
              >
                <span className="mr-1">{'\u25CB'}</span>
                {a.description || a.agentType} <span className="text-pink-400/30">{a.agentId.slice(0, 6)}</span>
              </div>
            ))}
          {session.teammates
            .filter(t => t.status === 'working')
            .map(t => (
              <div key={t.name} className="text-[11px] text-purple-400/80 font-mono truncate pl-1">
                <span className="text-purple-400 mr-1">{'\u2691'}</span>
                {t.name}
                {t.currentTaskSubject ? `: ${t.currentTaskSubject}` : ''}
              </div>
            ))}
        </div>
      )}
      {/* Status row (non-compact only, only if there's something to show) */}
      {!compact &&
        (session.status === 'ended' ||
          session.pendingTaskCount > 0 ||
          session.runningBgTaskCount > 0 ||
          session.team) && (
          <div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
            {session.status === 'ended' && (
              <StatusIndicator status={session.status} lastActivity={session.lastActivity} />
            )}
            {session.pendingTaskCount > 0 && (
              <span
                className="px-1.5 py-0.5 bg-amber-400/20 text-amber-400 border border-amber-400/50 text-[10px] font-bold cursor-pointer hover:bg-amber-400/30"
                onClick={e => {
                  e.stopPropagation()
                  openTab(session.id, 'tasks')
                }}
              >
                [{session.pendingTaskCount}] task{session.pendingTaskCount !== 1 ? 's' : ''}
              </span>
            )}
            {session.runningBgTaskCount > 0 && (
              <span
                className="px-1.5 py-0.5 bg-emerald-400/20 text-emerald-400 border border-emerald-400/50 text-[10px] font-bold cursor-pointer hover:bg-emerald-400/30"
                onClick={e => {
                  e.stopPropagation()
                  openTab(session.id, 'agents')
                }}
              >
                [{session.runningBgTaskCount}] bg
              </span>
            )}
            {session.team && (
              <span className="px-1.5 py-0.5 bg-purple-400/20 text-purple-400 border border-purple-400/50 text-[10px] font-bold uppercase">
                {session.team.role === 'lead' ? 'LEAD' : 'TEAM'} {session.team.teamName}
                {session.teammates.length > 0 &&
                  ` (${session.teammates.filter(t => t.status !== 'stopped').length}/${session.teammates.length})`}
              </span>
            )}
          </div>
        )}
    </button>
  )
}

function SessionItem({ session }: { session: Session }) {
  const [showSettings, setShowSettings] = useState(false)

  return (
    <div>
      <div className="relative">
        <SessionItemContent session={session} />
        <div className="absolute top-2 right-2">
          <ProjectSettingsButton
            onClick={e => {
              e.stopPropagation()
              setShowSettings(!showSettings)
            }}
          />
        </div>
      </div>
      {showSettings && <ProjectSettingsEditor cwd={session.cwd} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

function SessionGroup({
  sessions,
  name,
  ps,
}: {
  sessions: Session[]
  name: string
  ps?: { label?: string; icon?: string; color?: string }
}) {
  const [showSettings, setShowSettings] = useState(false)
  const displayColor = ps?.color
  const cwd = sessions[0].cwd

  return (
    <div>
      <div
        className="border border-border"
        style={displayColor ? { borderLeftColor: displayColor, borderLeftWidth: '3px' } : undefined}
      >
        {/* Group header */}
        <div className="flex items-center gap-1.5 p-3 pb-1">
          {ps?.icon && (
            <span style={displayColor ? { color: displayColor } : undefined}>{renderProjectIcon(ps.icon)}</span>
          )}
          <span
            className="font-bold text-sm flex-1 truncate text-primary"
            style={displayColor ? { color: displayColor } : undefined}
          >
            {name}
          </span>
          <span className="text-[10px] text-muted-foreground font-mono">{sessions.length} sessions</span>
          <ProjectSettingsButton
            onClick={e => {
              e.stopPropagation()
              setShowSettings(!showSettings)
            }}
          />
        </div>
        {/* Sub-sessions */}
        <div className="space-y-0.5 pb-1">
          {sessions.map(session => (
            <SessionItemContent key={session.id} session={session} compact />
          ))}
        </div>
      </div>
      {showSettings && <ProjectSettingsEditor cwd={cwd} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

// Inactive project entry - one per cwd, shows latest session
function InactiveProjectItem({ sessions }: { sessions: Session[] }) {
  const { selectSession, setEvents, setTranscript, projectSettings } = useSessionsStore()
  // Latest session by lastActivity
  const latest = sessions.reduce((a, b) => (a.lastActivity > b.lastActivity ? a : b))
  const ps = projectSettings[latest.cwd]
  const displayName = ps?.label || lastPathSegments(latest.cwd)
  const displayColor = ps?.color

  async function handleClick() {
    selectSession(latest.id)
    const [evts, transcript] = await Promise.all([fetchSessionEvents(latest.id), fetchTranscript(latest.id)])
    setEvents(latest.id, evts)
    setTranscript(latest.id, transcript)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="w-full text-left border border-border hover:border-primary p-2 pl-3 transition-colors"
      style={displayColor ? { borderLeftColor: displayColor, borderLeftWidth: '3px' } : undefined}
      title={`${sessions.length} session${sessions.length > 1 ? 's' : ''}\n${latest.cwd}`}
    >
      <div className="flex items-center gap-1.5">
        {ps?.icon && (
          <span className="text-muted-foreground" style={displayColor ? { color: displayColor } : undefined}>
            {renderProjectIcon(ps.icon)}
          </span>
        )}
        <span
          className="font-mono text-xs text-muted-foreground truncate flex-1"
          style={displayColor ? { color: `${displayColor}99` } : undefined}
        >
          {displayName}
        </span>
        <span className="text-[10px] text-muted-foreground/60 font-mono shrink-0">
          {formatAge(latest.lastActivity)}
        </span>
      </div>
    </button>
  )
}

export function SessionList() {
  const { sessions, projectSettings } = useSessionsStore()
  const { prefs } = usePrefs()
  const [showInactive, setShowInactive] = useState(prefs.showInactiveByDefault)
  const [filter, setFilter] = useState('')
  // Periodic tick to re-evaluate time-based visibility (spinner, 10min cutoff)
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const matchesFilter = (s: Session) => {
    if (!filter) return true
    const ps = projectSettings[s.cwd]
    const name = ps?.label || s.cwd
    return name.toLowerCase().includes(filter.toLowerCase())
  }

  const active = sessions.filter(s => (s.status === 'active' || s.status === 'idle') && matchesFilter(s))
  const activeCwds = new Set(active.map(s => s.cwd))
  const inactive = sessions.filter(
    s => s.status !== 'active' && s.status !== 'idle' && !activeCwds.has(s.cwd) && matchesFilter(s),
  )

  const sorted = [...active].sort((a, b) => b.startedAt - a.startedAt)
  const sortedInactive = [...inactive].sort((a, b) => b.startedAt - a.startedAt)

  // Group sessions by display name (cwd)
  function groupSessions(list: Session[]) {
    const groups = new Map<string, Session[]>()
    for (const s of list) {
      const ps = projectSettings[s.cwd]
      const key = ps?.label || s.cwd
      const group = groups.get(key) || []
      group.push(s)
      groups.set(key, group)
    }
    return groups
  }

  function renderGrouped(list: Session[]) {
    const groups = groupSessions(list)
    return Array.from(groups.entries()).map(([name, groupSessions]) => {
      if (groupSessions.length === 1) {
        return <SessionItem key={groupSessions[0].id} session={groupSessions[0]} />
      }
      const ps = projectSettings[groupSessions[0].cwd]
      return (
        <SessionGroup
          key={name}
          sessions={groupSessions}
          name={ps?.label || lastPathSegments(groupSessions[0].cwd)}
          ps={ps}
        />
      )
    })
  }

  if (sessions.length === 0) {
    return (
      <div className="text-muted-foreground text-center py-10">
        <pre className="text-xs mb-4">
          {`
  No sessions yet

  Start a session with:
  $ rclaude
`.trim()}
        </pre>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {sessions.length > 3 && (
        <input
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter sessions..."
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="w-full px-2 py-1.5 text-xs bg-transparent border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent"
        />
      )}
      {renderGrouped(sorted)}
      {inactive.length > 0 && (
        <label className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-xs cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={e => setShowInactive(e.target.checked)}
            className="accent-primary"
          />
          show inactive ({new Set(inactive.map(s => s.cwd)).size})
        </label>
      )}
      {showInactive &&
        (() => {
          // Group inactive sessions by cwd, render one entry per project
          const byCwd = new Map<string, Session[]>()
          for (const s of sortedInactive) {
            const group = byCwd.get(s.cwd) || []
            group.push(s)
            byCwd.set(s.cwd, group)
          }
          return Array.from(byCwd.values()).map(group => <InactiveProjectItem key={group[0].cwd} sessions={group} />)
        })()}
    </div>
  )
}
