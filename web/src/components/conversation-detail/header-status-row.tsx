import type { Session } from '@/lib/types'
import { cn, formatEffort, formatModel, formatPermissionMode } from '@/lib/utils'

export function StatusRow({ session, model }: { session: Session; model: string | undefined }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span
        className={cn(
          'px-2 py-0.5 text-[10px] uppercase font-bold',
          session.status === 'active' && 'bg-active text-background',
          session.status === 'idle' && 'bg-idle text-background',
          session.status === 'starting' && 'bg-idle/50 text-background animate-pulse',
          session.status === 'ended' && 'bg-ended text-foreground',
        )}
      >
        {session.status}
      </span>
      <span className="text-foreground">
        {formatModel(model || session.model)}
        {session.effortLevel &&
          (() => {
            const effort = formatEffort(session.effortLevel)
            return effort ? (
              <span className="text-muted-foreground ml-1">
                {effort.symbol} {effort.label}
              </span>
            ) : null
          })()}
      </span>
      {(() => {
        const pm = formatPermissionMode(session.permissionMode)
        if (!pm) return null
        return (
          <span
            className={cn('px-1.5 py-0.5 text-[9px] font-bold uppercase', pm.color, pm.bgColor)}
            title={`Permission mode: ${session.permissionMode}`}
          >
            {pm.label}
          </span>
        )
      })()}
      {session.claudeVersion && <span className="text-muted-foreground text-[10px]">cc/{session.claudeVersion}</span>}
      {session.claudeAuth?.email && (
        <span className="text-cyan-400/70 text-[10px]">
          {session.claudeAuth.email.split('@')[0]}
          {session.claudeAuth.orgName ? ` / ${session.claudeAuth.orgName}` : ''}
          {session.claudeAuth.subscriptionType ? (
            <span className="text-muted-foreground ml-1">[{session.claudeAuth.subscriptionType}]</span>
          ) : null}
        </span>
      )}
      {session.gitBranch && (
        <span className="text-purple-400 text-[10px]">
          <span className="text-muted-foreground">branch:</span> {session.gitBranch}
        </span>
      )}
      {session.adHocWorktree && (
        <span className="px-1.5 py-0.5 text-[9px] uppercase font-bold bg-orange-400/20 text-orange-400">worktree</span>
      )}
      {(session.title || session.agentName) && (
        <span className="text-foreground text-[10px]">{session.title || session.agentName}</span>
      )}
      {session.description && (
        <span className="text-muted-foreground/70 text-[10px] italic">{session.description}</span>
      )}
      <span
        className="text-muted-foreground text-[10px]"
        title={`session: ${session.id}\nconnections: ${session.connectionIds?.join(', ') || 'none'}`}
      >
        {session.id.slice(0, 8)}
        {session.connectionIds?.[0] && session.connectionIds[0] !== session.id && (
          <span className="text-muted-foreground/50"> c:{session.connectionIds[0].slice(0, 6)}</span>
        )}
      </span>
      {session.capabilities &&
        session.capabilities.length > 0 &&
        session.capabilities.map(cap => (
          <span
            key={cap}
            className={cn(
              'px-1.5 py-0.5 text-[9px] uppercase font-bold',
              cap === 'channel'
                ? 'bg-teal-400/20 text-teal-400'
                : cap === 'repl'
                  ? 'bg-violet-400/20 text-violet-400'
                  : 'bg-sky-400/20 text-sky-400',
            )}
          >
            {cap}
          </span>
        ))}
    </div>
  )
}
