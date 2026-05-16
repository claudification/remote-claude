import type { ProjectSettings } from '@shared/protocol'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { CacheExpiredBanner } from '@/components/cache-timer'
import type { Conversation } from '@/lib/types'
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
  conversation: Conversation
  projectSettings: ProjectSettings | undefined
  model: string | undefined
  inPlanMode: boolean
  infoExpanded: boolean
  onToggleExpanded: () => void
  onSetConversationTarget: (target: ConversationTarget | null) => void
}

export function ConversationHeader({
  conversation,
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
            conversation={conversation}
            projectSettings={projectSettings}
            model={model}
            inPlanMode={inPlanMode}
          />
        )}
      </button>
      {!infoExpanded && (conversation.recap || conversation.description) && (
        <RecapPreview conversation={conversation} />
      )}
      <CacheExpiredBanner
        lastTurnEndedAt={conversation.lastTurnEndedAt}
        tokenUsage={conversation.tokenUsage}
        model={model || conversation.model}
        cacheTtl={conversation.cacheTtl}
        isIdle={conversation.status === 'idle'}
      />
      {infoExpanded && (
        <HeaderExpandedPanel
          conversation={conversation}
          projectSettings={projectSettings}
          model={model}
          onSetConversationTarget={onSetConversationTarget}
        />
      )}
    </div>
  )
}

function RecapPreview({ conversation }: { conversation: Conversation }) {
  const [expanded, setExpanded] = useState(false)
  const text = conversation.recap?.content || conversation.description
  if (!text) return null

  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation()
        setExpanded(v => !v)
      }}
      className="w-full text-left px-3 pb-1 -mt-1"
    >
      {expanded ? (
        <div className="space-y-0.5 pb-0.5">
          {conversation.description && conversation.recap && (
            <div className="text-[10px] text-muted-foreground/70 italic truncate">{conversation.description}</div>
          )}
          <div
            className={cn(
              'text-[10px] whitespace-pre-wrap',
              conversation.recap && conversation.recapFresh
                ? 'text-zinc-300 border-l-2 border-zinc-500/60 pl-2 bg-zinc-800/20 rounded-r py-1'
                : conversation.recap
                  ? 'text-zinc-400'
                  : 'text-muted-foreground/70 italic',
            )}
          >
            {conversation.recap?.title && (
              <span className="font-medium text-zinc-300/90">{conversation.recap.title}: </span>
            )}
            {text}
          </div>
        </div>
      ) : (
        <div className="text-[10px] text-muted-foreground/50 truncate">
          {conversation.recap?.title
            ? `${conversation.recap.title}...`
            : text.slice(0, 60).trim() + (text.length > 60 ? '...' : '')}
        </div>
      )}
    </button>
  )
}
