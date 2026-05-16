import { type Conversation, canTerminal, projectPath } from '@/lib/types'
import { cn, formatAge, formatModel, projectDisplayName } from '@/lib/utils'
import { renderProjectIcon } from '../project-settings-editor'
import type { ConversationResultsProps } from './types'

function statusIndicator(s: Conversation, selectedConversationId: string | null) {
  if (canTerminal(s)) return '\u25B6' // ▶
  if (s.id === selectedConversationId) return '\u25C9' // ◉
  if (s.status === 'active') return '\u25CF' // ●
  if (s.status === 'starting') return '\u25CB' // ○ (pulsing in sidebar)
  if (s.status === 'idle') return '\u25CB' // ○
  return '\u2716' // ✖
}

function statusColor(s: Conversation, selectedConversationId: string | null) {
  if (canTerminal(s)) return s.status === 'active' ? 'text-active' : 'text-accent'
  if (s.id === selectedConversationId) return 'text-primary'
  if (s.status === 'active') return 'text-active'
  if (s.status === 'starting' || s.status === 'idle') return 'text-accent'
  return 'text-comment'
}

function actionLabel(s: Conversation, selectedConversationId: string | null) {
  if (canTerminal(s)) return s.id === selectedConversationId ? 'TTY (current)' : 'TTY'
  if (s.status === 'ended') return 'revive'
  return ''
}

interface ConversationRowProps {
  conversation: Conversation
  selectedConversationId: string | null
  projectSettings: ConversationResultsProps['projectSettings']
  active: boolean
  onSelect: () => void
  onMouseEnter: () => void
}

export function ConversationRow({
  conversation,
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
      <span className={cn('text-sm', statusColor(conversation, selectedConversationId))}>
        {statusIndicator(conversation, selectedConversationId)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-foreground truncate flex items-center gap-1.5">
          {projectSettings[conversation.project]?.icon && (
            <span
              style={
                projectSettings[conversation.project]?.color
                  ? { color: projectSettings[conversation.project].color }
                  : undefined
              }
            >
              {renderProjectIcon(projectSettings[conversation.project]?.icon || '', 'w-3 h-3 inline')}
            </span>
          )}
          <span
            style={
              projectSettings[conversation.project]?.color
                ? { color: projectSettings[conversation.project].color }
                : undefined
            }
          >
            {projectDisplayName(projectPath(conversation.project), projectSettings[conversation.project]?.label)}
          </span>
          {(conversation.title || conversation.agentName) && (
            <>
              <span className="text-comment">·</span>
              <span className="text-primary truncate">{conversation.title || conversation.agentName}</span>
            </>
          )}
        </div>
        <div className="text-[10px] text-comment flex items-center gap-2">
          <span>{conversation.id.slice(0, 8)}</span>
          <span>{formatAge(conversation.lastActivity)}</span>
          {conversation.model && <span>{formatModel(conversation.model)}</span>}
        </div>
        {conversation.recap?.title && (
          <div className="mt-0.5 text-[10px] text-zinc-400/80 truncate" title={conversation.recap.title}>
            {conversation.recap.title}
          </div>
        )}
      </div>
      {actionLabel(conversation, selectedConversationId) && (
        <span className={cn('text-[10px]', canTerminal(conversation) ? 'text-active' : 'text-comment')}>
          {actionLabel(conversation, selectedConversationId)}
        </span>
      )}
    </button>
  )
}
