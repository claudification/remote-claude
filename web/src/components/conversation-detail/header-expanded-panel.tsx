import type { ProjectSettings } from '@shared/protocol'
import { CostSparkline } from '@/components/cost-sparkline'
import { formatCost, getBurnRate, getCacheEfficiency, getConversationCost, getCostColor } from '@/lib/cost-utils'
import type { Conversation } from '@/lib/types'
import { cn, contextWindowSize, formatAge, formatTime } from '@/lib/utils'
import type { ConversationTarget } from './conversation-header'
import { HeaderDescription } from './header-description'
import {
  ErrorBanner,
  LinkedProjects,
  PrLinksRow,
  ProjectPathRow,
  RateLimitBanner,
  RecapRow,
  SummaryRow,
  TrustLevelBadge,
} from './header-info-rows'
import { StatusRow } from './header-status-row'

interface HeaderExpandedPanelProps {
  conversation: Conversation
  projectSettings: ProjectSettings | undefined
  model: string | undefined
  onSetConversationTarget: (target: ConversationTarget | null) => void
}

export function HeaderExpandedPanel({
  conversation,
  projectSettings,
  model,
  onSetConversationTarget,
}: HeaderExpandedPanelProps) {
  const s = conversation.stats
  const tu = conversation.tokenUsage
  const contextTotal = tu ? tu.input + tu.cacheCreation + tu.cacheRead : 0
  const ctxWindow = conversation.contextWindow ?? contextWindowSize(model || conversation.model)
  const contextPct = tu ? Math.min(100, Math.round((contextTotal / ctxWindow) * 100)) : 0
  const compactThreshold = conversation.autocompactPct || 83
  const compactWarnAt = compactThreshold - 5

  const conversationCost = s ? getConversationCost(s, model || conversation.model) : { cost: 0, exact: false }
  const burnRate = s ? getBurnRate(conversationCost.cost, conversation.startedAt, conversation.lastActivity) : null
  const cacheEff = s ? getCacheEfficiency(s.totalCacheRead, s.totalCacheCreation) : null

  return (
    <div className="px-3 sm:px-4 pb-3 sm:pb-4 text-xs font-mono space-y-3">
      <StatusRow conversation={conversation} model={model} />
      <ContextBar
        tokenUsage={tu}
        contextPct={contextPct}
        contextTotal={contextTotal}
        ctxWindow={ctxWindow}
        compactThreshold={compactThreshold}
        compactWarnAt={compactWarnAt}
      />
      <TokenStats stats={s} conversationCost={conversationCost} burnRate={burnRate} cacheEff={cacheEff} />
      {conversation.costTimeline && conversation.costTimeline.length >= 2 && (
        <CostSparkline timeline={conversation.costTimeline} />
      )}
      <ConversationStats conversation={conversation} stats={s} />
      <ErrorBanner lastError={conversation.lastError} />
      <RateLimitBanner rateLimit={conversation.rateLimit} />
      <ProjectPathRow project={conversation.project} />
      <HeaderDescription conversation={conversation} />
      <SummaryRow summary={conversation.summary} />
      <RecapRow recap={conversation.recap} recapFresh={conversation.recapFresh} />
      <PrLinksRow prLinks={conversation.prLinks} />
      <TrustLevelBadge projectSettings={projectSettings} />
      <LinkedProjects
        conversation={conversation}
        projectSettings={projectSettings}
        onSetConversationTarget={onSetConversationTarget}
      />
    </div>
  )
}

interface ContextBarProps {
  tokenUsage: Conversation['tokenUsage']
  contextPct: number
  contextTotal: number
  ctxWindow: number
  compactThreshold: number
  compactWarnAt: number
}

function ContextBar({
  tokenUsage,
  contextPct,
  contextTotal,
  ctxWindow,
  compactThreshold,
  compactWarnAt,
}: ContextBarProps) {
  if (!tokenUsage) return null
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-[10px] w-16">context</span>
        <div className="relative flex-1 h-2 bg-muted rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              contextPct < compactWarnAt
                ? 'bg-emerald-400'
                : contextPct < compactThreshold
                  ? 'bg-amber-400'
                  : 'bg-red-400',
            )}
            style={{ width: `${contextPct}%` }}
          />
          <div
            className="absolute top-0 h-full w-px bg-amber-400/50"
            style={{ left: `${compactThreshold}%` }}
            title={`Compaction at ${compactThreshold}%`}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-16" />
        <span
          className={cn(
            'text-[10px] font-mono',
            contextPct < compactWarnAt
              ? 'text-emerald-400/70'
              : contextPct < compactThreshold
                ? 'text-amber-400/70'
                : 'text-red-400/70',
          )}
        >
          {Math.round(contextTotal / 1000).toLocaleString()}K / {Math.round(ctxWindow / 1000).toLocaleString()}K (
          {contextPct}%)
          {contextPct >= compactWarnAt && contextPct < compactThreshold && (
            <span className="text-amber-400/50 ml-1">-- compaction at {compactThreshold}%</span>
          )}
        </span>
      </div>
    </div>
  )
}

