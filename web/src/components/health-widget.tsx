import { Popover } from 'radix-ui'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import { haptic } from '@/lib/utils'

function statusDotColor(isUp: boolean, uptime: number, status: string): string {
  if (!isUp || status === 'investigating') return 'text-red-500 animate-pulse'
  if (status === 'identified' || status === 'monitoring') return 'text-amber-500'
  if (uptime < 95) return 'text-amber-500'
  return 'text-emerald-500'
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    operational: 'operational',
    investigating: 'investigating',
    identified: 'identified',
    monitoring: 'monitoring',
    resolved: 'resolved',
  }
  return labels[status] || 'unknown'
}

function riskColor(risk: number): string {
  if (risk < 10) return 'bg-emerald-500'
  if (risk < 20) return 'bg-amber-500'
  if (risk < 30) return 'bg-orange-500'
  return 'bg-red-500'
}

function riskTextColor(risk: number): string {
  if (risk < 10) return 'text-emerald-400'
  if (risk < 20) return 'text-amber-400'
  if (risk < 30) return 'text-orange-400'
  return 'text-red-400'
}

function trendArrow(trend: string): string {
  if (trend === 'worsening') return '↗'
  if (trend === 'improving') return '↘'
  return '→'
}

export function HealthWidget() {
  const health = useConversationsStore(s => s.claudeHealth)
  const { open, setOpen, handleMouseEnter, handleMouseLeave, cancelClose, toggle } = useHoverPopover()

  if (!health) return null

  const dotColor = statusDotColor(health.isUp, health.uptime24h, health.status)

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="hidden sm:flex items-center gap-1 cursor-pointer select-none hover:opacity-80 transition-opacity"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={() => {
            haptic('tap')
            toggle()
          }}
        >
          <span className={`text-[10px] ${dotColor}`}>{'●'}</span>
          <span className="text-[10px] text-muted-foreground/70">api</span>
          <span className={`text-[10px] tabular-nums ${health.isUp ? 'text-emerald-400' : 'text-red-400'}`}>
            {health.isUp ? `${Math.round(health.uptime24h)}%` : 'down'}
          </span>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="z-50 w-72 rounded border border-border bg-background/95 backdrop-blur-sm shadow-lg p-3 font-mono"
          sideOffset={8}
          align="start"
          onMouseEnter={cancelClose}
          onMouseLeave={handleMouseLeave}
          onOpenAutoFocus={e => e.preventDefault()}
        >
          <div className="space-y-2">
            <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-2">Claude API</div>

            <div className="flex items-center gap-2">
              <span className={`text-xs ${dotColor}`}>{'●'}</span>
              <span className="text-[11px] text-muted-foreground">{statusLabel(health.status)}</span>
              <span className={`text-[10px] ml-auto ${health.isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                {health.isUp ? 'up' : 'down'}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-10 text-right shrink-0">24h</span>
              <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden min-w-20">
                <div
                  className={`h-full ${health.uptime24h >= 95 ? 'bg-emerald-500' : health.uptime24h >= 80 ? 'bg-amber-500' : 'bg-red-500'} rounded-full transition-all duration-500`}
                  style={{ width: `${Math.min(health.uptime24h, 100)}%` }}
                />
              </div>
              <span
                className={`text-[11px] tabular-nums font-medium w-8 ${health.uptime24h >= 95 ? 'text-emerald-400' : health.uptime24h >= 80 ? 'text-amber-400' : 'text-red-400'}`}
              >
                {Math.round(health.uptime24h)}%
              </span>
            </div>

            <div className="border-t border-border/50 my-2" />
            <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1">Risk Forecast</div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-10 text-right shrink-0">now</span>
              <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden min-w-20">
                <div
                  className={`h-full ${riskColor(health.riskScore)} rounded-full transition-all duration-500`}
                  style={{ width: `${Math.min(health.riskScore, 100)}%` }}
                />
              </div>
              <span className={`text-[11px] tabular-nums font-medium w-8 ${riskTextColor(health.riskScore)}`}>
                {health.riskScore}%
              </span>
              <span className="text-[10px] text-muted-foreground/50">{trendArrow(health.riskTrend)}</span>
            </div>

            <div className="flex items-center gap-3 text-[10px] text-muted-foreground/70">
              <span>{health.incidents7d} incidents / 7d</span>
            </div>

            {health.lastIncidentTitle && (
              <div className="text-[10px] text-muted-foreground/50 truncate" title={health.lastIncidentTitle}>
                {health.lastIncidentTitle}
              </div>
            )}

            <div className="border-t border-border/50 mt-2 pt-1 flex items-center justify-between gap-2">
              <span className="text-[9px] text-muted-foreground/40">
                Polled {new Date(health.polledAt).toLocaleTimeString()}
              </span>
              <a
                href="https://clanker.watch"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[9px] text-muted-foreground/40 hover:text-muted-foreground/80 hover:underline"
                title="Data source -- click for details"
              >
                clanker.watch ↗
              </a>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
