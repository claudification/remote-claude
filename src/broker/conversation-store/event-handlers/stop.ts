import type { Conversation, HookEventOf } from '../../../shared/protocol'
import { getModelInfo } from '../../model-pricing'
import type { ConversationStoreContext } from '../event-context'

/**
 * Handle Stop / StopFailure hook events: status -> idle, capture
 * StopFailure error details, record an estimated turn cost for PTY
 * sessions (headless uses exact turn_cost from stream backend).
 */
export function handleStop(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  event: HookEventOf<'Stop' | 'StopFailure'>,
): void {
  conv.status = 'idle'
  conv.lastTurnEndedAt = event.timestamp

  if (event.hookEvent === 'StopFailure') {
    const d = event.data
    conv.lastError = {
      stopReason: String(d.stop_reason ?? d.stopReason ?? ''),
      errorType: String(d.error_type ?? d.errorType ?? ''),
      errorMessage: String(d.error_message ?? d.errorMessage ?? d.error ?? ''),
      timestamp: event.timestamp,
    }
    return
  }

  // Stop: estimate cumulative cost for PTY conversations
  if (conv.capabilities?.includes('headless')) return
  const s = conv.stats
  if (s.totalInputTokens === 0 && s.totalOutputTokens === 0) return

  const info = conv.model ? getModelInfo(conv.model) : undefined
  let totalEstCost: number
  if (info) {
    const uncached = Math.max(0, s.totalInputTokens - s.totalCacheCreation - s.totalCacheRead)
    const cacheReadCost = info.cacheReadCostPerToken ?? info.inputCostPerToken * 0.125
    const cacheWrite5mCost = info.cacheWriteCostPerToken ?? info.inputCostPerToken * 1.25
    const cacheWrite1hCost = info.inputCostPerToken * 2.0
    totalEstCost =
      uncached * info.inputCostPerToken +
      s.totalOutputTokens * info.outputCostPerToken +
      s.totalCacheRead * cacheReadCost +
      s.totalCacheWrite5m * cacheWrite5mCost +
      s.totalCacheWrite1h * cacheWrite1hCost
  } else {
    const uncached = Math.max(0, s.totalInputTokens - s.totalCacheCreation - s.totalCacheRead)
    totalEstCost =
      (uncached * 15 +
        s.totalOutputTokens * 75 +
        s.totalCacheRead * 1.875 +
        s.totalCacheWrite5m * 18.75 +
        s.totalCacheWrite1h * 30) /
      1_000_000
  }

  ctx.store?.costs.recordTurnFromCumulatives({
    timestamp: event.timestamp,
    conversationId,
    projectUri: conv.project,
    account: conv.claudeAuth?.email || '',
    orgId: conv.claudeAuth?.orgId || '',
    model: conv.model || '',
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    totalCacheRead: s.totalCacheRead,
    totalCacheWrite: s.totalCacheCreation,
    totalCostUsd: totalEstCost,
    exactCost: false,
  })
}
