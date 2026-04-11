import { useSessionsStore } from '@/hooks/use-sessions'
import type { UsageWindow } from '@/lib/types'

function usageColor(pct: number): string {
  if (pct < 50) return 'bg-emerald-500'
  if (pct < 75) return 'bg-amber-500'
  if (pct < 90) return 'bg-orange-500'
  return 'bg-red-500'
}

function usageTextColor(pct: number): string {
  if (pct < 50) return 'text-emerald-400'
  if (pct < 75) return 'text-amber-400'
  if (pct < 90) return 'text-orange-400'
  return 'text-red-400'
}

function formatReset(resetAt: string): string {
  const ms = new Date(resetAt).getTime() - Date.now()
  if (ms <= 0) return 'now'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h > 0) return `${h}h${m > 0 ? `${m}m` : ''}`
  return `${m}m`
}

function MiniBar({ window: w, label, className }: { window: UsageWindow; label: string; className?: string }) {
  const pct = Math.min(w.usedPercent, 100)
  return (
    <div
      className={`flex items-center gap-1 ${className || ''}`}
      title={`${label}: ${pct}% used, resets in ${formatReset(w.resetAt)}`}
    >
      <span className={`text-[10px] ${usageTextColor(pct)} opacity-70`}>{label}</span>
      <div className="w-10 sm:w-14 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full ${usageColor(pct)} rounded-full transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[10px] tabular-nums ${usageTextColor(pct)}`}>{Math.round(pct)}%</span>
    </div>
  )
}

export function UsageBar() {
  const usage = useSessionsStore(s => s.planUsage)
  if (!usage) return null

  return (
    <div className="flex items-center gap-2 sm:gap-3">
      <MiniBar window={usage.fiveHour} label="5h" />
      <MiniBar window={usage.sevenDay} label="7d" />
      {usage.sevenDayOpus && <MiniBar window={usage.sevenDayOpus} label="opus" className="hidden sm:flex" />}
      {usage.sevenDaySonnet && <MiniBar window={usage.sevenDaySonnet} label="sonnet" className="hidden sm:flex" />}
    </div>
  )
}
