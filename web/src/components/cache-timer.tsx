import { useEffect, useState } from 'react'
import { type CacheTimerState, getCacheTimerInfo } from '@/lib/cost-utils'
import { cn } from '@/lib/utils'

interface CacheTimerProps {
  lastTurnEndedAt?: number
  tokenUsage?: { input: number; cacheCreation: number; cacheRead: number }
  model?: string
  cacheTtl?: '5m' | '1h'
  /** Only show when session is idle */
  isIdle: boolean
}

const STATE_STYLES: Record<CacheTimerState, { text: string; label: string; pulse?: boolean }> = {
  hot: { text: 'text-emerald-400', label: 'CACHE' },
  warning: { text: 'text-amber-400', label: 'CACHE' },
  critical: { text: 'text-red-400', label: 'CACHE', pulse: true },
  expired: { text: 'text-red-400', label: 'EXPIRED' },
  unknown: { text: 'text-muted-foreground', label: 'CACHE' },
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00'
  const totalSec = Math.ceil(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

export function CacheTimer({ lastTurnEndedAt, tokenUsage, model, cacheTtl, isIdle }: CacheTimerProps) {
  const [tick, setTick] = useState(0)

  // Tick every second when idle, stop when active
  useEffect(() => {
    if (!isIdle || !lastTurnEndedAt) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [isIdle, lastTurnEndedAt])

  if (!isIdle) return null

  // tick is used to force re-renders so getCacheTimerInfo reads fresh Date.now()
  void tick
  const info = getCacheTimerInfo(lastTurnEndedAt, tokenUsage, model, cacheTtl)
  if (!info) return null

  const style = STATE_STYLES[info.state]

  return (
    <span
      className={cn('inline-flex items-center gap-1 font-mono text-[10px]', style.pulse && 'animate-pulse')}
      title={`Cache TTL: ${cacheTtl || '5m'} | Context: ~${Math.round(info.contextTokens / 1000)}K tokens | Re-cache cost: ~$${info.reCacheCost.toFixed(2)}`}
    >
      <span className="text-muted-foreground">·</span>
      <span className={cn('font-bold uppercase', style.text)}>{style.label}</span>
      {info.state !== 'expired' ? (
        <span className={cn(style.text, 'tabular-nums opacity-70')}>{formatCountdown(info.remainingMs)}</span>
      ) : (
        <span className="text-red-400/70 tabular-nums">~${info.reCacheCost.toFixed(2)}</span>
      )}
    </span>
  )
}

/** Inline banner shown below the conversation header when cache is expired */
export function CacheExpiredBanner({ lastTurnEndedAt, tokenUsage, model, cacheTtl, isIdle }: CacheTimerProps) {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!isIdle || !lastTurnEndedAt) return
    const id = setInterval(() => setTick(t => t + 1), 5000) // slower tick for banner
    return () => clearInterval(id)
  }, [isIdle, lastTurnEndedAt])

  if (!isIdle) return null

  void tick
  const info = getCacheTimerInfo(lastTurnEndedAt, tokenUsage, model, cacheTtl)
  if (!info || info.state !== 'expired') return null

  const idleMs = Date.now() - (lastTurnEndedAt || 0)
  const idleMin = Math.floor(idleMs / 60_000)

  return (
    <div className="mx-3 sm:mx-4 mt-1 px-2 py-1 bg-amber-400/10 border border-amber-400/20 text-[10px] font-mono flex items-center gap-2">
      <span className="text-amber-400 font-bold uppercase">Cache Expired</span>
      <span className="text-amber-400/70">
        {idleMin}m idle -- next prompt re-caches ~{Math.round(info.contextTokens / 1000)}K tokens (~$
        {info.reCacheCost.toFixed(2)})
      </span>
    </div>
  )
}