interface TokenStatsProps {
  stats: Conversation['stats']
  conversationCost: { cost: number; exact: boolean }
  burnRate: number | null
  cacheEff: { ratio: number; label: string; color: string } | null
}

function TokenStats({ stats: s, conversationCost, burnRate, cacheEff }: TokenStatsProps) {
  if (!s) return null
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-[10px]">
      <div>
        <span className="text-muted-foreground">in </span>
        <span className="text-cyan-400">{Math.round(s.totalInputTokens / 1000).toLocaleString()}K</span>
      </div>
      <div>
        <span className="text-muted-foreground">out </span>
        <span className="text-orange-400">{Math.round(s.totalOutputTokens / 1000).toLocaleString()}K</span>
      </div>
      <div>
        <span className="text-muted-foreground">cache r/w </span>
        <span className="text-blue-400">{Math.round(s.totalCacheRead / 1000).toLocaleString()}K</span>
        <span className="text-muted-foreground"> / </span>
        <span className="text-purple-400">{Math.round(s.totalCacheCreation / 1000).toLocaleString()}K</span>
        {cacheEff && (
          <>
            <br />
            <span className={cacheEff.color}>
              {cacheEff.ratio.toFixed(1)}x {cacheEff.label}
            </span>
          </>
        )}
      </div>
      <div>
        <span className="text-muted-foreground">cost </span>
        <span className={getCostColor(conversationCost.cost)}>
          {formatCost(conversationCost.cost, conversationCost.exact)}
        </span>
        {burnRate != null && burnRate >= 0.1 && (
          <span className="text-muted-foreground ml-1">({burnRate.toFixed(1)}/hr)</span>
        )}
      </div>
    </div>
  )
}

function ConversationStats({ conversation, stats: s }: { conversation: Conversation; stats: Conversation['stats'] }) {
  return (
    <div className="flex items-center gap-4 text-[10px] flex-wrap">
      {s && s.turnCount > 0 && (
        <span>
          <span className="text-muted-foreground">turns </span>
          <span className="text-foreground">{s.turnCount}</span>
        </span>
      )}
      {s && s.toolCallCount > 0 && (
        <span>
          <span className="text-muted-foreground">tools </span>
          <span className="text-foreground">{s.toolCallCount}</span>
        </span>
      )}
      {conversation.totalSubagentCount > 0 && (
        <span>
          <span className="text-muted-foreground">agents </span>
          <span className="text-foreground">{conversation.totalSubagentCount}</span>
        </span>
      )}
      {s && (s.linesAdded > 0 || s.linesRemoved > 0) && (
        <span>
          <span className="text-emerald-400">+{s.linesAdded}</span>
          <span className="text-muted-foreground">/</span>
          <span className="text-red-400">-{s.linesRemoved}</span>
        </span>
      )}
      {s && s.compactionCount > 0 && (
        <span>
          <span className="text-muted-foreground">compactions </span>
          <span className="text-amber-400">{s.compactionCount}</span>
        </span>
      )}
      {s && s.totalApiDurationMs > 0 && (
        <span>
          <span className="text-muted-foreground">API </span>
          <span className="text-foreground">
            {s.totalApiDurationMs < 60000
              ? `${(s.totalApiDurationMs / 1000).toFixed(0)}s`
              : `${Math.floor(s.totalApiDurationMs / 60000)}m${Math.round((s.totalApiDurationMs % 60000) / 1000)}s`}
          </span>
        </span>
      )}
      <span>
        <span className="text-muted-foreground">started </span>
        <span className="text-foreground">{formatTime(conversation.startedAt)}</span>
      </span>
      <span>
        <span className="text-muted-foreground">last </span>
        <span className="text-foreground">{formatAge(conversation.lastActivity)}</span>
      </span>
    </div>
  )
}
