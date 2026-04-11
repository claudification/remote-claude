import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'

interface CostTimelineEntry {
  t: number
  cost: number
}

interface CostSparklineProps {
  timeline: CostTimelineEntry[]
  className?: string
}

const WINDOWS = [
  { label: '1h', ms: 60 * 60 * 1000, bucketMs: 5 * 60 * 1000, bucketLabel: '5m' },
  { label: '4h', ms: 4 * 60 * 60 * 1000, bucketMs: 15 * 60 * 1000, bucketLabel: '15m' },
  { label: '8h', ms: 8 * 60 * 60 * 1000, bucketMs: 30 * 60 * 1000, bucketLabel: '30m' },
  { label: '24h', ms: 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000, bucketLabel: '1h' },
] as const

function formatDollar(n: number): string {
  if (n < 0.01) return '$0'
  if (n < 1) return `$${n.toFixed(2)}`
  if (n < 10) return `$${n.toFixed(1)}`
  return `$${Math.round(n)}`
}

export function CostSparkline({ timeline, className }: CostSparklineProps) {
  const [windowIdx, setWindowIdx] = useState(0)
  const win = WINDOWS[windowIdx]

  const { buckets, maxDelta, totalInWindow } = useMemo(() => {
    const now = Date.now()
    const cutoff = now - win.ms
    const filtered = timeline.filter(e => e.t >= cutoff)
    if (filtered.length === 0) return { buckets: [], maxDelta: 0, totalInWindow: 0 }

    // Build buckets
    const bucketCount = Math.ceil(win.ms / win.bucketMs)
    const buckets: Array<{ start: number; delta: number }> = []
    for (let i = 0; i < bucketCount; i++) {
      buckets.push({ start: cutoff + i * win.bucketMs, delta: 0 })
    }

    // Compute deltas between consecutive points
    let prevCost = filtered[0].cost
    const startCost = filtered[0].cost
    for (let i = 1; i < filtered.length; i++) {
      const e = filtered[i]
      const delta = Math.max(0, e.cost - prevCost)
      prevCost = e.cost
      const bucketIdx = Math.min(bucketCount - 1, Math.floor((e.t - cutoff) / win.bucketMs))
      buckets[bucketIdx].delta += delta
    }

    const maxDelta = Math.max(...buckets.map(b => b.delta))
    const totalInWindow = prevCost - startCost

    return { buckets, maxDelta, totalInWindow }
  }, [timeline, win])

  if (timeline.length < 2) return null

  const W = 240
  const H = 40
  const barW = Math.max(2, (W - 4) / buckets.length - 1)

  return (
    <div className={cn('text-[10px] font-mono', className)}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-muted-foreground">cost/time</span>
        <span className="text-muted-foreground">
          {formatDollar(totalInWindow)} in {win.label}
        </span>
        <span className="text-muted-foreground">({win.bucketLabel} buckets)</span>
        <div className="flex gap-0.5 ml-auto">
          {WINDOWS.map((w, i) => (
            <button
              key={w.label}
              type="button"
              onClick={() => setWindowIdx(i)}
              className={cn(
                'px-1 py-0 text-[9px]',
                i === windowIdx ? 'text-accent bg-accent/20' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <svg width={W} height={H} className="block" role="img" aria-label="Cost over time">
        {buckets.map((b, i) => {
          const barH = maxDelta > 0 ? (b.delta / maxDelta) * (H - 4) : 0
          const x = 2 + i * (barW + 1)
          const color =
            b.delta === 0
              ? 'rgba(100,100,100,0.2)'
              : b.delta >= maxDelta * 0.8
                ? '#f87171'
                : b.delta >= maxDelta * 0.4
                  ? '#fbbf24'
                  : '#34d399'
          return (
            <g key={b.start}>
              <title>
                {new Date(b.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}:{' '}
                {formatDollar(b.delta)}
              </title>
              <rect x={x} y={H - 2 - barH} width={barW} height={Math.max(1, barH)} fill={color} rx={0.5} />
            </g>
          )
        })}
      </svg>
    </div>
  )
}
