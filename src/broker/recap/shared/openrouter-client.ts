/**
 * Single OpenRouter HTTP client used by:
 *  - recap/away-summary (per-conversation 20-word recap)
 *  - recap/period      (long-form markdown digest)
 *  - voice-stream      (Deepgram refinement pass)
 *
 * Handles bearer auth, AbortSignal-based timeout, exponential backoff on
 * 5xx, Retry-After honouring on 429, and normalised usage extraction.
 */

import { NoApiKeyError, OpenRouterError, RateLimitError, TimeoutError } from './errors'
import { type NormalizedUsage, normalizeUsage } from './pricing'

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 3

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  model: string
  system?: string
  user?: string
  messages?: ChatMessage[]
  maxTokens?: number
  temperature?: number
  responseFormat?: { type: 'json_object' } | { type: 'text' }
  timeoutMs?: number
  retries?: number
  /** Override fetch (test seam). Defaults to globalThis.fetch. */
  fetcher?: typeof fetch
  /** Override env lookup (test seam). Defaults to process.env. */
  apiKey?: string
}

export interface ChatResponse {
  content: string
  raw: unknown
  usage: NormalizedUsage
  model: string
}

export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const apiKey = resolveApiKey(req)
  const ctx: AttemptContext = {
    body: buildBody(req),
    fetcher: req.fetcher ?? globalThis.fetch,
    timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    apiKey,
    model: req.model,
    maxAttempts: (req.retries ?? DEFAULT_RETRIES) + 1,
  }
  return runWithRetry(ctx)
}

interface AttemptContext {
  body: Record<string, unknown>
  fetcher: typeof fetch
  timeoutMs: number
  apiKey: string
  model: string
  maxAttempts: number
}

// fallow-ignore-next-line complexity
async function runWithRetry(ctx: AttemptContext): Promise<ChatResponse> {
  for (let attempt = 1; attempt <= ctx.maxAttempts; attempt++) {
    try {
      const res = await fetchOnce(ctx.fetcher, ctx.apiKey, ctx.body, ctx.timeoutMs)
      return parseResponse(ctx.model, res)
    } catch (err) {
      if (attempt === ctx.maxAttempts || !shouldRetry(err)) throw err
      await sleep(backoffMs(attempt, err))
    }
  }
  throw new OpenRouterError('unreachable')
}

function resolveApiKey(req: ChatRequest): string {
  const apiKey = req.apiKey ?? process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new NoApiKeyError()
  return apiKey
}

// fallow-ignore-next-line complexity
function buildBody(req: ChatRequest): Record<string, unknown> {
  const messages = assembleMessages(req)
  if (messages.length === 0) throw new OpenRouterError('chat requires at least one message')
  return {
    model: req.model,
    messages,
    ...(req.maxTokens != null && { max_tokens: req.maxTokens }),
    ...(req.temperature != null && { temperature: req.temperature }),
    ...(req.responseFormat && { response_format: req.responseFormat }),
  }
}

function assembleMessages(req: ChatRequest): ChatMessage[] {
  const messages: ChatMessage[] = req.messages ? [...req.messages] : []
  if (req.system) messages.unshift({ role: 'system', content: req.system })
  if (req.user) messages.push({ role: 'user', content: req.user })
  return messages
}

async function fetchOnce(
  fetcher: typeof fetch,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetcher(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) throw errorForStatus(res)
    return res
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new TimeoutError()
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function errorForStatus(res: Response): Error {
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after')
    const retryMs = retryAfter ? Math.max(0, Number(retryAfter)) * 1000 : undefined
    return new RateLimitError(Number.isFinite(retryMs) ? retryMs : undefined)
  }
  return new OpenRouterError(`OpenRouter returned ${res.status} ${res.statusText}`, res.status)
}

async function parseResponse(model: string, res: Response): Promise<ChatResponse> {
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: Parameters<typeof normalizeUsage>[1]
    model?: string
  }
  const content = data.choices?.[0]?.message?.content?.trim() ?? ''
  if (!content) throw new OpenRouterError('OpenRouter returned an empty completion')
  return {
    content,
    raw: data,
    usage: normalizeUsage(model, data.usage),
    model: data.model ?? model,
  }
}

// fallow-ignore-next-line complexity
function shouldRetry(err: unknown): boolean {
  if (err instanceof RateLimitError) return true
  if (err instanceof TimeoutError) return true
  if (err instanceof OpenRouterError) {
    return err.status != null && err.status >= 500
  }
  return false
}

function backoffMs(attempt: number, err: unknown): number {
  if (err instanceof RateLimitError && err.retryAfterMs != null) return err.retryAfterMs
  return Math.min(8000, 250 * 2 ** (attempt - 1))
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
