import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { HookEvent } from '@shared/protocol'
import { useEffect, useState } from 'react'
import { updateSessionOrder, useSessionsStore } from '@/hooks/use-sessions'
import type { Session } from '@/lib/types'
import { cn, formatAge, formatModel, haptic, lastPathSegments } from '@/lib/utils'
import { ProjectSettingsButton, ProjectSettingsEditor, renderProjectIcon } from './project-settings-editor'

function StatusIndicator({ status }: { status: Session['status'] }) {
  if (status === 'ended') {
    return <span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-ended text-foreground">ended</span>
  }
  if (status === 'active') {
    return (
      <span className="w-3 h-3 shrink-0 flex items-center justify-center" title="working">
        <span
          className="w-2.5 h-2.5 rounded-full animate-spin"
          style={{ border: '2px solid var(--active)', borderTopColor: 'transparent' }}
        />
      </span>
    )
  }
  return <span className="w-2 h-2 rounded-full shrink-0 bg-idle" title={status} />
}

const EMPTY_EVENTS: HookEvent[] = []

function SessionItemContent({ session, compact }: { session: Session; compact?: boolean }) {
  const selectedSessionId = useSessionsStore(s => s.selectedSessionId)
  const selectedSubagentId = useSessionsStore(s => s.selectedSubagentId)
  const selectSession = useSessionsStore(s => s.selectSession)
  const selectSubagent = useSessionsStore(s => s.selectSubagent)
  const openTab = useSessionsStore(s => s.openTab)
  const cachedEvents = useSessionsStore(s => s.events[session.id] || EMPTY_EVENTS)
  const ps = useSessionsStore(s => s.projectSettings[session.cwd])
  const isSelected = selectedSessionId === session.id
  const sessionStartEvent = cachedEvents.find(e => e.hookEvent === 'SessionStart')
  const model = (sessionStartEvent?.data as { model?: string } | undefined)?.model

  function handleClick() {
    haptic('tap')
    selectSession(session.id)
  }

  const displayName = ps?.label || lastPathSegments(session.cwd)
  const displayColor = ps?.color

  return (
    <div
      onClick={handleClick}
      className={cn(
        'w-full text-left border transition-colors group cursor-pointer',
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
      {!compact && (
        <div className="flex items-center gap-1.5">
          <StatusIndicator status={session.status} />
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
          <StatusIndicator status={session.status} />
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
      {(session.activeTasks.length > 0 ||
        session.pendingTasks.length > 0 ||
        session.subagents.length > 0 ||
        session.teammates.some(t => t.status === 'working')) && (
        <div className="mt-1 space-y-0.5">
          {session.activeTasks.slice(0, 5).map(task => (
            <div key={task.id} className="text-[11px] text-active/80 font-mono truncate pl-1">
              <span className="text-active mr-1">{'\u25B8'}</span>
              {task.subject}
            </div>
          ))}
          {session.pendingTasks.slice(0, Math.max(0, 5 - session.activeTasks.length)).map(task => (
            <div key={task.id} className="text-[11px] text-amber-400/50 font-mono truncate pl-1">
              <span className="text-amber-400/40 mr-1">{'\u25CB'}</span>
              {task.subject}
            </div>
          ))}
          {session.activeTasks.length + session.pendingTasks.length > 5 && (
            <div className="text-[10px] text-muted-foreground pl-1 font-mono">
              ..{session.activeTasks.length + session.pendingTasks.length - 5} more
            </div>
          )}
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
      {!compact && (session.status === 'ended' || session.runningBgTaskCount > 0 || session.team) && (
        <div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
          {session.status === 'ended' && <StatusIndicator status={session.status} />}
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
    </div>
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

// Sortable wrapper for a single pinned CWD entry
function SortableOrganizedItem({ cwd, sessions }: { cwd: string; sessions: Session[] }) {
  const projectSettings = useSessionsStore(s => s.projectSettings)
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: cwd,
  })
  const ps = projectSettings[cwd]

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const content =
    sessions.length === 1 ? (
      <SessionItem session={sessions[0]} />
    ) : (
      <SessionCwdGroup sessions={sessions} name={ps?.label || lastPathSegments(cwd)} ps={ps} />
    )

  return (
    <div ref={setNodeRef} style={style} {...attributes} className="flex items-stretch">
      <div
        ref={setActivatorNodeRef}
        {...listeners}
        className="w-4 shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground/60 touch-none"
        title="Drag to reorder"
      >
        <span className="text-[8px] leading-none">{'\u2807'}</span>
      </div>
      <div className="flex-1 min-w-0">{content}</div>
    </div>
  )
}

// Draggable wrapper for unorganized sessions (drag into organized to pin)
function DraggableSessionItem({ cwd, sessions }: { cwd: string; sessions: Session[] }) {
  const projectSettings = useSessionsStore(s => s.projectSettings)
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: cwd,
  })
  const ps = projectSettings[cwd]

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const content =
    sessions.length === 1 ? (
      <SessionItem session={sessions[0]} />
    ) : (
      <SessionCwdGroup sessions={sessions} name={ps?.label || lastPathSegments(cwd)} ps={ps} />
    )

  return (
    <div ref={setNodeRef} style={style} {...attributes} className="flex items-stretch">
      <div
        ref={setActivatorNodeRef}
        {...listeners}
        className="w-4 shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing text-muted-foreground/20 hover:text-muted-foreground/50 touch-none"
        title="Drag to organize"
      >
        <span className="text-[8px] leading-none">{'\u2807'}</span>
      </div>
      <div className="flex-1 min-w-0">{content}</div>
    </div>
  )
}

// Drop target for creating a new group (only visible while dragging)
function NewGroupDropTarget() {
  const { isOver, setNodeRef } = useDroppable({ id: '__new_group__' })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'border-2 border-dashed rounded py-2 px-3 text-center text-[11px] font-mono transition-colors',
        isOver ? 'border-accent text-accent bg-accent/10' : 'border-border/50 text-muted-foreground/50',
      )}
    >
      + new group
    </div>
  )
}

// Drop target for unorganizing (only visible while dragging)
function UnorganizedDropTarget() {
  const { isOver, setNodeRef } = useDroppable({ id: '__unorganized__' })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'border-2 border-dashed rounded py-2 px-3 text-center text-[11px] font-mono transition-colors',
        isOver ? 'border-red-400/60 text-red-400 bg-red-400/10' : 'border-border/50 text-muted-foreground/50',
      )}
    >
      unpin
    </div>
  )
}

