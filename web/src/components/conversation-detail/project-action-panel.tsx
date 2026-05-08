import { useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Session } from '@/lib/types'
import { extractProjectLabel, projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { renderProjectIcon } from '../project-settings-editor'
import { openReviveDialog } from '../revive-dialog'
import { openSpawnDialog } from '../spawn-dialog'

function RecentConversationItem({ session }: { session: Session }) {
  const selectConversation = useConversationsStore(s => s.selectConversation)
  const sentinelConnected = useConversationsStore(s => s.sentinelConnected)
  const name = session.title || session.agentName || session.recap?.title || session.id.slice(0, 8)
  const recap = session.recap?.content || session.summary
  const ago = formatTimeAgo(session.lastActivity)

  return (
    <div className="px-3 py-2 border border-border hover:border-primary transition-colors space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-primary truncate flex-1">{name}</span>
        <span className="text-[10px] text-muted-foreground/70 shrink-0">{ago}</span>
        <button
          type="button"
          className="text-[10px] font-mono text-accent hover:text-accent/80 transition-colors"
          onClick={() => {
            haptic('tap')
            selectConversation(session.id)
          }}
        >
          VIEW
        </button>
        {sentinelConnected && (
          <button
            type="button"
            className="text-[10px] font-mono text-emerald-400 hover:text-emerald-300 transition-colors"
            onClick={() => {
              haptic('tap')
              selectConversation(session.id)
              openReviveDialog({ conversationId: session.id })
            }}
          >
            REVIVE
          </button>
        )}
      </div>
      {recap && <div className="text-[11px] leading-relaxed text-muted-foreground whitespace-pre-line">{recap}</div>}
    </div>
  )
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const STATUS_COLORS: Record<string, string> = {
  active: 'text-emerald-400',
  idle: 'text-amber-400',
  starting: 'text-cyan-400',
  booting: 'text-cyan-400',
}

function ActiveConversationItem({ session }: { session: Session }) {
  const selectConversation = useConversationsStore(s => s.selectConversation)
  const name = session.title || session.agentName || session.id.slice(0, 8)
  const statusColor = STATUS_COLORS[session.status] || 'text-muted-foreground'

  return (
    <div className="px-3 py-2 border border-border hover:border-primary transition-colors">
      <div className="flex items-center gap-2">
        <span className={cn('text-[10px] font-mono uppercase shrink-0', statusColor)}>{session.status}</span>
        <span className="text-xs font-mono text-primary truncate flex-1">{name}</span>
        <button
          type="button"
          className="text-[10px] font-mono text-accent hover:text-accent/80 transition-colors"
          onClick={() => {
            haptic('tap')
            selectConversation(session.id)
          }}
        >
          VIEW
        </button>
      </div>
      {session.summary && (
        <div className="text-[11px] leading-relaxed text-muted-foreground truncate mt-0.5">{session.summary}</div>
      )}
    </div>
  )
}

export function ProjectActionPanel({ projectUri }: { projectUri: string }) {
  const ps = useConversationsStore(s => s.projectSettings[projectUri])
  const sessions = useConversationsStore(s => s.sessions)
  const sentinelConnected = useConversationsStore(s => s.sentinelConnected)
  const [showAllRecent, setShowAllRecent] = useState(false)

  const displayName = ps?.label || extractProjectLabel(projectUri)
  const displayColor = ps?.color
  const path = projectPath(projectUri)

  const activeConversations = sessions
    .filter(s => s.project === projectUri && s.status !== 'ended')
    .sort((a, b) => b.lastActivity - a.lastActivity)

  const recentEnded = sessions
    .filter(s => s.project === projectUri && s.status === 'ended')
    .sort((a, b) => b.lastActivity - a.lastActivity)

  const visibleRecent = showAllRecent ? recentEnded : recentEnded.slice(0, 5)

  return (
    <div className="flex items-center justify-center h-full text-muted-foreground">
      <div className="w-full max-w-md space-y-4 px-4">
        {/* Project header */}
        <div className="text-center space-y-1">
          {ps?.icon && (
            <div className="flex justify-center text-2xl" style={displayColor ? { color: displayColor } : undefined}>
              {renderProjectIcon(ps.icon, 'w-6 h-6')}
            </div>
          )}
          <h2 className="text-lg font-bold text-foreground" style={displayColor ? { color: displayColor } : undefined}>
            {displayName}
          </h2>
          <div className="text-xs font-mono text-muted-foreground">{path}</div>
          {ps?.description && <div className="text-xs text-muted-foreground/80">{ps.description}</div>}
        </div>

        {/* Actions */}
        <div className="flex gap-2 justify-center">
          <button
            type="button"
            disabled={!sentinelConnected}
            onClick={() => {
              haptic('tap')
              openSpawnDialog({ path })
            }}
            className="px-4 py-1.5 text-xs font-mono border border-cyan-400/50 text-cyan-400 hover:bg-cyan-400/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            LAUNCH
          </button>
        </div>

        {/* Active conversations */}
        {activeConversations.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] text-emerald-400/70 font-bold uppercase tracking-wider px-1 flex items-center gap-2">
              <span>Active ({activeConversations.length})</span>
              <span className="flex-1 h-px bg-emerald-400/20" />
            </div>
            {activeConversations.map(s => (
              <ActiveConversationItem key={s.id} session={s} />
            ))}
          </div>
        )}

        {/* Recent conversations */}
        {recentEnded.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] text-muted-foreground/70 font-bold uppercase tracking-wider px-1 flex items-center gap-2">
              <span>Recent conversations</span>
              <span className="flex-1 h-px bg-border" />
            </div>
            {visibleRecent.map(s => (
              <RecentConversationItem key={s.id} session={s} />
            ))}
            {recentEnded.length > 5 && !showAllRecent && (
              <button
                type="button"
                className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground px-1 transition-colors"
                onClick={() => setShowAllRecent(true)}
              >
                + {recentEnded.length - 5} more
              </button>
            )}
          </div>
        )}

        {recentEnded.length === 0 && activeConversations.length === 0 && (
          <div className="text-center text-xs text-muted-foreground/40">No conversations</div>
        )}
      </div>
    </div>
  )
}
