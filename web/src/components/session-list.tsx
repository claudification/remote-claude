import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { HookEvent } from '@shared/protocol'
import { ContextMenu } from 'radix-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { reviveSession, saveSessionOrder, useSessionsStore } from '@/hooks/use-sessions'
import { formatCost, getCostBgColor, getCostLevel, getSessionCost } from '@/lib/cost-utils'
import type { Session, SessionOrderGroup, SessionOrderNode, SessionOrderV2 } from '@/lib/types'
import { cn, contextWindowSize, formatAge, formatModel, haptic, lastPathSegments } from '@/lib/utils'
import { ProjectSettingsButton, ProjectSettingsEditor, renderProjectIcon } from './project-settings-editor'
import { ShareIndicator } from './share-panel'
import { openSpawnDialog } from './spawn-dialog'

// ─── Shared visual components ──────────────────────────────────────

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
  if (status === 'starting') {
    return (
      <span
        className="w-2 h-2 rounded-full shrink-0 animate-pulse"
        style={{ backgroundColor: 'var(--idle)' }}
        title="starting"
      />
    )
  }
  return <span className="w-2 h-2 rounded-full shrink-0 bg-idle" title={status} />
}

const EMPTY_EVENTS: HookEvent[] = []

function DismissButton({ sessionId }: { sessionId: string }) {
  const dismissSession = useSessionsStore(s => s.dismissSession)
  const [confirming, setConfirming] = useState(false)

  if (confirming) {
    return (
      <div
        className="flex items-center gap-1 text-[9px]"
        role="group"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            haptic('tap')
            dismissSession(sessionId)
            setConfirming(false)
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              haptic('tap')
              dismissSession(sessionId)
              setConfirming(false)
            }
          }}
          className="text-destructive hover:text-destructive/80 cursor-pointer font-bold"
        >
          yes
        </div>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setConfirming(false)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') setConfirming(false)
          }}
          className="text-muted-foreground hover:text-foreground cursor-pointer"
        >
          no
        </div>
      </div>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={e => {
        e.stopPropagation()
        haptic('tap')
        setConfirming(true)
      }}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation()
          haptic('tap')
          setConfirming(true)
        }
      }}
      className="opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 text-muted-foreground/40 hover:text-destructive transition-opacity cursor-pointer px-0.5"
      title="Dismiss session"
    >
      {'\u2715'}
    </div>
  )
}

function DismissAllEndedButton({ sessions }: { sessions: Session[] }) {
  const dismissSession = useSessionsStore(s => s.dismissSession)
  const ended = sessions.filter(s => s.status === 'ended')
  const [confirming, setConfirming] = useState(false)
  if (ended.length === 0) return null

  if (confirming) {
    return (
      <div
        className="flex items-center gap-1 text-[9px]"
        role="group"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        <span className="text-muted-foreground">dismiss {ended.length}?</span>
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            haptic('tap')
            for (const s of ended) dismissSession(s.id)
            setConfirming(false)
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              haptic('tap')
              for (const s of ended) dismissSession(s.id)
              setConfirming(false)
            }
          }}
          className="text-destructive hover:text-destructive/80 cursor-pointer font-bold"
        >
          yes
        </div>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setConfirming(false)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') setConfirming(false)
          }}
          className="text-muted-foreground hover:text-foreground cursor-pointer"
        >
          no
        </div>
      </div>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={e => {
        e.stopPropagation()
        haptic('tap')
        setConfirming(true)
      }}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation()
          haptic('tap')
          setConfirming(true)
        }
      }}
      className="text-[9px] text-muted-foreground/40 hover:text-destructive cursor-pointer px-1 transition-colors"
      title={`Dismiss ${ended.length} ended session${ended.length > 1 ? 's' : ''}`}
    >
      {'\u2715'} ended
    </div>
  )
}

// ─── Session card content (variable height, shows tasks/agents) ────

