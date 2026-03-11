import { canTerminal, type Session } from '@/lib/types'
import { cn, formatAge, lastPathSegments } from '@/lib/utils'
import { renderProjectIcon } from '../project-settings-editor'
import type { SessionResultsProps } from './types'

function statusIndicator(s: Session, selectedSessionId: string | null) {
  if (canTerminal(s)) return '\u25B6' // ▶
  if (s.id === selectedSessionId) return '\u25C9' // ◉
  if (s.status === 'active') return '\u25CF' // ●
  if (s.status === 'idle') return '\u25CB' // ○
  return '\u2716' // ✖
}

function statusColor(s: Session, selectedSessionId: string | null) {
  if (canTerminal(s)) return s.status === 'active' ? 'text-[#9ece6a]' : 'text-[#e0af68]'
  if (s.id === selectedSessionId) return 'text-[#7aa2f7]'
  if (s.status === 'active') return 'text-[#9ece6a]'
  if (s.status === 'idle') return 'text-[#e0af68]'
  return 'text-[#565f89]'
}

function actionLabel(s: Session, selectedSessionId: string | null) {
  if (canTerminal(s)) return s.id === selectedSessionId ? 'TTY (current)' : 'TTY'
  if (s.status === 'ended') return 'revive'
  return ''
}

export function SessionResults({
  sessions,
  selectedSessionId,
  projectSettings,
  activeIndex,
  setActiveIndex,
  onSelect,
}: SessionResultsProps) {
  if (sessions.length === 0) {
    return <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">No sessions</div>
  }

  return (
    <>
      {sessions.map((session, i) => (
        <button
          key={session.id}
          type="button"
          onClick={() => onSelect(session.id)}
          onMouseEnter={() => setActiveIndex(i)}
          className={cn(
            'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
            i === activeIndex ? 'bg-[#33467c]/50' : 'hover:bg-[#33467c]/25',
          )}
        >
          <span className={cn('text-sm', statusColor(session, selectedSessionId))}>
            {statusIndicator(session, selectedSessionId)}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-[#a9b1d6] truncate flex items-center gap-1.5">
              {projectSettings[session.cwd]?.icon && (
                <span
                  style={
                    projectSettings[session.cwd]?.color ? { color: projectSettings[session.cwd].color } : undefined
                  }
                >
                  {renderProjectIcon(projectSettings[session.cwd].icon!, 'w-3 h-3 inline')}
                </span>
              )}
              <span
                style={projectSettings[session.cwd]?.color ? { color: projectSettings[session.cwd].color } : undefined}
              >
                {projectSettings[session.cwd]?.label || lastPathSegments(session.cwd, 3)}
              </span>
            </div>
            <div className="text-[10px] text-[#565f89] flex items-center gap-2">
              <span>{session.id.slice(0, 8)}</span>
              <span>{formatAge(session.lastActivity)}</span>
              {session.model && <span>{session.model.replace('claude-', '').replace(/-\d{8}$/, '')}</span>}
            </div>
          </div>
          {actionLabel(session, selectedSessionId) && (
            <span className={cn('text-[10px]', canTerminal(session) ? 'text-[#9ece6a]' : 'text-[#565f89]')}>
              {actionLabel(session, selectedSessionId)}
            </span>
          )}
        </button>
      ))}
    </>
  )
}
