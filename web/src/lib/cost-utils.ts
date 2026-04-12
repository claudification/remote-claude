/**
 * Cost visibility utilities -- pricing, color thresholds, cache analysis.
 * Uses LiteLLM model database when loaded, hardcoded fallback otherwise.
 */

import { getModelInfo } from './model-db'

// Hardcoded fallback pricing (per-million-token)
interface ModelPricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const FALLBACK_PRICING: Record<string, ModelPricing> = {
  opus: { input: 15, output: 75, cacheRead: 1.875, cacheWrite: 18.75 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1.0 },
}

function getPricing(model?: string): ModelPricing {
  // Try LiteLLM DB first
  const info = getModelInfo(model)
  if (info) {
    return {
      input: info.inputCostPerToken * 1_000_000,
      output: info.outputCostPerToken * 1_000_000,
      cacheRead: (info.cacheReadCostPerToken ?? info.inputCostPerToken * 0.125) * 1_000_000,
      cacheWrite: (info.cacheWriteCostPerToken ?? info.inputCostPerToken * 1.25) * 1_000_000,
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
export function estimateCost(
  stats: { totalInputTokens: number; totalOutputTokens: number; totalCacheCreation: number; totalCacheRead: number },
  model?: string,
): number {
  const p = getPricing(model)
  const uncachedInput = stats.totalInputTokens - stats.totalCacheCreation - stats.totalCacheRead
  return (
    (Math.max(0, uncachedInput) * p.input +
      stats.totalOutputTokens * p.output +
      stats.totalCacheRead * p.cacheRead +
      stats.totalCacheCreation * p.cacheWrite) /
    1_000_000
  )
}

/** Get resolved cost -- exact if available, estimated otherwise */
export function getSessionCost(
  stats: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheCreation: number
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

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

/** Estimate re-cache cost if the session has been idle past cache TTL */
export function getCacheWarning(
  lastActivity: number,
  tokenUsage: { input: number; cacheCreation: number; cacheRead: number } | undefined,
  model?: string,
): { idleMs: number; reCacheCost: number; contextTokens: number } | null {
  const idleMs = Date.now() - lastActivity
  if (idleMs < CACHE_TTL_MS) return null
  if (!tokenUsage) return null

  // Context size = sum of all input components from the LAST turn
  // (input + cacheCreation + cacheRead = total tokens sent to the API)
  const contextTokens = tokenUsage.input + tokenUsage.cacheCreation + tokenUsage.cacheRead
  if (contextTokens < 50_000) return null // not worth warning about

  const p = getPricing(model)
  // Re-cache cost = context size * (cacheWrite - cacheRead) per token
  // because a warm cache would pay cacheRead, but cold cache pays cacheWrite
  const reCacheCost = (contextTokens * (p.cacheWrite - p.cacheRead)) / 1_000_000

  if (reCacheCost < 0.1) return null // not worth showing

  return { idleMs, reCacheCost, contextTokens }
}
