import { useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import type { Session } from '@/lib/types'
import { haptic, lastPathSegments } from '@/lib/utils'
import { ProjectSettingsButton, ProjectSettingsEditor, renderProjectIcon } from '../project-settings-editor'
import { partitionSessions } from './partition'
import { ProjectContextMenu, SessionContextMenu } from './session-context-menu'
import { SessionCard, SessionItemCompact } from './session-item'

// ─── Dismiss all ended sessions button ────────────────────────────

function DismissAllEndedButton({ ended }: { ended: Session[] }) {
  const dismissSession = useSessionsStore(s => s.dismissSession)
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

// ─── Multi-session CWD card ────────────────────────────────────────

function CwdSessionGroup({ sessions, cwd }: { sessions: Session[]; cwd: string }) {
  const [showSettings, setShowSettings] = useState(false)
  const ps = useSessionsStore(s => s.projectSettings[cwd])
  const displayName = ps?.label || lastPathSegments(cwd)
  const displayColor = ps?.color
  const { adhoc, normal, ended } = partitionSessions(sessions)

  return (
    <div>
      <div
        className="border border-border"
        style={displayColor ? { borderLeftColor: displayColor, borderLeftWidth: '3px' } : undefined}
      >
        <ProjectContextMenu cwd={cwd} sessions={sessions} onOpenSettings={() => setShowSettings(true)}>
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
            <SessionContextMenu key={session.id} session={session}>
              <div>
                <SessionItemCompact session={session} />
              </div>
            </SessionContextMenu>
          ))}
          {adhoc.length > 0 && normal.length > 0 && (
            <div className="flex items-center gap-2 px-3 py-1">
              <span className="flex-1 h-px bg-border" />
              <span className="text-[9px] text-muted-foreground/40 uppercase tracking-wider">ad-hoc</span>
              <span className="flex-1 h-px bg-border" />
            </div>
          )}
          {adhoc.map(session => (
            <SessionContextMenu key={session.id} session={session}>
              <div>
                <SessionItemCompact session={session} />
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

export function CwdNode({ cwd, sessions }: { cwd: string; sessions: Session[] }) {
  if (sessions.length === 1) return <SessionCard session={sessions[0]} />
  return <CwdSessionGroup sessions={sessions} cwd={cwd} />
}
