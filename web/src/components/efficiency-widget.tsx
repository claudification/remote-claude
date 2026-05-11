import { Popover } from 'radix-ui'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import { haptic } from '@/lib/utils'

function effColor(eff: number): string {
  if (eff >= 85) return 'bg-emerald-500'
  if (eff >= 60) return 'bg-amber-500'
  if (eff >= 40) return 'bg-orange-500'
  return 'bg-red-500'
}

function effTextColor(eff: number): string {
  if (eff >= 85) return 'text-emerald-400'
  if (eff >= 60) return 'text-amber-400'
  if (eff >= 40) return 'text-orange-400'
  return 'text-red-400'
}

function effBorderColor(eff: number): string {
  if (eff >= 85) return 'border-emerald-500/30'
  if (eff >= 60) return 'border-amber-500/30'
  if (eff >= 40) return 'border-orange-500/30'
  return 'border-red-500/30'
}

function levelBadgeColor(level: string): string {
  if (level === 'great' || level === 'good') return 'text-emerald-400 bg-emerald-500/10'
  if (level === 'fair' || level === 'tight') return 'text-amber-400 bg-amber-500/10'
  if (level === 'harsh') return 'text-orange-400 bg-orange-500/10'
  if (level === 'brutal') return 'text-red-400 bg-red-500/10'
  return 'text-muted-foreground bg-muted'
}

function formatHour(utcHour: number): string {
  const d = new Date()
  d.setUTCHours(utcHour, 0, 0, 0)
  return d.toLocaleTimeString([], { hour: 'numeric', hour12: true })
}

export function EfficiencyWidget() {
  const eff = useConversationsStore(s => s.claudeEfficiency)
  const { open, setOpen, handleMouseEnter, handleMouseLeave, cancelClose, toggle } = useHoverPopover()

  if (!eff) return null

  const pct = eff.efficiency
  const barPct = Math.min(pct, 100)
  const nowUtcHour = new Date().getUTCHours()

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
          <span className={`text-[10px] ${effTextColor(pct)} opacity-70`}>eff</span>
          <div className="w-10 sm:w-14 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full ${effColor(pct)} rounded-full transition-all duration-500`}
              style={{ width: `${barPct}%` }}
            />
          </div>
          <span className={`text-[10px] tabular-nums ${effTextColor(pct)}`}>{Math.round(pct)}%</span>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className={`z-50 w-72 rounded border ${effBorderColor(pct)} bg-background/95 backdrop-blur-sm shadow-lg p-3 font-mono`}
          sideOffset={8}
          align="start"
          onMouseEnter={cancelClose}
          onMouseLeave={handleMouseLeave}
          onOpenAutoFocus={e => e.preventDefault()}
        >
          <div className="space-y-2">
            <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-2">Burn Rate</div>

            <div className="flex items-center gap-2">
              <span className={`text-[11px] font-medium ${effTextColor(pct)}`}>{Math.round(pct)}% efficiency</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${levelBadgeColor(eff.level)}`}>{eff.level}</span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-10 text-right shrink-0">drain</span>
              <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden min-w-20">
                <div
                  className={`h-full ${effColor(pct)} rounded-full transition-all duration-500`}
                  style={{ width: `${barPct}%` }}
                />
              </div>
              <span className={`text-[11px] tabular-nums font-medium w-8 ${effTextColor(pct)}`}>
                {eff.currentDrainPp}pp
              </span>
            </div>

            <div className="text-[10px] text-muted-foreground/50">
              baseline {eff.baselineDrainPp}pp -- current {eff.currentDrainPp}pp per request
            </div>

            {eff.forecast.length > 0 && (
              <>
                <div className="border-t border-border/50 my-2" />
                <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1">
                  Forecast (UTC blocks)
                </div>

                <div className="flex gap-0.5">
                  {eff.forecast.map(block => {
                    const isCurrent = nowUtcHour >= block.hourUtc && nowUtcHour < block.hourUtc + 3
                    return (
                      <div
                        key={block.hourUtc}
                        className={`flex-1 flex flex-col items-center gap-0.5 py-1 rounded ${isCurrent ? 'ring-1 ring-foreground/30' : ''}`}
                        title={`${block.hourUtc}:00 UTC -- ${block.efficiency}% (${block.level})`}
                      >
                        <span className="text-[8px] text-muted-foreground/40">{formatHour(block.hourUtc)}</span>
                        <div className="w-full h-3 bg-muted rounded-sm overflow-hidden">
                          <div
                            className={`h-full ${effColor(block.efficiency)} rounded-sm transition-all duration-500`}
                            style={{ width: `${Math.min(block.efficiency, 100)}%` }}
                          />
                        </div>
                        <span className={`text-[8px] tabular-nums ${effTextColor(block.efficiency)}`}>
                          {block.efficiency}%
                        </span>
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            <div className="border-t border-border/50 mt-2 pt-1 flex items-center justify-between gap-2">
              <span className="text-[9px] text-muted-foreground/40">
                Polled {new Date(eff.polledAt).toLocaleTimeString()}
              </span>
              <a
                href="https://usage.report"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[9px] text-muted-foreground/40 hover:text-muted-foreground/80 hover:underline"
                title="Data source -- click for details"
              >
                usage.report ↗
              </a>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
