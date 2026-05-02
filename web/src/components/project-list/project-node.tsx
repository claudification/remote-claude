import { memo, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Session } from '@/lib/types'
import { extractProjectLabel, projectPath } from '@/lib/types'
import { haptic } from '@/lib/utils'
import { ProjectSettingsButton, ProjectSettingsEditor, renderProjectIcon } from '../project-settings-editor'
import { ConversationContextMenu, ProjectContextMenu } from './conversation-context-menu'
import { ConversationCard, ConversationItemCompact } from './conversation-item'
import { partitionConversations } from './partition'

function sessionsEqual(a: Session[], b: Session[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// ─── Dismiss all ended sessions button ────────────────────────────

function DismissAllEndedButton({ ended }: { ended: Session[] }) {
  const dismissConversation = useConversationsStore(s => s.dismissConversation)
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
            for (const s of ended) dismissConversation(s.id)
            setConfirming(false)
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              haptic('tap')
              for (const s of ended) dismissConversation(s.id)
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

// ─── Multi-session project card ────────────────────────────────────

const ProjectSessionGroup = memo(
  function ProjectSessionGroup({ sessions, project }: { sessions: Session[]; project: string }) {
    const [showSettings, setShowSettings] = useState(false)
    const ps = useConversationsStore(s => s.projectSettings[project])
    const displayName = ps?.label || extractProjectLabel(project)
    const displayColor = ps?.color
    const { adhoc, normal, ended } = partitionConversations(sessions)
    // Project-level rollups: any session in this project needing attention?
    const hasPendingPermission = useConversationsStore(s => {
      const ids = new Set(sessions.map(x => x.id))
      return s.pendingPermissions.some(p => ids.has(p.conversationId))
    })
    const hasPendingAttention = sessions.some(s => s.pendingAttention)
    const hasNotification = sessions.some(s => s.hasNotification)

    return (
      <div>
        <div
          className="border border-border"
          style={displayColor ? { borderLeftColor: displayColor, borderLeftWidth: '3px' } : undefined}
        >
          <ProjectContextMenu project={project} sessions={sessions} onOpenSettings={() => setShowSettings(true)}>
            <div className="flex items-center gap-1.5 p-3 pb-1">
              {ps?.icon && (
                <span style={displayColor ? { color: displayColor } : undefined}>{renderProjectIcon(ps.icon)}</span>
              )}
              <span
                className="font-bold text-sm flex-1 truncate text-primary"
                style={displayColor ? { color: displayColor } : undefined}
                title={projectPath(project)}
              >
                {displayName}
              </span>
              <span className="text-[10px] text-muted-foreground font-mono">{sessions.length} sessions</span>
              {hasPendingPermission && (
                <span
                  className="text-[9px] text-amber-400 font-bold animate-pulse"
                  title="A session in this project has a pending permission request"
                >
                  PERM
                </span>
              )}
              {hasPendingAttention && !hasPendingPermission && (
                <span className="text-[9px] text-amber-400 font-bold animate-pulse">WAITING</span>
              )}
              {hasNotification && <span className="text-[9px] text-teal-400 font-bold">NOTIFY</span>}
              {ended.length > 0 && <DismissAllEndedButton ended={ended} />}
              <ProjectSettingsButton
                onClick={e => {
                  e.stopPropagation()
                  setShowSettings(!showSettings)
                }}
              />
            </div>
          </ProjectContextMenu>
          <div className="space-y-0.5 pb-1">
            {normal.map(session => (
              <ConversationContextMenu key={session.id} session={session} onOpenSettings={() => setShowSettings(true)}>
                <div>
                  <ConversationItemCompact session={session} />
                </div>
              </ConversationContextMenu>
            ))}
            {adhoc.length > 0 && normal.length > 0 && (
              <div className="flex items-center gap-2 px-3 py-1">
                <span className="flex-1 h-px bg-border" />
                <span className="text-[9px] text-muted-foreground/40 uppercase tracking-wider">ad-hoc</span>
                <span className="flex-1 h-px bg-border" />
              </div>
            )}
            {adhoc.map(session => (
              <ConversationContextMenu key={session.id} session={session} onOpenSettings={() => setShowSettings(true)}>
                <div>
                  <ConversationItemCompact session={session} />
                </div>
              </ConversationContextMenu>
            ))}
          </div>
        </div>
        {showSettings && <ProjectSettingsEditor project={project} onClose={() => setShowSettings(false)} />}
      </div>
    )
  },
  (prev, next) => prev.project === next.project && sessionsEqual(prev.sessions, next.sessions),
)

// ─── Project node renderer (single or multi-session) ─────────────

export const ProjectNode = memo(
  function ProjectNode({ project, sessions }: { project: string; sessions: Session[] }) {
    if (sessions.length === 1) return <ConversationCard session={sessions[0]} />
    return <ProjectSessionGroup sessions={sessions} project={project} />
  },
  (prev, next) => prev.project === next.project && sessionsEqual(prev.sessions, next.sessions),
)
