/**
 * Model pricing database -- fetched from concentrator (LiteLLM data).
 * Used for cost estimation. Context window sizing is NOT from this DB:
 * LiteLLM's max_input_tokens reports the beta-opt-in maximum, not Claude
 * Code's actual default. For context window, use session.contextWindow
 * (set by the concentrator based on transcript signals).
 */

import { appendShareParam } from './share-mode'

export interface ModelInfo {
  maxInputTokens: number
  maxOutputTokens: number
  inputCostPerToken: number
  outputCostPerToken: number
  cacheReadCostPerToken?: number
  cacheWriteCostPerToken?: number
}

let models: Record<string, ModelInfo> = {}
let loaded = false

export async function fetchModelDb(): Promise<void> {
  try {
    const res = await fetch(appendShareParam('/api/models'))
    if (!res.ok) return
    const data = await res.json()
    if (data.models) {
      models = data.models
      loaded = true
    }
  } catch {
    // Silent fail -- fallback to hardcoded values
  }
}

export function isModelDbLoaded(): boolean {
  return loaded
}

/** Resolve model name to ModelInfo with fuzzy matching */
export function getModelInfo(modelName: string | undefined): ModelInfo | undefined {
  if (!modelName) return undefined

  // Exact match
  if (models[modelName]) return models[modelName]

  // Strip date suffix (e.g. claude-opus-4-6-20260205 -> claude-opus-4-6)
  const stripped = modelName.replace(/-\d{8}$/, '')
  if (models[stripped]) return models[stripped]

  // Fuzzy: find longest matching model name
  const lower = modelName.toLowerCase()
  let best: ModelInfo | undefined
  let bestLen = 0
  for (const [name, info] of Object.entries(models)) {
    if (lower.includes(name) && name.length > bestLen) {
      best = info
      bestLen = name.length
    }
  }
  return best
}

/** Context window for display. Claude Code defaults to 200K; 1M is opt-in
 * (via /model menu or explicit `[1m]`/`-1m` model variant). The authoritative
 * value comes from the backend as `session.contextWindow` -- this function is
 * just a fallback when that field is absent.
 */
export function contextWindowFromDb(model: string | undefined): number {
  if (model && /(-1m|\[1m\])/i.test(model)) return 1_000_000
  return 200_000
}
