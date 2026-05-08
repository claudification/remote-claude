import { canTerminal, projectPath, type Session } from '@/lib/types'
import { cn, formatAge, formatModel, projectDisplayName } from '@/lib/utils'
import { renderProjectIcon } from '../project-settings-editor'
import type { ConversationResultsProps } from './types'

function statusIndicator(s: Session, selectedConversationId: string | null) {
  if (canTerminal(s)) return '\u25B6' // ▶
  if (s.id === selectedConversationId) return '\u25C9' // ◉
  if (s.status === 'active') return '\u25CF' // ●
  if (s.status === 'starting') return '\u25CB' // ○ (pulsing in sidebar)
  if (s.status === 'idle') return '\u25CB' // ○
  return '\u2716' // ✖
}

function statusColor(s: Session, selectedConversationId: string | null) {
  if (canTerminal(s)) return s.status === 'active' ? 'text-active' : 'text-accent'
  if (s.id === selectedConversationId) return 'text-primary'
  if (s.status === 'active') return 'text-active'
  if (s.status === 'starting' || s.status === 'idle') return 'text-accent'
  return 'text-comment'
}

function actionLabel(s: Session, selectedConversationId: string | null) {
  if (canTerminal(s)) return s.id === selectedConversationId ? 'TTY (current)' : 'TTY'
  if (s.status === 'ended') return 'revive'
  return ''
}

interface ConversationRowProps {
  session: Session
  selectedConversationId: string | null
  projectSettings: ConversationResultsProps['projectSettings']
  active: boolean
  onSelect: () => void
  onMouseEnter: () => void
}

export function ConversationRow({
  session,
  selectedConversationId,
  projectSettings,
  active,
  onSelect,
  onMouseEnter,
}: ConversationRowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={onMouseEnter}
      className={cn(
        'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
        active ? 'bg-primary/20' : 'hover:bg-primary/10',
      )}
    >
      <span className={cn('text-sm', statusColor(session, selectedConversationId))}>
        {statusIndicator(session, selectedConversationId)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-foreground truncate flex items-center gap-1.5">
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
              <span className="text-comment">·</span>
              <span className="text-primary truncate">{session.title || session.agentName}</span>
            </>
          )}
        </div>
        <div className="text-[10px] text-comment flex items-center gap-2">
          <span>{session.id.slice(0, 8)}</span>
          <span>{formatAge(session.lastActivity)}</span>
          {session.model && <span>{formatModel(session.model)}</span>}
        </div>
      </div>
      {actionLabel(session, selectedConversationId) && (
        <span className={cn('text-[10px]', canTerminal(session) ? 'text-active' : 'text-comment')}>
          {actionLabel(session, selectedConversationId)}
        </span>
      )}
    </button>
  )
}
