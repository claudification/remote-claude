import type { ProjectSettings } from '@shared/protocol'
import { CacheTimer } from '@/components/cache-timer'
import { renderProjectIcon } from '@/components/project-settings-editor'
import { formatCost, getConversationCost, getCostColor } from '@/lib/cost-utils'
import type { Session } from '@/lib/types'
import { projectPath } from '@/lib/types'
import { cn, contextWindowSize, formatEffort, formatModel, formatPermissionMode } from '@/lib/utils'

interface HeaderCollapsedBarProps {
  session: Session
  projectSettings: ProjectSettings | undefined
  model: string | undefined
  inPlanMode: boolean
}

export function HeaderCollapsedBar({ session, projectSettings: ps, model, inPlanMode }: HeaderCollapsedBarProps) {
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0">
      <span className="inline-flex items-center gap-1.5 min-w-0">
        {ps?.icon && (
          <span className="shrink-0" style={ps?.color ? { color: ps.color } : undefined}>
            {renderProjectIcon(ps.icon, 'w-3.5 h-3.5')}
          </span>
        )}
        <span className="text-sm font-bold truncate" style={ps?.color ? { color: ps.color } : undefined}>
          {ps?.label || projectPath(session.project).split('/').slice(-2).join('/')}
        </span>
      </span>
      <span className="inline-flex items-center gap-1 shrink-0 flex-wrap">
        <span className="whitespace-nowrap">
          {formatModel(model || session.model)}
          <EffortIndicator effortLevel={session.effortLevel} />
        </span>
        <PermissionBadge permissionMode={session.permissionMode} inPlanMode={inPlanMode} />
        <AdHocBadge session={session} />
        <ContextUsageInline session={session} model={model} />
        <CostInline session={session} model={model} />
        <CacheTimer
          lastTurnEndedAt={session.lastTurnEndedAt}
          tokenUsage={session.tokenUsage}
          model={model || session.model}
          cacheTtl={session.cacheTtl}
          isIdle={session.status === 'idle'}
        />
      </span>
    </span>
  )
}

function EffortIndicator({ effortLevel }: { effortLevel: string | undefined }) {
  if (!effortLevel) return null
  const effort = formatEffort(effortLevel)
  if (!effort) return null
  return (
    <span className="text-muted-foreground ml-1" title={`effort: ${effort.label}`}>
      {effort.symbol}
    </span>
  )
}

function PermissionBadge({ permissionMode, inPlanMode }: { permissionMode: string | undefined; inPlanMode: boolean }) {
  const pm = formatPermissionMode(permissionMode)
  if (!pm && inPlanMode) {
    return <span className="text-[10px] text-blue-400 font-bold px-1 py-0.5 bg-blue-500/10 rounded">PLAN</span>
  }
  if (!pm) return null
  return (
    <span
      className={cn('text-[10px] font-bold px-1 py-0.5 rounded', pm.color, pm.bgColor)}
      title={`Permission mode: ${permissionMode}`}
    >
      {pm.label}
    </span>
  )
}

function AdHocBadge({ session }: { session: Session }) {
  if (!session.capabilities?.includes('ad-hoc')) return null

  function openTask() {
    if (session.adHocTaskId) {
      window.dispatchEvent(new CustomEvent('open-project-task', { detail: { taskId: session.adHocTaskId } }))
    }
  }

  return (
    <span
      role="button"
      tabIndex={0}
      className="text-[10px] text-amber-400 font-bold px-1 py-0.5 bg-amber-500/10 rounded cursor-pointer hover:bg-amber-500/20"
      onClick={openTask}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') openTask()
      }}
      title={session.adHocTaskId ? `Task: ${session.adHocTaskId}` : 'Ad-hoc conversation'}
    >
      &#x26A1; AD-HOC{session.adHocTaskId ? ` (${session.adHocTaskId})` : ''}
    </span>
  )
}

function ContextUsageInline({ session, model }: { session: Session; model: string | undefined }) {
  if (!session.tokenUsage) return null
  const { input, cacheCreation, cacheRead } = session.tokenUsage
  const total = input + cacheCreation + cacheRead
  const maxTokens = session.contextWindow ?? contextWindowSize(model || session.model)
  const pct = Math.min(100, Math.round((total / maxTokens) * 100))
  const totalK = Math.round(total / 1000)
  const threshold = session.autocompactPct || 83
  const warnAt = threshold - 5
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-muted-foreground">·</span>
      <span className="inline-block w-12 h-1.5 bg-muted rounded-full overflow-hidden">
        <span
          className={cn(
            'block h-full rounded-full',
            pct < warnAt ? 'bg-emerald-400' : pct < threshold ? 'bg-amber-400' : 'bg-red-400',
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span
        className={cn(
          'text-[10px] font-mono whitespace-nowrap',
          pct < warnAt ? 'text-emerald-400/70' : pct < threshold ? 'text-amber-400/70' : 'text-red-400/70',
        )}
      >
        {totalK.toLocaleString()}K ({pct}%)
      </span>
    </span>
  )
}

function CostInline({ session, model }: { session: Session; model: string | undefined }) {
  if (!session.stats) return null
  const { cost, exact } = getConversationCost(session.stats, model || session.model)
  if (cost < 0.01) return null
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-muted-foreground">·</span>
      <span className={cn('text-[10px] font-mono whitespace-nowrap', getCostColor(cost))}>
        {formatCost(cost, exact)}
      </span>
    </span>
  )
}
