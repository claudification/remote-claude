import type { ProjectSettings } from '@shared/protocol'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CacheExpiredBanner } from '@/components/cache-timer'
import type { Session } from '@/lib/types'
import { cn } from '@/lib/utils'
import { HeaderCollapsedBar } from './header-collapsed-bar'
import { HeaderExpandedPanel } from './header-expanded-panel'

export interface ConversationTarget {
  projectA: string
  projectB: string
  nameA: string
  nameB: string
}

interface ConversationHeaderProps {
  session: Session
  projectSettings: ProjectSettings | undefined
  model: string | undefined
  inPlanMode: boolean
  infoExpanded: boolean
  onToggleExpanded: () => void
  onSetConversationTarget: (target: ConversationTarget | null) => void
}

export function ConversationHeader({
  session,
  projectSettings,
  model,
  inPlanMode,
  infoExpanded,
  onToggleExpanded,
  onSetConversationTarget,
}: ConversationHeaderProps) {
  return (
    <div className="shrink-0 border-b border-border max-h-[30vh] overflow-y-auto">
      <button
        type="button"
        onClick={onToggleExpanded}
        className="w-full p-3 sm:p-4 flex items-center gap-2 hover:bg-muted/30 transition-colors"
      >
        {infoExpanded ? (
          <>
            <ChevronDown className="w-3 h-3 text-muted-foreground" />
            <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Conversation Info</span>
          </>
        ) : (
          <ChevronRight className="w-3 h-3 text-muted-foreground" />
        )}
        {!infoExpanded && (
          <HeaderCollapsedBar
            session={session}
            projectSettings={projectSettings}
            model={model}
            inPlanMode={inPlanMode}
          />
        )}
      </button>
      {!infoExpanded && (session.recap || session.description) && (
        <div
          className={cn(
            'px-3 pb-1.5 -mt-0.5 text-[10px] truncate transition-all duration-700',
            session.recap && session.recapFresh
              ? 'text-zinc-300 border-l-2 border-zinc-500/60 ml-3 pl-2 bg-zinc-800/20 rounded-r'
              : 'text-muted-foreground/70 italic',
          )}
          title={session.recap?.content || session.description}
        >
          {session.recap?.content || session.description}
        </div>
      )}
      <CacheExpiredBanner
        lastTurnEndedAt={session.lastTurnEndedAt}
        tokenUsage={session.tokenUsage}
        model={model || session.model}
        cacheTtl={session.cacheTtl}
        isIdle={session.status === 'idle'}
      />
      {infoExpanded && (
        <HeaderExpandedPanel
          session={session}
          projectSettings={projectSettings}
          model={model}
          onSetConversationTarget={onSetConversationTarget}
        />
      )}
    </div>
  )
}
