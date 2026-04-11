/**
 * LiteLLM model pricing database -- fetched from GitHub, cached to disk, refreshed every 24h.
 * Only stores Claude models (claude-* prefix) to keep the payload small.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const CACHE_FILENAME = 'litellm-pricing.json'
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours

export interface ModelInfo {
  maxInputTokens: number
  maxOutputTokens: number
  inputCostPerToken: number
  outputCostPerToken: number
  cacheReadCostPerToken?: number
  cacheWriteCostPerToken?: number
}

// Module state
let models: Record<string, ModelInfo> = {}
let cachePath: string | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null
let lastFetchedAt = 0

function parseModels(raw: Record<string, Record<string, unknown>>): Record<string, ModelInfo> {
  const result: Record<string, ModelInfo> = {}
  for (const [name, data] of Object.entries(raw)) {
    // Only keep claude-* models (direct Anthropic API names)
    if (!name.startsWith('claude-')) continue
    const maxIn = data.max_input_tokens as number | undefined
    const maxOut = data.max_output_tokens as number | undefined
    const inCost = data.input_cost_per_token as number | undefined
    const outCost = data.output_cost_per_token as number | undefined
    if (!maxIn || !maxOut || inCost == null || outCost == null) continue
    result[name] = {
      maxInputTokens: maxIn,
      maxOutputTokens: maxOut,
      inputCostPerToken: inCost,
      outputCostPerToken: outCost,
      cacheReadCostPerToken: (data.cache_read_input_token_cost as number) ?? undefined,
      cacheWriteCostPerToken: (data.cache_creation_input_token_cost as number) ?? undefined,
    }
  }
  return result
}

async function fetchAndCache(): Promise<boolean> {
  try {
    const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) {
      console.error(`[models] LiteLLM fetch failed: ${res.status} ${res.statusText}`)
      return false
    }
    const raw = (await res.json()) as Record<string, Record<string, unknown>>
    models = parseModels(raw)
    lastFetchedAt = Date.now()
    console.log(`[models] Loaded ${Object.keys(models).length} Claude models from LiteLLM`)

    // Write cache
    if (cachePath) {
      try {
        writeFileSync(cachePath, JSON.stringify({ fetchedAt: lastFetchedAt, models }, null, 2))
      } catch (err) {
        console.error(`[models] Cache write failed: ${err}`)
      }
    }
    return true
  } catch (err) {
    console.error(`[models] LiteLLM fetch error: ${err instanceof Error ? err.message : err}`)
    return false
  }
}

function loadCache(): boolean {
  if (!cachePath || !existsSync(cachePath)) return false
  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf8'))
    if (data.models && data.fetchedAt) {
      models = data.models
      lastFetchedAt = data.fetchedAt
      const ageH = Math.round((Date.now() - lastFetchedAt) / 3_600_000)
      console.log(`[models] Loaded ${Object.keys(models).length} models from cache (${ageH}h old)`)
      return true
    }
  } catch {}
  return false
}

export function initModelPricing(cacheDir: string) {
  cachePath = resolve(cacheDir, CACHE_FILENAME)

  // Try disk cache first
  const cacheValid = loadCache() && Date.now() - lastFetchedAt < REFRESH_INTERVAL_MS
  if (!cacheValid) {
    // Fetch in background -- don't block startup
    fetchAndCache()
  }

  // Schedule refresh
  refreshTimer = setInterval(fetchAndCache, REFRESH_INTERVAL_MS)
}

export function getModels(): Record<string, ModelInfo> {
  return models
}

export function getModelInfo(modelName: string): ModelInfo | undefined {
  // Try exact match first
  if (models[modelName]) return models[modelName]

  // Try without date suffix (e.g. claude-opus-4-6-20260205 -> claude-opus-4-6)
  const stripped = modelName.replace(/-\d{8}$/, '')
  if (models[stripped]) return models[stripped]

  // Try matching by family (opus, sonnet, haiku) + version
  const lower = modelName.toLowerCase()
  for (const [name, info] of Object.entries(models)) {
    if (lower.includes(name) || name.includes(lower)) return info
  }

  return undefined
}

export function getModelsFetchedAt(): number {
  return lastFetchedAt
}

export function stopModelPricing() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}
