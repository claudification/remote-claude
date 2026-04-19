/**
 * Cost visibility utilities -- pricing, color thresholds, cache analysis.
 * Uses LiteLLM model database when loaded, hardcoded fallback otherwise.
 */

import { getModelInfo } from './model-db'

// Hardcoded fallback pricing (per-million-token)
// cacheWrite5m = 1.25x input, cacheWrite1h = 2.0x input
interface ModelPricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

const FALLBACK_PRICING: Record<string, ModelPricing> = {
  opus: { input: 15, output: 75, cacheRead: 1.875, cacheWrite5m: 18.75, cacheWrite1h: 30 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite5m: 1.0, cacheWrite1h: 1.6 },
}

function getPricing(model?: string): ModelPricing {
  // Try LiteLLM DB first
  const info = getModelInfo(model)
  if (info) {
    const inputPPM = info.inputCostPerToken * 1_000_000
    return {
      input: inputPPM,
      output: info.outputCostPerToken * 1_000_000,
      cacheRead: (info.cacheReadCostPerToken ?? info.inputCostPerToken * 0.125) * 1_000_000,
      cacheWrite5m: (info.cacheWriteCostPerToken ?? info.inputCostPerToken * 1.25) * 1_000_000,
      cacheWrite1h: inputPPM * 2.0,
    }
  }
  // Hardcoded fallback
  if (!model) return FALLBACK_PRICING.opus
  const m = model.toLowerCase()
  if (m.includes('haiku')) return FALLBACK_PRICING.haiku
  if (m.includes('sonnet')) return FALLBACK_PRICING.sonnet
  return FALLBACK_PRICING.opus
}

/** Estimate cost from token counts when exact cost isn't available */
function estimateCost(
  stats: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheCreation: number
    totalCacheWrite5m?: number
    totalCacheWrite1h?: number
    totalCacheRead: number
  },
  model?: string,
): number {
  const p = getPricing(model)
  const uncachedInput = stats.totalInputTokens - stats.totalCacheCreation - stats.totalCacheRead
  // Use split cache write pricing when available, fall back to 5m rate for all
  const cw5m = stats.totalCacheWrite5m ?? stats.totalCacheCreation
  const cw1h = stats.totalCacheWrite1h ?? 0
  return (
    (Math.max(0, uncachedInput) * p.input +
      stats.totalOutputTokens * p.output +
      stats.totalCacheRead * p.cacheRead +
      cw5m * p.cacheWrite5m +
      cw1h * p.cacheWrite1h) /
    1_000_000
  )
}

/** Get resolved cost -- exact if available, estimated otherwise */
export function getSessionCost(
  stats: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheCreation: number
    totalCacheWrite5m?: number
    totalCacheWrite1h?: number
    totalCacheRead: number
    totalCostUsd?: number
  },
  model?: string,
): { cost: number; exact: boolean } {
  if (stats.totalCostUsd != null && stats.totalCostUsd > 0) {
    return { cost: stats.totalCostUsd, exact: true }
  }
  return { cost: estimateCost(stats, model), exact: false }
}

// Cost color thresholds
type CostLevel = 'low' | 'moderate' | 'high' | 'critical'

export function getCostLevel(cost: number): CostLevel {
  if (cost < 0.5) return 'low'
  if (cost < 2) return 'moderate'
  if (cost < 5) return 'high'
  return 'critical'
}

export function getCostColor(cost: number): string {
  switch (getCostLevel(cost)) {
    case 'low':
      return 'text-emerald-400'
    case 'moderate':
      return 'text-yellow-400'
    case 'high':
      return 'text-orange-400'
    case 'critical':
      return 'text-red-400'
  }
}

export function getCostBgColor(cost: number): string {
  switch (getCostLevel(cost)) {
    case 'low':
      return 'bg-emerald-400/15 text-emerald-400 border-emerald-400/30'
    case 'moderate':
      return 'bg-yellow-400/15 text-yellow-400 border-yellow-400/30'
    case 'high':
      return 'bg-orange-400/15 text-orange-400 border-orange-400/30'
    case 'critical':
      return 'bg-red-400/15 text-red-400 border-red-400/30'
  }
}

/** Format cost for display */
export function formatCost(cost: number, exact: boolean): string {
  const prefix = exact ? '$' : '~$'
  if (cost < 0.01) return `${prefix}0.01`
  if (cost < 10) return `${prefix}${cost.toFixed(2)}`
  return `${prefix}${cost.toFixed(1)}`
}

/** Calculate burn rate in $/hr */
export function getBurnRate(cost: number, startedAt: number, lastActivity: number): number | null {
  const durationMs = lastActivity - startedAt
  if (durationMs < 60_000 || cost < 0.01) return null // need at least 1 min and some cost
  const hours = durationMs / 3_600_000
  return cost / hours
}

/** Cache efficiency ratio (reads / writes). Higher = better cache utilization */
export function getCacheEfficiency(
  cacheRead: number,
  cacheCreation: number,
): { ratio: number; label: string; color: string } | null {
  if (cacheCreation < 1000) return null // not enough data
  const ratio = cacheRead / cacheCreation
  if (ratio >= 5) return { ratio, label: 'excellent', color: 'text-emerald-400' }
  if (ratio >= 2) return { ratio, label: 'good', color: 'text-cyan-400' }
  if (ratio >= 1) return { ratio, label: 'fair', color: 'text-yellow-400' }
  return { ratio, label: 'poor', color: 'text-orange-400' }
}

const CACHE_TTL_5M = 5 * 60 * 1000
const CACHE_TTL_1H = 60 * 60 * 1000

function resolveCacheTtlMs(cacheTtl?: '5m' | '1h'): number {
  return cacheTtl === '1h' ? CACHE_TTL_1H : CACHE_TTL_5M
}

export type CacheTimerState = 'hot' | 'warning' | 'critical' | 'expired' | 'unknown'

/** Live cache timer state for countdown display */
export function getCacheTimerInfo(
  lastTurnEndedAt: number | undefined,
  tokenUsage: { input: number; cacheCreation: number; cacheRead: number } | undefined,
  model?: string,
  cacheTtl?: '5m' | '1h',
): {
  state: CacheTimerState
  remainingMs: number
  ttlMs: number
  reCacheCost: number
  contextTokens: number
} | null {
  if (!lastTurnEndedAt || !tokenUsage) return null

  const contextTokens = tokenUsage.input + tokenUsage.cacheCreation + tokenUsage.cacheRead
  if (contextTokens < 40_000) return null // not worth showing timer for tiny contexts

  const ttlMs = resolveCacheTtlMs(cacheTtl)
  const elapsed = Date.now() - lastTurnEndedAt
  const remainingMs = ttlMs - elapsed

  const p = getPricing(model)
  const reCacheCost = (contextTokens * (p.cacheWrite5m - p.cacheRead)) / 1_000_000

  if (reCacheCost < 0.75) return null // not worth warning for cheap re-caches

  let state: CacheTimerState
  if (remainingMs <= 0) {
    state = 'expired'
  } else if (remainingMs <= 30_000) {
    state = 'critical'
  } else if (remainingMs <= 60_000) {
    state = 'warning'
  } else {
    state = 'hot'
  }

  return { state, remainingMs: Math.max(0, remainingMs), ttlMs, reCacheCost, contextTokens }
}