function SessionCwdGroup({
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

function InactiveProjectItem({ sessions }: { sessions: Session[] }) {
  const selectSession = useSessionsStore(s => s.selectSession)
  const projectSettings = useSessionsStore(s => s.projectSettings)
  const latest = sessions.reduce((a, b) => (a.lastActivity > b.lastActivity ? a : b))
  const ps = projectSettings[latest.cwd]
  const displayName = ps?.label || lastPathSegments(latest.cwd)
  const displayColor = ps?.color

  function handleClick() {
    haptic('tap')
    selectSession(latest.id)
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

// Helper: group organized entries by their group field
function buildOrganizedByGroup(
  organized: Array<{ cwd: string; group?: string }>,
  sessionsByCwd: Map<string, Session[]>,
) {
  const groups: Array<{ name: string; entries: Array<{ cwd: string; sessions: Session[] }> }> = []
  const groupMap = new Map<string, Array<{ cwd: string; sessions: Session[] }>>()

  for (const entry of organized) {
    const sessions = sessionsByCwd.get(entry.cwd)
    if (!sessions) continue
    const groupName = entry.group || ''
    if (!groupMap.has(groupName)) {
      groupMap.set(groupName, [])
      groups.push({ name: groupName, entries: groupMap.get(groupName)! })
    }
    groupMap.get(groupName)!.push({ cwd: entry.cwd, sessions })
  }

  return groups
}

export function SessionList() {
  const sessions = useSessionsStore(s => s.sessions)
  const sessionOrder = useSessionsStore(s => s.sessionOrder)
  const dashPrefs = useSessionsStore(s => s.dashboardPrefs)
  const [showInactive, setShowInactive] = useState(dashPrefs.showInactiveByDefault)
  const [isDragging, setIsDragging] = useState(false)
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  // PointerSensor handles both mouse AND touch - don't add TouchSensor (conflicts)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  // Build organized vs unorganized lists (keyed by CWD)
  const pinnedCwds = new Set(sessionOrder.organized.map(e => e.cwd))

  // Group all sessions by CWD
  const sessionsByCwd = new Map<string, Session[]>()
  for (const s of sessions) {
    const group = sessionsByCwd.get(s.cwd) || []
    group.push(s)
    sessionsByCwd.set(s.cwd, group)
  }

  // Organized: CWDs grouped by their group field
  const organizedByGroup = buildOrganizedByGroup(sessionOrder.organized, sessionsByCwd)
  const hasOrganized = organizedByGroup.length > 0

  // All organized CWDs as flat list for DnD
  const allOrganizedCwds = sessionOrder.organized.filter(e => sessionsByCwd.has(e.cwd)).map(e => e.cwd)

  // Active sessions that are NOT in a pinned CWD
  const unpinnedActive = sessions.filter(s => (s.status === 'active' || s.status === 'idle') && !pinnedCwds.has(s.cwd))

  // Inactive sessions
  const unpinnedActiveCwds = new Set(unpinnedActive.map(s => s.cwd))
  const inactive = sessions.filter(
    s => s.status !== 'active' && s.status !== 'idle' && !pinnedCwds.has(s.cwd) && !unpinnedActiveCwds.has(s.cwd),
  )

  const sortedUnpinned = [...unpinnedActive].sort((a, b) => b.startedAt - a.startedAt)
  const sortedInactive = [...inactive].sort((a, b) => b.startedAt - a.startedAt)

  // All draggable CWDs (organized + unorganized)
  const allDraggableCwds = [...allOrganizedCwds, ...sortedUnpinned.map(s => s.cwd).filter(cwd => !pinnedCwds.has(cwd))]
  // Deduplicate (multiple sessions can share a CWD)
  const uniqueDraggableCwds = [...new Set(allDraggableCwds)]

  function handleDragEnd(event: DragEndEvent) {
    setIsDragging(false)
    const { active, over } = event
    if (!over || active.id === over.id) return
    haptic('tick')

    const draggedCwd = active.id as string
    const isCurrentlyPinned = pinnedCwds.has(draggedCwd)

    // Drop on "new group" target -> pin + create group
    if (over.id === '__new_group__') {
      const name = window.prompt('Group name:')
      if (!name?.trim()) return
      let newOrganized = [...sessionOrder.organized]
      if (isCurrentlyPinned) {
        newOrganized = newOrganized.map(e => (e.cwd === draggedCwd ? { ...e, group: name.trim() } : e))
      } else {
        newOrganized.push({ cwd: draggedCwd, group: name.trim() })
      }
      useSessionsStore.getState().setSessionOrder({ organized: newOrganized })
      updateSessionOrder('set', { organized: newOrganized })
      return
    }

    // Drop on "unorganized" zone -> unpin
    if (over.id === '__unorganized__') {
      if (isCurrentlyPinned) {
        const newOrganized = sessionOrder.organized.filter(e => e.cwd !== draggedCwd)
        useSessionsStore.getState().setSessionOrder({ organized: newOrganized })
        updateSessionOrder('set', { organized: newOrganized })
      }
      return
    }

    // Drop on another session
    const overCwd = over.id as string
    const overIsPinned = pinnedCwds.has(overCwd)

    if (overIsPinned) {
      // Dropping onto an organized item -> pin (if not already) and reorder
      const newOrganized = [...sessionOrder.organized]
      const targetGroup = newOrganized.find(e => e.cwd === overCwd)?.group

      if (isCurrentlyPinned) {
        // Reorder within organized
        const oldIndex = newOrganized.findIndex(e => e.cwd === draggedCwd)
        const newIndex = newOrganized.findIndex(e => e.cwd === overCwd)
        if (oldIndex === -1 || newIndex === -1) return
        const [moved] = newOrganized.splice(oldIndex, 1)
        moved.group = targetGroup
        newOrganized.splice(newIndex, 0, moved)
      } else {
        // Pin and insert at the target position
        const newIndex = newOrganized.findIndex(e => e.cwd === overCwd)
        newOrganized.splice(newIndex, 0, { cwd: draggedCwd, group: targetGroup })
      }
      useSessionsStore.getState().setSessionOrder({ organized: newOrganized })
      updateSessionOrder('set', { organized: newOrganized })
    } else if (isCurrentlyPinned) {
      // Dropping organized onto unorganized -> unpin
      const newOrganized = sessionOrder.organized.filter(e => e.cwd !== draggedCwd)
      useSessionsStore.getState().setSessionOrder({ organized: newOrganized })
      updateSessionOrder('set', { organized: newOrganized })
    }
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
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={() => setIsDragging(true)}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setIsDragging(false)}
      >
        <SortableContext items={uniqueDraggableCwds} strategy={verticalListSortingStrategy}>
          {/* Organized section with groups */}
          {hasOrganized && (
            <div className="space-y-2">
              {organizedByGroup.map(group => (
                <div key={group.name || '__default__'}>
                  <div className="text-[10px] font-bold uppercase tracking-wider px-1 mb-1 flex items-center gap-1.5">
                    <span className={group.name ? 'text-primary/60' : 'text-amber-400/70'}>
                      {group.name ? `\u25B8 ${group.name}` : '\u2605 Organized'}
                    </span>
                    <span className="flex-1 h-px bg-border/50" />
                  </div>
                  <div className="space-y-1">
                    {group.entries.map(entry => (
                      <SortableOrganizedItem key={entry.cwd} cwd={entry.cwd} sessions={entry.sessions} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Drop targets while dragging */}
          {isDragging && (
            <div className="mt-2 space-y-1">
              <NewGroupDropTarget />
              {hasOrganized && <UnorganizedDropTarget />}
            </div>
          )}

          {/* Unorganized section */}
          {sortedUnpinned.length > 0 && (
            <div>
              {hasOrganized && (
                <div className="text-[10px] text-muted-foreground/50 font-bold uppercase tracking-wider px-1 mb-1 flex items-center gap-2">
                  <span>Unorganized</span>
                  <span className="flex-1 h-px bg-border" />
                </div>
              )}
              <div className="space-y-1">
                {sortedUnpinned
                  .filter((s, i, arr) => arr.findIndex(x => x.cwd === s.cwd) === i)
                  .map(s => {
                    const cwdSessions = sessionsByCwd.get(s.cwd) || [s]
                    const unpinnedSessions = cwdSessions.filter(x => x.status === 'active' || x.status === 'idle')
                    return (
                      <DraggableSessionItem
                        key={s.cwd}
                        cwd={s.cwd}
                        sessions={unpinnedSessions.length > 0 ? unpinnedSessions : [s]}
                      />
                    )
                  })}
              </div>
            </div>
          )}
        </SortableContext>
      </DndContext>

      {/* Inactive section */}
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
