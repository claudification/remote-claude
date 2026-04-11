/**
 * Model pricing database -- fetched from concentrator (LiteLLM data).
 * Used for context window sizing and cost estimation.
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

/** Context window size from model DB, with hardcoded fallback */
export function contextWindowFromDb(model: string | undefined): number {
  const info = getModelInfo(model)
  if (info) return info.maxInputTokens
  // Hardcoded fallback when DB not loaded
  if (!model) return 200_000
  const m = model.toLowerCase()
  if (m.includes('opus-4-6') || m.includes('opus-4.6') || m.includes('sonnet-4-6')) return 1_000_000
  return 200_000
}
