import type { Conversation } from '@/lib/types'
import { cn, formatEffort, formatModel, formatPermissionMode } from '@/lib/utils'

export function StatusRow({ conversation, model }: { conversation: Conversation; model: string | undefined }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span
        className={cn(
          'px-2 py-0.5 text-[10px] uppercase font-bold',
          conversation.status === 'active' && 'bg-active text-background',
          conversation.status === 'idle' && 'bg-idle text-background',
          conversation.status === 'starting' && 'bg-idle/50 text-background animate-pulse',
          conversation.status === 'ended' && 'bg-ended text-foreground',
        )}
      >
        {conversation.status}
      </span>
      <span className="text-foreground">
        {formatModel(model || conversation.model)}
        {conversation.effortLevel &&
          (() => {
            const effort = formatEffort(conversation.effortLevel)
            return effort ? (
              <span className="text-muted-foreground ml-1">
                {effort.symbol} {effort.label}
              </span>
            ) : null
          })()}
      </span>
      {(() => {
        const pm = formatPermissionMode(conversation.permissionMode)
        if (!pm) return null
        return (
          <span className={cn('px-1.5 py-0.5 text-[9px] font-bold uppercase', pm.color, pm.bgColor)} title={pm.title}>
            {pm.label}
          </span>
        )
      })()}
      {conversation.claudeVersion && (
        <span className="text-muted-foreground text-[10px]">cc/{conversation.claudeVersion}</span>
      )}
      {conversation.claudeAuth?.email && (
        <span className="text-cyan-400/70 text-[10px]">
          {conversation.claudeAuth.email.split('@')[0]}
          {conversation.claudeAuth.orgName ? ` / ${conversation.claudeAuth.orgName}` : ''}
          {conversation.claudeAuth.subscriptionType ? (
            <span className="text-muted-foreground ml-1">[{conversation.claudeAuth.subscriptionType}]</span>
          ) : null}
        </span>
      )}
      {conversation.gitBranch && (
        <span className="text-purple-400 text-[10px]">
          <span className="text-muted-foreground">branch:</span> {conversation.gitBranch}
        </span>
      )}
      {conversation.adHocWorktree && (
        <span className="px-1.5 py-0.5 text-[9px] uppercase font-bold bg-orange-400/20 text-orange-400">worktree</span>
      )}
      {(conversation.title || conversation.agentName) && (
        <span className="text-foreground text-[10px]">{conversation.title || conversation.agentName}</span>
      )}
      {conversation.description && (
        <span className="text-muted-foreground/70 text-[10px] italic">{conversation.description}</span>
      )}
      <span
        className="text-muted-foreground text-[10px]"
        title={`conversation: ${conversation.id}\nconnections: ${conversation.connectionIds?.join(', ') || 'none'}`}
      >
        {conversation.id.slice(0, 8)}
        {conversation.connectionIds?.[0] && conversation.connectionIds[0] !== conversation.id && (
          <span className="text-muted-foreground/50"> c:{conversation.connectionIds[0].slice(0, 6)}</span>
        )}
      </span>
      {conversation.capabilities &&
        conversation.capabilities.length > 0 &&
        conversation.capabilities.map(cap => (
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
