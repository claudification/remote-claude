import { useState } from 'react'
import { useConversationsStore, wsSend } from '@/hooks/use-conversations'
import type { Session } from '@/lib/types'
import { extractProjectLabel, projectPath } from '@/lib/types'
import { cn, contextWindowSize, formatModel, haptic } from '@/lib/utils'
import { renderProjectIcon } from '../project-settings-editor'
import { openReviveDialog } from '../revive-dialog'
import { openSpawnDialog } from '../spawn-dialog'

function matchesFilter(session: Session, query: string): boolean {
  const q = query.toLowerCase()
  const fields = [
    session.title,
    session.agentName,
    session.recap?.title,
    session.recap?.content,
    session.summary,
    session.id,
  ]
  return fields.some(f => f?.toLowerCase().includes(q))
}

function formatTokens(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function ContextBar({ session }: { session: Session }) {
  const usage = session.tokenUsage
  if (!usage) return null
  const total = usage.input + usage.cacheCreation + usage.cacheRead
  if (total === 0) return null
  const maxTokens = session.contextWindow ?? contextWindowSize(session.model)
  const pct = Math.min(100, Math.round((total / maxTokens) * 100))

  return (
    <div className="flex items-center gap-1.5 mt-1">
      <span className="text-[9px] font-mono text-muted-foreground/60 shrink-0">{formatModel(session.model)}</span>
      <div className="flex-1 h-1 bg-muted/30 rounded-full overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full',
            pct < 60 ? 'bg-emerald-400/50' : pct < 80 ? 'bg-amber-400/50' : 'bg-red-400/60',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={cn(
          'text-[9px] font-mono tabular-nums shrink-0',
          pct < 60 ? 'text-emerald-400/40' : pct < 80 ? 'text-amber-400/40' : 'text-red-400/50',
        )}
      >
        {formatTokens(total)}
      </span>
    </div>
  )
}

function RecapButton({ conversationId }: { conversationId: string }) {
  const [pending, setPending] = useState(false)

  return (
    <button
      type="button"
      disabled={pending}
      className="text-[10px] font-mono text-amber-400/70 hover:text-amber-400 transition-colors disabled:opacity-40"
      onClick={e => {
        e.stopPropagation()
        haptic('tap')
        setPending(true)
        wsSend('recap_request', { conversationId })
        setTimeout(() => setPending(false), 15_000)
      }}
    >
      {pending ? '...' : 'RECAP'}
    </button>
  )
}

function RecentConversationItem({ session }: { session: Session }) {
  const selectConversation = useConversationsStore(s => s.selectConversation)
  const sentinelConnected = useConversationsStore(s => s.sentinelConnected)
  const name = session.title || session.agentName || session.recap?.title || session.id.slice(0, 8)
  const recap = session.recap?.content || session.summary
  const ago = formatTimeAgo(session.lastActivity)
  const hasRecap = !!session.recap

  return (
    <div className="px-3 py-2 border border-border hover:border-primary transition-colors space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-primary truncate flex-1">{name}</span>
        <span className="text-[10px] text-muted-foreground/70 shrink-0">{ago}</span>
        {!hasRecap && <RecapButton conversationId={session.id} />}
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
      <ContextBar session={session} />
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
  const description = session.recap?.content || session.summary

  return (
    <div className="px-3 py-2 border border-border hover:border-primary transition-colors space-y-1">
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
      {description && (
        <div className="text-[11px] leading-relaxed text-muted-foreground truncate mt-0.5">{description}</div>
      )}
      <ContextBar session={session} />
    </div>
  )
}

function RecapAllButton({ conversations }: { conversations: Session[] }) {
  const withoutRecap = conversations.filter(s => !s.recap)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(0)

  if (withoutRecap.length === 0) return null

  return (
    <button
      type="button"
      disabled={pending}
      className="text-[10px] font-mono text-amber-400/70 hover:text-amber-400 transition-colors disabled:opacity-40"
      onClick={() => {
        haptic('tap')
        setPending(true)
        setDone(0)
        let i = 0
        function next() {
          if (i >= withoutRecap.length) {
            setPending(false)
            return
          }
          wsSend('recap_request', { conversationId: withoutRecap[i].id })
          setDone(++i)
          setTimeout(next, 500)
        }
        next()
      }}
    >
      {pending ? `RECAPPING ${done}/${withoutRecap.length}` : `RECAP ${withoutRecap.length} MISSING`}
    </button>
  )
}

export function ProjectActionPanel({ projectUri }: { projectUri: string }) {
  const ps = useConversationsStore(s => s.projectSettings[projectUri])
  const sessions = useConversationsStore(s => s.sessions)
  const sentinelConnected = useConversationsStore(s => s.sentinelConnected)
  const [showAllRecent, setShowAllRecent] = useState(false)
  const [filter, setFilter] = useState('')

  const displayName = ps?.label || extractProjectLabel(projectUri)
  const displayColor = ps?.color
  const path = projectPath(projectUri)

  const projectSessions = sessions.filter(s => s.project === projectUri)
  const activeConversations = projectSessions
    .filter(s => s.status !== 'ended')
    .sort((a, b) => b.lastActivity - a.lastActivity)

  const recentEnded = projectSessions.filter(s => s.status === 'ended').sort((a, b) => b.lastActivity - a.lastActivity)

  const filteredActive = filter ? activeConversations.filter(s => matchesFilter(s, filter)) : activeConversations
  const filteredRecent = filter ? recentEnded.filter(s => matchesFilter(s, filter)) : recentEnded
  const visibleRecent = !filter && !showAllRecent ? filteredRecent.slice(0, 5) : filteredRecent
  const hasAny = recentEnded.length > 0 || activeConversations.length > 0

  return (
    <div className="flex items-start justify-center h-full overflow-y-auto text-muted-foreground">
      <div className="w-full max-w-md space-y-4 px-4 py-8">
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
              openSpawnDialog({ path, projectUri })
            }}
            className="px-4 py-1.5 text-xs font-mono border border-cyan-400/50 text-cyan-400 hover:bg-cyan-400/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            LAUNCH
          </button>
        </div>

        {/* Search filter */}
        {hasAny && (
          <input
            type="text"
            value={filter}
            onChange={e => {
              setFilter(e.target.value)
              if (e.target.value) setShowAllRecent(true)
            }}
            placeholder="Filter by name or recap..."
            className="w-full px-3 py-1.5 text-xs font-mono bg-background border border-border focus:border-primary outline-none transition-colors placeholder:text-muted-foreground/40"
          />
        )}

        {/* Active conversations */}
        {filteredActive.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] text-emerald-400/70 font-bold uppercase tracking-wider px-1 flex items-center gap-2">
              <span>Active ({filteredActive.length})</span>
              <span className="flex-1 h-px bg-emerald-400/20" />
            </div>
            {filteredActive.map(s => (
              <ActiveConversationItem key={s.id} session={s} />
            ))}
          </div>
        )}

        {/* Recent conversations */}
        {filteredRecent.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] text-muted-foreground/70 font-bold uppercase tracking-wider px-1 flex items-center gap-2">
              <span>Recent conversations</span>
              <span className="flex-1 h-px bg-border" />
              <RecapAllButton conversations={filteredRecent} />
            </div>
            {visibleRecent.map(s => (
              <RecentConversationItem key={s.id} session={s} />
            ))}
            {!filter && recentEnded.length > 5 && !showAllRecent && (
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

        {!hasAny && <div className="text-center text-xs text-muted-foreground/40">No conversations</div>}
        {hasAny && filteredActive.length === 0 && filteredRecent.length === 0 && filter && (
          <div className="text-center text-xs text-muted-foreground/40">No matches for "{filter}"</div>
        )}
      </div>
    </div>
  )
}