function SessionItemContent({ session, compact }: { session: Session; compact?: boolean }) {
  const selectedSessionId = useSessionsStore(s => s.selectedSessionId)
  const selectedSubagentId = useSessionsStore(s => s.selectedSubagentId)
  const selectSession = useSessionsStore(s => s.selectSession)
  const selectSubagent = useSessionsStore(s => s.selectSubagent)
  const openTab = useSessionsStore(s => s.openTab)
  const cachedEvents = useSessionsStore(s => s.events[session.id] || EMPTY_EVENTS)
  const ps = useSessionsStore(s => s.projectSettings[session.cwd])
  const showContextBar = useSessionsStore(s => s.dashboardPrefs.showContextInList)
  const showCost = useSessionsStore(s => s.dashboardPrefs.showCostInList)
  const isSelected = selectedSessionId === session.id
  const sessionStartEvent = cachedEvents.find(e => e.hookEvent === 'SessionStart')
  const model = (sessionStartEvent?.data as { model?: string } | undefined)?.model

  function handleClick() {
    haptic('tap')
    selectSession(session.id)
  }

  const projectName = ps?.label || lastPathSegments(session.cwd)
  const sessionName = session.title || session.agentName
  const displayColor = ps?.color

  return (
    <div
      data-session-id={session.id}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') handleClick()
      }}
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
            {projectName}
          </span>
          {session.compacting && (
            <span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-amber-400/20 text-amber-400 border border-amber-400/50 animate-pulse">
              compacting
            </span>
          )}
          {session.lastError && (
            <span
              className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-destructive/20 text-destructive border border-destructive/50"
              title={session.lastError.errorMessage || session.lastError.errorType || 'API error'}
            >
              error
            </span>
          )}
          {session.rateLimit && !session.lastError && (
            <span
              className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-amber-500/20 text-amber-400 border border-amber-500/40"
              title={session.rateLimit.message}
            >
              throttled
            </span>
          )}
          <ShareIndicator sessionCwd={session.cwd} />
          {session.status === 'ended' && <DismissButton sessionId={session.id} />}
          {showCost &&
            session.stats &&
            (() => {
              const { cost, exact } = getSessionCost(session.stats, model || session.model)
              if (cost < 0.01) return null
              const level = getCostLevel(cost)
              return (
                <span
                  className={cn(
                    'text-[9px] font-mono ml-auto shrink-0',
                    level === 'low' ? 'text-emerald-400/40' : cn('px-1 py-0.5 font-bold border', getCostBgColor(cost)),
                  )}
                  title={`Session cost: ${formatCost(cost, exact)}`}
                >
                  {formatCost(cost, exact)}
                </span>
              )
            })()}
        </div>
      )}
      {!compact && sessionName && (
        <div className="mt-0.5 text-[10px] text-muted-foreground font-mono truncate pl-1">{sessionName}</div>
      )}
      {compact && (
        <div className="flex items-center gap-1.5">
          <StatusIndicator status={session.status} />
          <span
            className={cn(
              'font-mono text-[11px] flex-1 truncate',
              isSelected ? 'text-accent' : 'text-muted-foreground',
            )}
            title={session.id}
          >
            {session.title || session.agentName
              ? `${(session.title || session.agentName)!.slice(0, 20)} [${session.id.slice(0, 6)}]`
              : session.id.slice(0, 8)}
          </span>
          {session.compacting && <span className="text-[9px] text-amber-400 font-bold animate-pulse">COMPACT</span>}
          {session.lastError && <span className="text-[9px] text-destructive font-bold">ERROR</span>}
          {session.rateLimit && !session.lastError && (
            <span className="text-[9px] text-amber-400 font-bold">THROTTLED</span>
          )}
          {session.planMode && <span className="text-[9px] text-blue-400 font-bold">PLAN</span>}
          {showCost &&
            session.stats &&
            (() => {
              const { cost, exact } = getSessionCost(session.stats, model || session.model)
              if (cost < 0.5) return null
              return (
                <span className={cn('text-[9px] font-bold font-mono', getCostBgColor(cost).split(' ')[1])}>
                  {formatCost(cost, exact)}
                </span>
              )
            })()}
          {session.pendingAttention && (
            <span className="text-[9px] text-amber-400 font-bold animate-pulse">WAITING</span>
          )}
          {session.hasNotification && <span className="text-[9px] text-teal-400 font-bold">NOTIFY</span>}
          {session.status === 'ended' && <DismissButton sessionId={session.id} />}
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
                role="button"
                tabIndex={0}
                className={cn(
                  'text-[11px] text-pink-400/80 font-mono truncate pl-1 cursor-pointer hover:text-pink-300',
                  selectedSubagentId === a.agentId && 'text-pink-300 font-bold',
                )}
                onClick={e => {
                  e.stopPropagation()
                  selectSession(session.id)
                  selectSubagent(a.agentId)
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation()
                    selectSession(session.id)
                    selectSubagent(a.agentId)
                  }
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
                role="button"
                tabIndex={0}
                className={cn(
                  'text-[11px] text-pink-400/40 font-mono truncate pl-1 cursor-pointer hover:text-pink-400/70',
                  selectedSubagentId === a.agentId && 'text-pink-400/80 font-bold',
                )}
                onClick={e => {
                  e.stopPropagation()
                  selectSession(session.id)
                  selectSubagent(a.agentId)
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation()
                    selectSession(session.id)
                    selectSubagent(a.agentId)
                  }
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
      {!compact && (session.runningBgTaskCount > 0 || session.team) && (
        <div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
          {session.runningBgTaskCount > 0 && (
            <span
              role="button"
              tabIndex={0}
              className="px-1.5 py-0.5 bg-emerald-400/20 text-emerald-400 border border-emerald-400/50 text-[10px] font-bold cursor-pointer hover:bg-emerald-400/30"
              onClick={e => {
                e.stopPropagation()
                openTab(session.id, 'agents')
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation()
                  openTab(session.id, 'agents')
                }
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
      {!compact && session.summary && (
        <div className="mt-1 text-[10px] text-muted-foreground truncate" title={session.summary}>
          {session.summary}
        </div>
      )}
      {!compact && session.prLinks && session.prLinks.length > 0 && (
        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
          {session.prLinks.map(pr => (
            <a
              key={pr.prUrl}
              href={pr.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="text-[10px] font-mono text-sky-400 hover:text-sky-300 transition-colors"
              title={`${pr.prRepository}#${pr.prNumber}`}
            >
              PR#{pr.prNumber}
            </a>
          ))}
        </div>
      )}
      {!compact && session.linkedSessions && session.linkedSessions.length > 0 && (
        <div className="mt-1 text-[10px] text-teal-400/50 font-mono truncate">
          {'\u2194'} {session.linkedSessions.map(s => s.name).join(', ')}
        </div>
      )}
      {!compact &&
        showContextBar &&
        session.tokenUsage &&
        (() => {
          const { input, cacheCreation, cacheRead } = session.tokenUsage
          const total = input + cacheCreation + cacheRead
          if (total === 0) return null
          const maxTokens = contextWindowSize(model || session.model)
          const pct = Math.min(100, Math.round((total / maxTokens) * 100))
          return (
            <div className="mt-1.5 flex items-center gap-1.5">
              <div className="flex-1 h-1 bg-muted/50 rounded-full overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    pct < 60 ? 'bg-emerald-400/60' : pct < 85 ? 'bg-amber-400/60' : 'bg-red-400/70',
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span
                className={cn(
                  'text-[9px] font-mono tabular-nums shrink-0',
                  pct < 60 ? 'text-emerald-400/50' : pct < 85 ? 'text-amber-400/50' : 'text-red-400/60',
                )}
              >
                {pct}%
              </span>
            </div>
          )
        })()}
    </div>
  )
}

// ─── Session context menu (right-click) ─────────────────────────────

function SessionContextMenu({ session, children }: { session: Session; children: React.ReactNode }) {
  const rawSessionOrder = useSessionsStore(s => s.sessionOrder) as SessionOrderV2 | null
  const sessionOrder = rawSessionOrder?.tree ? rawSessionOrder : { version: 2 as const, tree: [] }
  const dismissSession = useSessionsStore(s => s.dismissSession)
  const selectSession = useSessionsStore(s => s.selectSession)
  const projectSettings = useSessionsStore(s => s.projectSettings)
  const defaultMode = projectSettings[session.cwd]?.defaultLaunchMode || 'headless'

  const groups = sessionOrder.tree.filter((n): n is SessionOrderGroup => n.type === 'group')
  const sessionCwdKey = `cwd:${session.cwd}`

  function moveToGroup(groupId: string) {
    haptic('tap')
    const newTree = sessionOrder.tree.map(node => {
      if (node.type === 'group') {
        // Remove from any existing group
        const filtered = { ...node, children: node.children.filter(c => c.id !== sessionCwdKey) }
        // Add to target group
        if (node.id === groupId) {
          return { ...filtered, children: [...filtered.children, { id: sessionCwdKey, type: 'session' as const }] }
        }
        return filtered
      }
      return node
    })
    // Remove from root level if it was there
    const rootFiltered = newTree.filter(n => n.id !== sessionCwdKey)
    saveSessionOrder({ version: 2, tree: rootFiltered })
  }

  function removeFromGroups() {
    haptic('tap')
    const newTree = sessionOrder.tree.map(node => {
      if (node.type === 'group') {
        return { ...node, children: node.children.filter(c => c.id !== sessionCwdKey) }
      }
      return node
    })
    // Add to root level if not already there
    if (!newTree.some(n => n.id === sessionCwdKey)) {
      newTree.push({ id: sessionCwdKey, type: 'session' as const })
    }
    saveSessionOrder({ version: 2, tree: newTree })
  }

  function createGroupAndMove() {
    const name = prompt('Group name:')
    if (!name?.trim()) return
    haptic('tap')
    const groupId = `group-${name.trim().toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`
    // Remove session from any existing group/root
    let newTree = sessionOrder.tree
      .filter(n => n.id !== sessionCwdKey)
      .map(node => {
        if (node.type === 'group') {
          return { ...node, children: node.children.filter(c => c.id !== sessionCwdKey) }
        }
        return node
      })
    // Create new group with the session
    newTree = [
      {
        id: groupId,
        type: 'group' as const,
        name: name.trim(),
        children: [{ id: sessionCwdKey, type: 'session' as const }],
      },
      ...newTree,
    ]
    saveSessionOrder({ version: 2, tree: newTree })
  }

  const menuItemClass =
    'flex items-center px-3 py-1.5 text-[11px] font-mono cursor-pointer outline-none data-[highlighted]:bg-accent/20 data-[highlighted]:text-accent'

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-[180px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
          {groups.length > 0 && (
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className={menuItemClass}>
                Move to <span className="ml-auto text-muted-foreground">{'\u25B8'}</span>
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent className="min-w-[160px] bg-popover border border-border rounded-md shadow-lg py-1 z-50">
                  {groups.map(g => (
                    <ContextMenu.Item key={g.id} className={menuItemClass} onSelect={() => moveToGroup(g.id)}>
                      {g.name}
                    </ContextMenu.Item>
                  ))}
                  <ContextMenu.Separator className="h-px bg-border my-1" />
                  <ContextMenu.Item className={menuItemClass} onSelect={removeFromGroups}>
                    Unpin (no group)
                  </ContextMenu.Item>
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          )}
          <ContextMenu.Item className={menuItemClass} onSelect={createGroupAndMove}>
            New group...
          </ContextMenu.Item>
          <ContextMenu.Item
            className={cn(menuItemClass, 'text-cyan-400')}
            onSelect={() => {
              haptic('tap')
              openSpawnDialog({ cwd: session.cwd })
            }}
          >
            Launch new...
          </ContextMenu.Item>
          <ContextMenu.Separator className="h-px bg-border my-1" />
          {session.status !== 'ended' && (
            <ContextMenu.Item
              className={cn(menuItemClass, 'text-destructive')}
              onSelect={() => {
                haptic('error')
                useSessionsStore.getState().terminateSession(session.id)
              }}
            >
              Terminate session
            </ContextMenu.Item>
          )}
          {session.status === 'ended' && (
            <>
              <ContextMenu.Item
                className={cn(menuItemClass, 'text-emerald-400')}
                onSelect={() => {
                  haptic('tap')
                  selectSession(session.id)
                  reviveSession(session.id, true)
                }}
              >
                Revive (headless){defaultMode === 'headless' ? ' *' : ''}
              </ContextMenu.Item>
              <ContextMenu.Item
                className={cn(menuItemClass, 'text-purple-400')}
                onSelect={() => {
                  haptic('tap')
                  selectSession(session.id)
                  reviveSession(session.id, false)
                }}
              >
                Revive (PTY){defaultMode === 'pty' ? ' *' : ''}
              </ContextMenu.Item>
              <ContextMenu.Item
                className={cn(menuItemClass, 'text-destructive')}
                onSelect={() => {
                  haptic('tap')
                  dismissSession(session.id)
                }}
              >
                Dismiss
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

// ─── Session card with settings button ─────────────────────────────

function SessionCard({ session }: { session: Session }) {
  const [showSettings, setShowSettings] = useState(false)
  const isSelected = useSessionsStore(s => s.selectedSessionId === session.id)
  return (
    <SessionContextMenu session={session}>
      <div>
        <div className="relative group/card">
          <SessionItemContent session={session} />
          <div
            className={cn(
              'absolute top-2 right-2 transition-opacity',
              isSelected ? 'opacity-100' : 'opacity-0 [@media(hover:hover)]:group-hover/card:opacity-100',
            )}
          >
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
    </SessionContextMenu>
  )
}

// ─── Multi-session CWD card ────────────────────────────────────────

function CwdSessionGroup({ sessions, cwd }: { sessions: Session[]; cwd: string }) {
  const [showSettings, setShowSettings] = useState(false)
  const ps = useSessionsStore(s => s.projectSettings[cwd])
  const displayName = ps?.label || lastPathSegments(cwd)
  const displayColor = ps?.color

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
            {displayName}
          </span>
          <span className="text-[10px] text-muted-foreground font-mono">{sessions.length} sessions</span>
          {sessions.some(s => s.status === 'ended') && <DismissAllEndedButton sessions={sessions} />}
          <ProjectSettingsButton
            onClick={e => {
              e.stopPropagation()
              setShowSettings(!showSettings)
            }}
          />
        </div>
        <div className="space-y-0.5 pb-1">
          {sessions.map(session => (
            <SessionContextMenu key={session.id} session={session}>
              <div>
                <SessionItemContent session={session} compact />
              </div>
            </SessionContextMenu>
          ))}
        </div>
      </div>
      {showSettings && <ProjectSettingsEditor cwd={cwd} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

// ─── CWD node renderer (single or multi-session) ──────────────────

function CwdNode({ cwd, sessions }: { cwd: string; sessions: Session[] }) {
  if (sessions.length === 1) return <SessionCard session={sessions[0]} />
  return <CwdSessionGroup sessions={sessions} cwd={cwd} />
}

// ─── Sortable wrapper ──────────────────────────────────────────────

function SortableNode({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={cn(isDragging && 'z-10 relative')}
    >
      {children}
    </div>
  )
}

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

// ─── Group node (collapsible folder) ───────────────────────────────

function GroupNode({
  group,
  sessionsByCwd,
  collapsed,
  onToggle,
  onRename,
}: {
  group: SessionOrderGroup
  sessionsByCwd: Map<string, Session[]>
  collapsed: boolean
  onToggle: () => void
  onRename: (newName: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus()
  }, [editing])

  // Count children with live sessions
  const childCount = group.children.filter(c => {
    if (c.type === 'session') {
      const cwd = c.id.startsWith('cwd:') ? c.id.slice(4) : c.id
      return sessionsByCwd.has(cwd)
    }
    return true
  }).length

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        className="text-[10px] font-bold uppercase tracking-wider px-1 py-1 mb-1 flex items-center gap-1.5 cursor-pointer select-none text-primary/60"
        onClick={() => {
          haptic('tick')
          onToggle()
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            haptic('tick')
            onToggle()
          }
        }}
      >
        <span>{collapsed ? '\u25B8' : '\u25BE'}</span>
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            defaultValue={group.name}
            className="bg-transparent border-b border-primary text-primary text-[10px] font-bold uppercase outline-none flex-1"
            onBlur={e => {
              const v = e.currentTarget.value.trim()
              if (v && v !== group.name) onRename(v)
              setEditing(false)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const v = e.currentTarget.value.trim()
                if (v && v !== group.name) onRename(v)
                setEditing(false)
              }
              if (e.key === 'Escape') setEditing(false)
            }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span
            role="textbox"
            tabIndex={0}
            onDoubleClick={e => {
              e.stopPropagation()
              setEditing(true)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.stopPropagation()
                setEditing(true)
              }
            }}
          >
            {group.name}
          </span>
        )}
        {collapsed && <span className="text-muted-foreground/40 font-normal normal-case">({childCount})</span>}
        <span className="flex-1 h-px bg-border/50" />
      </div>
    </div>
  )
}

// ─── Inactive section ──────────────────────────────────────────────

function InactiveProjectItem({ sessions }: { sessions: Session[] }) {
  const selectSession = useSessionsStore(s => s.selectSession)
  const projectSettings = useSessionsStore(s => s.projectSettings)
  const latest = sessions.reduce((a, b) => (a.lastActivity > b.lastActivity ? a : b))
  const ps = projectSettings[latest.cwd]
  const displayName = ps?.label || lastPathSegments(latest.cwd)
  const displayColor = ps?.color

  return (
    <SessionContextMenu session={latest}>
      <div
        data-session-id={latest.id}
        role="button"
        tabIndex={0}
        onClick={() => {
          haptic('tap')
          selectSession(latest.id)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            haptic('tap')
            selectSession(latest.id)
          }
        }}
        className="w-full text-left border border-border hover:border-primary p-2 pl-3 transition-colors cursor-pointer"
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
      </div>
    </SessionContextMenu>
  )
}

// ─── Main SessionList ──────────────────────────────────────────────

export function SessionList() {
  const allSessions = useSessionsStore(s => s.sessions)
  const canAdmin = useSessionsStore(s => s.permissions.canAdmin)
  const sessionPermissions = useSessionsStore(s => s.sessionPermissions)
  // Non-admin users only see sessions they have read access to
  const sessions = useMemo(() => {
    if (canAdmin) return allSessions
    return allSessions.filter(s => {
      const perms = sessionPermissions[s.id]
      return perms ? perms.canReadChat : false
    })
  }, [allSessions, canAdmin, sessionPermissions])
  const selectedSessionId = useSessionsStore(s => s.selectedSessionId)
  const rawSessionOrder = useSessionsStore(s => s.sessionOrder)
  const sessionOrder = rawSessionOrder?.tree ? rawSessionOrder : { version: 2 as const, tree: [] }
  const dashPrefs = useSessionsStore(s => s.dashboardPrefs)
  const [showInactive, setShowInactive] = useState(dashPrefs.showInactiveByDefault)
  const [pulseSessionId, setPulseSessionId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('collapsed-groups')
      return stored ? new Set(JSON.parse(stored)) : new Set()
    } catch {
      return new Set()
    }
  })

  // Refresh timestamps periodically
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  // Group all sessions by CWD
  const sessionsByCwd = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const s of sessions) {
      const group = map.get(s.cwd) || []
      group.push(s)
      map.set(s.cwd, group)
    }
    return map
  }, [sessions])

  // Track which CWDs are in the organized tree
  const treeCwds = useMemo(() => {
    const cwds = new Set<string>()
    function walk(nodes: SessionOrderNode[]) {
      for (const n of nodes) {
        if (n.type === 'session') {
          cwds.add(n.id.startsWith('cwd:') ? n.id.slice(4) : n.id)
        } else if (n.type === 'group') {
          walk(n.children)
        }
      }
    }
    walk(sessionOrder.tree)
    return cwds
  }, [sessionOrder])

  // Unorganized active sessions
  const unorganized = useMemo(() => {
    const seen = new Set<string>()
    const result: Array<{ cwd: string; sessions: Session[] }> = []
    for (const s of sessions) {
      if (s.status !== 'ended' && !treeCwds.has(s.cwd) && !seen.has(s.cwd)) {
        seen.add(s.cwd)
        const cwdSessions = (sessionsByCwd.get(s.cwd) || []).filter(x => x.status !== 'ended')
        if (cwdSessions.length > 0) result.push({ cwd: s.cwd, sessions: cwdSessions })
      }
    }
    result.sort((a, b) => {
      const aMax = Math.max(...a.sessions.map(s => s.startedAt))
      const bMax = Math.max(...b.sessions.map(s => s.startedAt))
      return bMax - aMax
    })
    return result
  }, [sessions, treeCwds, sessionsByCwd])

  // Inactive sessions (ended, not in tree, not in unorganized)
  const inactive = useMemo(() => {
    const activeCwds = new Set(sessions.filter(s => s.status !== 'ended').map(s => s.cwd))
    const byCwd = new Map<string, Session[]>()
    for (const s of sessions) {
      if (s.status === 'ended' && !treeCwds.has(s.cwd) && !activeCwds.has(s.cwd)) {
        const group = byCwd.get(s.cwd) || []
        group.push(s)
        byCwd.set(s.cwd, group)
      }
    }
    return Array.from(byCwd.values()).sort((a, b) => {
      const aMax = Math.max(...a.map(s => s.lastActivity))
      const bMax = Math.max(...b.map(s => s.lastActivity))
      return bMax - aMax
    })
  }, [sessions, treeCwds])

  // Toggle group collapse
  function toggleGroup(groupId: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      localStorage.setItem('collapsed-groups', JSON.stringify([...next]))
      return next
    })
  }

  // Scroll into view + pulse when session is selected (e.g. via Ctrl+K)
  // Groups stay collapsed -- the selected session "peeks" below the group header
  useEffect(() => {
    if (!selectedSessionId) return
    setPulseSessionId(selectedSessionId)
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-session-id="${selectedSessionId}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        el.classList.add('session-pulse')
        setTimeout(() => el.classList.remove('session-pulse'), 1500)
      }
    })
    const timer = setTimeout(() => setPulseSessionId(null), 1500)
    return () => clearTimeout(timer)
  }, [selectedSessionId])

  // Rename group
  const handleRename = useCallback(
    (groupId: string, newName: string) => {
      function renameInTree(nodes: SessionOrderNode[]): SessionOrderNode[] {
        return nodes.map(n => {
          if (n.type === 'group' && n.id === groupId) return { ...n, name: newName }
          if (n.type === 'group') return { ...n, children: renameInTree(n.children) }
          return n
        })
      }
      const newOrder: SessionOrderV2 = { version: 2, tree: renameInTree(sessionOrder.tree) }
      useSessionsStore.getState().setSessionOrder(newOrder)
      saveSessionOrder(newOrder)
    },
    [sessionOrder],
  )

  // Flatten tree + unorganized into sortable IDs
  const sortableIds = useMemo(() => {
    const ids: string[] = []
    for (const node of sessionOrder.tree) {
      ids.push(node.id) // group or root session
      if (node.type === 'group' && !collapsedGroups.has(node.id)) {
        for (const child of node.children) ids.push(child.id)
      }
    }
    for (const { cwd } of unorganized) ids.push(`cwd:${cwd}`)
    return ids
  }, [sessionOrder, unorganized, collapsedGroups])

  // Sensors: mouse (8px) + touch (300ms long-press)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 5 } }),
  )
  const [isDragging, setIsDragging] = useState(false)

  // Find which group an ID belongs to
  function findParentGroup(id: string): string | null {
    for (const node of sessionOrder.tree) {
      if (node.type === 'group') {
        if (node.children.some(c => c.id === id)) return node.id
      }
    }
    return null
  }

  function handleDragEnd(event: DragEndEvent) {
    setIsDragging(false)
    const { active, over } = event
    if (!over || active.id === over.id) return
    haptic('tick')

    const draggedId = active.id as string
    const overId = over.id as string

    // Drop onto "new group" target
    if (overId === '__new_group__') {
      const name = window.prompt('Group name:')
      if (!name?.trim()) return
      const groupId = `group-${name.trim().toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`
      // Remove from current position
      const newTree = removeFromTree(sessionOrder.tree, draggedId)
      // Add new group with this item
      const sessionNode = draggedId.startsWith('group-')
        ? sessionOrder.tree.find(n => n.id === draggedId) // dragging a group into a new group? just rename
        : { id: draggedId, type: 'session' as const }
      if (sessionNode) {
        newTree.push({
          id: groupId,
          type: 'group',
          name: name.trim(),
          children: [sessionNode.type === 'group' ? sessionNode : { id: draggedId, type: 'session' }],
        })
      }
      persistTree(newTree)
      return
    }

    // Is the over target a group header?
    const overIsGroup = overId.startsWith('group-')
    const draggedIsGroup = draggedId.startsWith('group-')
    const draggedIsInTree = sessionOrder.tree.some(n => n.id === draggedId) || findParentGroup(draggedId) !== null
    const overIsInTree = sessionOrder.tree.some(n => n.id === overId) || findParentGroup(overId) !== null

    if (draggedIsGroup && overIsGroup) {
      // Reorder groups at root level
      const newTree = [...sessionOrder.tree]
      const fromIdx = newTree.findIndex(n => n.id === draggedId)
      const toIdx = newTree.findIndex(n => n.id === overId)
      if (fromIdx === -1 || toIdx === -1) return
      const [moved] = newTree.splice(fromIdx, 1)
      newTree.splice(toIdx, 0, moved)
      persistTree(newTree)
    } else if (overIsGroup && !draggedIsGroup) {
      // Drop session into a group
      const newTree = removeFromTree(sessionOrder.tree, draggedId)
      const targetGroup = newTree.find(n => n.id === overId && n.type === 'group') as SessionOrderGroup | undefined
      if (targetGroup) {
        targetGroup.children.push({
          id: draggedId.startsWith('cwd:') ? draggedId : `cwd:${draggedId}`,
          type: 'session',
        })
      }
      persistTree(newTree)
    } else if (overIsInTree && !draggedIsInTree) {
      // Drag unorganized onto organized -> pin it (insert near target)
      const overParent = findParentGroup(overId)
      const newTree = [...sessionOrder.tree]
      const sessionId = draggedId.startsWith('cwd:') ? draggedId : `cwd:${draggedId}`
      if (overParent) {
        const group = newTree.find(n => n.id === overParent && n.type === 'group') as SessionOrderGroup | undefined
        if (group) {
          const idx = group.children.findIndex(c => c.id === overId)
          group.children.splice(idx >= 0 ? idx : group.children.length, 0, { id: sessionId, type: 'session' })
        }
      } else {
        const idx = newTree.findIndex(n => n.id === overId)
        newTree.splice(idx >= 0 ? idx : newTree.length, 0, { id: sessionId, type: 'session' })
      }
      persistTree(newTree)
    } else if (draggedIsInTree && !overIsInTree) {
      // Drag organized onto unorganized -> unpin
      const newTree = removeFromTree(sessionOrder.tree, draggedId)
      persistTree(newTree)
    } else if (draggedIsInTree && overIsInTree) {
      // Reorder within tree
      const newTree = removeFromTree(sessionOrder.tree, draggedId)
      const draggedNode: SessionOrderNode = { id: draggedId, type: 'session' }
      // Find original node data (might be a group)
      const origNode = findInTree(sessionOrder.tree, draggedId)
      const nodeToInsert = origNode || draggedNode

      const overParent = findParentGroup(overId)
      if (overParent) {
        const group = newTree.find(n => n.id === overParent && n.type === 'group') as SessionOrderGroup | undefined
        if (group) {
          const idx = group.children.findIndex(c => c.id === overId)
          group.children.splice(idx >= 0 ? idx : group.children.length, 0, nodeToInsert)
        }
      } else {
        const idx = newTree.findIndex(n => n.id === overId)
        newTree.splice(idx >= 0 ? idx : newTree.length, 0, nodeToInsert)
      }
      persistTree(newTree)
    }
  }

  function removeFromTree(tree: SessionOrderNode[], id: string): SessionOrderNode[] {
    return tree
      .filter(n => n.id !== id)
      .map(n => {
        if (n.type === 'group') return { ...n, children: n.children.filter(c => c.id !== id) }
        return n
      })
  }

  function findInTree(tree: SessionOrderNode[], id: string): SessionOrderNode | null {
    for (const n of tree) {
      if (n.id === id) return n
      if (n.type === 'group') {
        const found = n.children.find(c => c.id === id)
        if (found) return found
      }
    }
    return null
  }

  function persistTree(tree: SessionOrderNode[]) {
    const newOrder: SessionOrderV2 = { version: 2, tree }
    useSessionsStore.getState().setSessionOrder(newOrder)
    saveSessionOrder(newOrder)
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

  const hasOrganized = sessionOrder.tree.length > 0

  return (
    <div className="space-y-2 overflow-y-auto">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={() => setIsDragging(true)}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setIsDragging(false)}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          {/* Organized tree */}
          {sessionOrder.tree.map(node => {
            if (node.type === 'group') {
              const isCollapsed = collapsedGroups.has(node.id)
              return (
                <SortableNode key={node.id} id={node.id}>
                  <GroupNode
                    group={node}
                    sessionsByCwd={sessionsByCwd}
                    collapsed={isCollapsed}
                    onToggle={() => toggleGroup(node.id)}
                    onRename={name => handleRename(node.id, name)}
                  />
                  {!isCollapsed ? (
                    <div className="space-y-1">
                      {node.children.map(child => {
                        if (child.type === 'group') return null
                        const childCwd = child.id.startsWith('cwd:') ? child.id.slice(4) : child.id
                        const childSessions = sessionsByCwd.get(childCwd)
                        if (!childSessions || childSessions.length === 0) return null
                        return (
                          <SortableNode key={child.id} id={child.id}>
                            <CwdNode cwd={childCwd} sessions={childSessions} />
                          </SortableNode>
                        )
                      })}
                    </div>
                  ) : (
                    (() => {
                      // Peek: show selected session even when group is collapsed
                      if (!selectedSessionId) return null
                      const selectedSession = sessions.find(s => s.id === selectedSessionId)
                      if (!selectedSession) return null
                      const selectedCwdKey = `cwd:${selectedSession.cwd}`
                      if (!node.children.some(c => c.id === selectedCwdKey)) return null
                      return (
                        <div className="opacity-80">
                          <SessionItemContent session={selectedSession} compact />
                        </div>
                      )
                    })()
                  )}
                </SortableNode>
              )
            }
            // Root-level session node
            const cwd = node.id.startsWith('cwd:') ? node.id.slice(4) : node.id
            const cwdSessions = sessionsByCwd.get(cwd)
            if (!cwdSessions || cwdSessions.length === 0) return null
            return (
              <SortableNode key={node.id} id={node.id}>
                <CwdNode cwd={cwd} sessions={cwdSessions} />
              </SortableNode>
            )
          })}

          {/* Drop target for new group */}
          <div
            className={cn(
              'mt-2 transition-all',
              isDragging ? 'opacity-100 max-h-16' : 'opacity-0 max-h-0 overflow-hidden',
            )}
          >
            <NewGroupDropTarget />
          </div>

          {/* Unorganized section */}
          {unorganized.length > 0 && (
            <div>
              {hasOrganized && (
                <div className="text-[10px] text-muted-foreground/50 font-bold uppercase tracking-wider px-1 mb-1 flex items-center gap-2">
                  <span>Unorganized</span>
                  <span className="flex-1 h-px bg-border" />
                </div>
              )}
              <div className="space-y-1">
                {unorganized.map(({ cwd, sessions: cwdSessions }) => (
                  <SortableNode key={`cwd:${cwd}`} id={`cwd:${cwd}`}>
                    <CwdNode cwd={cwd} sessions={cwdSessions} />
                  </SortableNode>
                ))}
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
          show inactive ({inactive.length})
        </label>
      )}
      {showInactive && inactive.map(group => <InactiveProjectItem key={group[0].cwd} sessions={group} />)}
    </div>
  )
}
