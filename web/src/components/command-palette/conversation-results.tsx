import { canTerminal, projectPath, type Session } from '@/lib/types'
import { cn, formatAge, formatModel, projectDisplayName } from '@/lib/utils'
import { renderProjectIcon } from '../project-settings-editor'
import type { SessionResultsProps } from './types'

function statusIndicator(s: Session, selectedSessionId: string | null) {
  if (canTerminal(s)) return '\u25B6' // ▶
  if (s.id === selectedSessionId) return '\u25C9' // ◉
  if (s.status === 'active') return '\u25CF' // ●
  if (s.status === 'starting') return '\u25CB' // ○ (pulsing in sidebar)
  if (s.status === 'idle') return '\u25CB' // ○
  return '\u2716' // ✖
}

function statusColor(s: Session, selectedSessionId: string | null) {
  if (canTerminal(s)) return s.status === 'active' ? 'text-[#9ece6a]' : 'text-[#e0af68]'
  if (s.id === selectedSessionId) return 'text-[#7aa2f7]'
  if (s.status === 'active') return 'text-[#9ece6a]'
  if (s.status === 'starting' || s.status === 'idle') return 'text-[#e0af68]'
  return 'text-[#565f89]'
}

function actionLabel(s: Session, selectedSessionId: string | null) {
  if (canTerminal(s)) return s.id === selectedSessionId ? 'TTY (current)' : 'TTY'
  if (s.status === 'ended') return 'revive'
  return ''
}

interface SessionRowProps {
  session: Session
  selectedSessionId: string | null
  projectSettings: SessionResultsProps['projectSettings']
  active: boolean
  onSelect: () => void
  onMouseEnter: () => void
}

export function SessionRow({
  session,
  selectedSessionId,
  projectSettings,
  active,
  onSelect,
  onMouseEnter,
}: SessionRowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={onMouseEnter}
      className={cn(
        'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
        active ? 'bg-[#33467c]/50' : 'hover:bg-[#33467c]/25',
      )}
    >
      <span className={cn('text-sm', statusColor(session, selectedSessionId))}>
        {statusIndicator(session, selectedSessionId)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-[#a9b1d6] truncate flex items-center gap-1.5">
          {projectSettings[session.project]?.icon && (
            <span
              style={
                projectSettings[session.project]?.color ? { color: projectSettings[session.project].color } : undefined
              }
            >
              {renderProjectIcon(projectSettings[session.project]?.icon || '', 'w-3 h-3 inline')}
            </span>
          )}
          <span
            style={
              projectSettings[session.project]?.color ? { color: projectSettings[session.project].color } : undefined
            }
          >
            {projectDisplayName(projectPath(session.project), projectSettings[session.project]?.label)}
          </span>
          {(session.title || session.agentName) && (
            <>
              <span className="text-[#3b4261]">·</span>
              <span className="text-[#7aa2f7] truncate">{session.title || session.agentName}</span>
            </>
          )}
        </div>
        <div className="text-[10px] text-[#565f89] flex items-center gap-2">
          <span>{session.id.slice(0, 8)}</span>
          <span>{formatAge(session.lastActivity)}</span>
          {session.model && <span>{formatModel(session.model)}</span>}
        </div>
      </div>
      {actionLabel(session, selectedSessionId) && (
        <span className={cn('text-[10px]', canTerminal(session) ? 'text-[#9ece6a]' : 'text-[#565f89]')}>
          {actionLabel(session, selectedSessionId)}
        </span>
      )}
    </button>
  )
}
