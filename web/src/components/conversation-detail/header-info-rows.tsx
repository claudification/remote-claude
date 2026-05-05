import type { ProjectSettings } from '@shared/protocol'
import { Copy } from 'lucide-react'
import { wsSend } from '@/hooks/use-conversations'
import type { Session } from '@/lib/types'
import { projectPath } from '@/lib/types'
import { cn, formatTime, haptic } from '@/lib/utils'
import type { ConversationTarget } from './conversation-header'

export function ErrorBanner({ lastError }: { lastError: Session['lastError'] }) {
  if (!lastError) return null
  return (
    <div className="px-2 py-1.5 bg-destructive/15 border border-destructive/40 text-[10px] font-mono space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="text-destructive font-bold uppercase">API Error</span>
        {lastError.errorType && <span className="text-destructive/80">{lastError.errorType}</span>}
        <span className="text-muted-foreground ml-auto">{formatTime(lastError.timestamp)}</span>
      </div>
      {lastError.errorMessage && <div className="text-destructive/70">{lastError.errorMessage}</div>}
      {lastError.stopReason && <div className="text-muted-foreground">reason: {lastError.stopReason}</div>}
    </div>
  )
}

export function RateLimitBanner({ rateLimit }: { rateLimit: Session['rateLimit'] }) {
  if (!rateLimit) return null
  return (
    <div className="px-2 py-1 bg-amber-500/10 border border-amber-500/30 text-[10px] font-mono flex items-center gap-2">
      <span className="text-amber-400 font-bold uppercase">Rate Limited</span>
      <span className="text-amber-400/70">{rateLimit.message}</span>
      <span className="text-muted-foreground ml-auto">{formatTime(rateLimit.timestamp)}</span>
    </div>
  )
}

export function ProjectPathRow({ project }: { project: string }) {
  return (
    <div className="flex items-center gap-1 group/project">
      <span className="text-[10px] text-muted-foreground truncate">{projectPath(project)}</span>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(projectPath(project))
          haptic('tap')
        }}
        className="shrink-0 text-muted-foreground/30 hover:text-muted-foreground [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/project:opacity-100 transition-opacity"
        title="Copy path"
      >
        <Copy className="w-3 h-3" />
      </button>
    </div>
  )
}

export function SummaryRow({ summary }: { summary: string | undefined }) {
  if (!summary) return null
  return (
    <div className="text-[10px] text-muted-foreground/70 truncate" title={summary}>
      {summary}
    </div>
  )
}

export function RecapRow({ recap, recapFresh }: { recap: Session['recap']; recapFresh: boolean | undefined }) {
  if (!recap) return null
  return (
    <div
      className={cn(
        'text-[10px] transition-all duration-700',
        recapFresh
          ? 'text-zinc-300/70 border-l-2 border-zinc-500/40 pl-2 py-1 bg-zinc-800/15 rounded-r leading-relaxed'
          : 'text-muted-foreground/40 italic truncate',
      )}
      title={recap.content}
    >
      {recapFresh ? recap.content : `Recap: ${recap.content}`}
    </div>
  )
}

export function PrLinksRow({ prLinks }: { prLinks: Session['prLinks'] }) {
  if (!prLinks || prLinks.length === 0) return null
  return (
    <div className="flex items-center gap-2 mt-0.5">
      {prLinks.map(pr => (
        <a
          key={pr.prUrl}
          href={pr.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] font-mono text-sky-400 hover:text-sky-300 hover:underline transition-colors"
        >
          {pr.prRepository.split('/').pop()}#{pr.prNumber}
        </a>
      ))}
    </div>
  )
}

export function TrustLevelBadge({ projectSettings }: { projectSettings: ProjectSettings | undefined }) {
  if (!projectSettings?.trustLevel || projectSettings.trustLevel === 'default') return null
  return (
    <div className="mt-1">
      <span
        className={cn(
          'px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider border rounded',
          projectSettings.trustLevel === 'open'
            ? 'bg-green-400/15 text-green-400 border-green-400/30'
            : 'bg-amber-400/15 text-amber-400 border-amber-400/30',
        )}
      >
        {projectSettings.trustLevel === 'open' ? '🔓 Open' : '🤝 Benevolent'}
      </span>
    </div>
  )
}

export function LinkedProjects({
  session,
  projectSettings,
  onSetConversationTarget,
}: {
  session: Session
  projectSettings: ProjectSettings | undefined
  onSetConversationTarget: (target: ConversationTarget | null) => void
}) {
  if (!session.linkedProjects || session.linkedProjects.length === 0) return null
  return (
    <div className="flex items-center gap-2 mt-1 flex-wrap">
      <span className="text-[10px] text-teal-400/60">projects:</span>
      {session.linkedProjects.map(lp => (
        <span key={lp.project} className="inline-flex items-center gap-1 text-[10px] font-mono">
          <button
            type="button"
            className="text-teal-400 hover:text-teal-300 hover:underline cursor-pointer"
            onClick={() => {
              haptic('tap')
              const myName =
                projectSettings?.label || projectPath(session.project).split('/').pop() || session.id.slice(0, 8)
              onSetConversationTarget({
                projectA: session.project,
                projectB: lp.project,
                nameA: myName,
                nameB: lp.name,
              })
            }}
            title={`View conversation with ${lp.name}`}
          >
            {lp.name}
          </button>
          <button
            type="button"
            onClick={() => {
              haptic('error')
              wsSend('channel_unlink', { projectA: session.project, projectB: lp.project })
            }}
            className="text-red-400/40 hover:text-red-400 transition-colors"
            title={`Sever link to ${lp.name}`}
          >
            x
          </button>
        </span>
      ))}
    </div>
  )
}
