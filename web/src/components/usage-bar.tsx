import { Popover } from 'radix-ui'
import { useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-sessions'
import type { ExtraUsage, UsageWindow } from '@/lib/types'
import { haptic } from '@/lib/utils'

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

function usageBorderColor(pct: number): string {
  if (pct < 50) return 'border-emerald-500/30'
  if (pct < 75) return 'border-amber-500/30'
  if (pct < 90) return 'border-orange-500/30'
  return 'border-red-500/30'
}

function formatReset(resetAt: string): string {
  const ms = new Date(resetAt).getTime() - Date.now()
  if (ms <= 0) return 'now'
  const d = Math.floor(ms / 86_400_000)
  const h = Math.floor((ms % 86_400_000) / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

function formatResetAbsolute(resetAt: string): string {
  const dt = new Date(resetAt)
  const day = dt.toLocaleDateString(undefined, { weekday: 'short' })
  const time = dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} ${time}`
}

function DetailBar({ window: w, label }: { window: UsageWindow; label: string }) {
  const pct = Math.min(w.usedPercent, 100)
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground w-10 text-right shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden min-w-20">
        <div
          className={`h-full ${usageColor(pct)} rounded-full transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[11px] tabular-nums font-medium w-8 ${usageTextColor(pct)}`}>{Math.round(pct)}%</span>
      <span className="text-[10px] text-muted-foreground/50 w-12 tabular-nums" title={formatResetAbsolute(w.resetAt)}>
        {formatReset(w.resetAt)}
      </span>
    </div>
  )
}

function getMonthlyResetDate(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + 1, 1)
}

function ExtraUsageRow({ extra }: { extra: ExtraUsage }) {
  if (!extra.isEnabled) return null
  const pct = extra.utilization != null ? Math.min(extra.utilization * 100, 100) : 0
  const used = extra.usedCredits.toFixed(2)
  const limit = extra.monthlyLimit.toFixed(2)
  const resetDate = getMonthlyResetDate()
  const resetIso = resetDate.toISOString()
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground w-10 text-right shrink-0">extra</span>
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden min-w-20">
        <div
          className={`h-full ${usageColor(pct)} rounded-full transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[11px] tabular-nums font-medium ${usageTextColor(pct)}`}>
        ${used}/${limit}
      </span>
      <span className="text-[10px] text-muted-foreground/50 w-12 tabular-nums" title={formatResetAbsolute(resetIso)}>
        {formatReset(resetIso)}
      </span>
    </div>
  )
}

export function UsageBar() {
  const usage = useConversationsStore(s => s.planUsage)
  const [open, setOpen] = useState(false)
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  if (!usage) return null

  const sevenDay = usage.sevenDay
  const pct = Math.min(sevenDay.usedPercent, 100)

  function handleMouseEnter() {
    hoverTimeout.current = setTimeout(() => setOpen(true), 300)
  }
  function handleMouseLeave() {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current)
    hoverTimeout.current = setTimeout(() => setOpen(false), 200)
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 cursor-pointer select-none hover:opacity-80 transition-opacity"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onClick={() => {
            haptic('tap')
            setOpen(o => !o)
          }}
        >
          <span className={`text-[10px] ${usageTextColor(pct)} opacity-70`}>7d</span>
          <div className="w-10 sm:w-14 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full ${usageColor(pct)} rounded-full transition-all duration-500`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className={`text-[10px] tabular-nums ${usageTextColor(pct)}`}>{Math.round(pct)}%</span>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className={`z-50 w-72 rounded border ${usageBorderColor(pct)} bg-background/95 backdrop-blur-sm shadow-lg p-3 font-mono`}
          sideOffset={8}
          align="start"
          onMouseEnter={() => {
            if (hoverTimeout.current) clearTimeout(hoverTimeout.current)
          }}
          onMouseLeave={handleMouseLeave}
          onOpenAutoFocus={e => e.preventDefault()}
        >
          <div className="space-y-2">
            <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-2">Plan Usage</div>

            <DetailBar window={usage.fiveHour} label="5h" />
            <DetailBar window={usage.sevenDay} label="7d" />

            {(usage.sevenDayOpus || usage.sevenDaySonnet) && (
              <>
                <div className="border-t border-border/50 my-2" />
                <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1">Per Model</div>
                {usage.sevenDayOpus && <DetailBar window={usage.sevenDayOpus} label="opus" />}
                {usage.sevenDaySonnet && <DetailBar window={usage.sevenDaySonnet} label="sonnet" />}
              </>
            )}

            {usage.extraUsage?.isEnabled && (
              <>
                <div className="border-t border-border/50 my-2" />
                <ExtraUsageRow extra={usage.extraUsage} />
              </>
            )}

            <div className="border-t border-border/50 mt-2 pt-1">
              <span className="text-[9px] text-muted-foreground/40">
                Polled {new Date(usage.polledAt).toLocaleTimeString()}
              </span>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
