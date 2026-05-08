import { Pin } from 'lucide-react'
import { memo, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Session } from '@/lib/types'
import { extractProjectLabel, projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { ProjectSettingsButton, ProjectSettingsEditor, renderProjectIcon } from '../project-settings-editor'
import { ConversationContextMenu, PinnedProjectContextMenu, ProjectContextMenu } from './conversation-context-menu'
import { ConversationCard, ConversationItemCompact } from './conversation-item'
import { InlineConfirmButton } from './inline-confirm-button'
import { partitionConversations } from './partition'

function sessionsEqual(a: Session[], b: Session[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// ─── Dismiss all ended conversations button ────────────────────────────

function DismissAllEndedButton({ ended }: { ended: Session[] }) {
  const dismissConversation = useConversationsStore(s => s.dismissConversation)
  if (ended.length === 0) return null

  return (
    <InlineConfirmButton
      onConfirm={() => {
        for (const s of ended) dismissConversation(s.id)
      }}
      confirmLabel={<span className="text-muted-foreground">dismiss {ended.length}?</span>}
      trigger={requestConfirm => (
        <div
          role="button"
          tabIndex={0}
          onClick={requestConfirm}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') requestConfirm(e)
          }}
          className="text-[9px] text-muted-foreground/40 hover:text-destructive cursor-pointer px-1 transition-colors"
          title={`Dismiss ${ended.length} ended conversation${ended.length > 1 ? 's' : ''}`}
        >
          {'\u2715'} ended
        </div>
      )}
    />
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
    // Project-level rollups: any conversation in this project needing attention?
    const hasPendingPermission = useConversationsStore(s => {
      const ids = new Set(sessions.map(x => x.id))
      return s.pendingPermissions.some(p => ids.has(p.conversationId))
    })
    const hasPendingLink = useConversationsStore(s => {
      const ids = new Set(sessions.map(x => x.id))
      return s.pendingProjectLinks.some(r => ids.has(r.fromSession) || ids.has(r.toSession))
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
              {ps?.pinned && <Pin className="h-2.5 w-2.5 text-muted-foreground/30 shrink-0" />}
              <span className="text-[10px] text-muted-foreground font-mono">{sessions.length} conversations</span>
              {hasPendingLink && (
                <span
                  className="text-[9px] text-teal-400 font-bold animate-pulse"
                  title="A conversation in this project has a pending link request"
                >
                  LINK
                </span>
              )}
              {hasPendingPermission && (
                <span
                  className="text-[9px] text-amber-400 font-bold animate-pulse"
                  title="A conversation in this project has a pending permission request"
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

// ─── Pinned project node (no active conversations) ────────────────

export function PinnedProjectNode({ project }: { project: string }) {
  const [showSettings, setShowSettings] = useState(false)
  const ps = useConversationsStore(s => s.projectSettings[project])
  const selectProject = useConversationsStore(s => s.selectProject)
  const isSelected = useConversationsStore(s => s.selectedProjectUri === project)
  const displayName = ps?.label || extractProjectLabel(project)
  const displayColor = ps?.color

  return (
    <PinnedProjectContextMenu project={project} onOpenSettings={() => setShowSettings(true)}>
      <div>
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            haptic('tap')
            selectProject(project)
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              haptic('tap')
              selectProject(project)
            }
          }}
          className={cn(
            'border border-border hover:border-primary p-2 pl-3 transition-colors cursor-pointer',
            isSelected && 'border-primary bg-accent/10',
          )}
          style={displayColor ? { borderLeftColor: displayColor, borderLeftWidth: '3px' } : undefined}
          title={projectPath(project)}
        >
          <div className="flex items-center gap-1.5">
            {ps?.icon && (
              <span className="text-muted-foreground" style={displayColor ? { color: displayColor } : undefined}>
                {renderProjectIcon(ps.icon)}
              </span>
            )}
            <span
              className="font-mono text-xs truncate flex-1"
              style={displayColor ? { color: displayColor } : undefined}
            >
              {displayName}
            </span>
            <Pin className="h-2.5 w-2.5 text-muted-foreground/30 shrink-0" />
          </div>
        </div>
        {showSettings && <ProjectSettingsEditor project={project} onClose={() => setShowSettings(false)} />}
      </div>
    </PinnedProjectContextMenu>
  )
}

// ─── Project node renderer (single or multi-session) ─────────────

export const ProjectNode = memo(
  function ProjectNode({ project, sessions }: { project: string; sessions: Session[] }) {
    const isPinned = useConversationsStore(s => s.projectSettings[project]?.pinned)
    if (sessions.length === 1) {
      return (
        <div className="relative">
          <ConversationCard session={sessions[0]} />
          {isPinned && <Pin className="absolute top-2 right-8 h-2.5 w-2.5 text-muted-foreground/25" />}
        </div>
      )
    }
    return <ProjectSessionGroup sessions={sessions} project={project} />
  },
  (prev, next) => prev.project === next.project && sessionsEqual(prev.sessions, next.sessions),
)
