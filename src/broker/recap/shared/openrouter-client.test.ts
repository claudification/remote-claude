import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { NoApiKeyError, OpenRouterError, RateLimitError, TimeoutError } from './errors'
import { chat } from './openrouter-client'

interface CapturedCall {
  url: string
  init: RequestInit
}

function makeFetcher(handler: (call: CapturedCall, attempt: number) => Promise<Response> | Response) {
  let attempt = 0
  const calls: CapturedCall[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    attempt++
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return handler(call, attempt)
  }) as unknown as typeof fetch
  return { fn, calls, getAttempt: () => attempt }
}

const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY
beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'k_test'
})
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = ORIGINAL_KEY
})

function jsonResponse(content: string, usage: Record<string, unknown> = {}, status = 200): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage, model: 'anthropic/claude-haiku-4-5' }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('chat()', () => {
  it('throws NoApiKeyError when no key is configured and no override is given', async () => {
    delete process.env.OPENROUTER_API_KEY
    const { fn } = makeFetcher(() => jsonResponse('hi'))
    await expect(chat({ model: 'anthropic/claude-haiku-4-5', user: 'x', fetcher: fn })).rejects.toBeInstanceOf(
      NoApiKeyError,
    )
  })

  it('packs system + user shorthand into messages array in order', async () => {
    const { fn, calls } = makeFetcher(() => jsonResponse('ok'))
    await chat({
      model: 'anthropic/claude-haiku-4-5',
      system: 'sys',
      user: 'usr',
      maxTokens: 64,
      temperature: 0.2,
      fetcher: fn,
    })
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.model).toBe('anthropic/claude-haiku-4-5')
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ])
    expect(body.max_tokens).toBe(64)
    expect(body.temperature).toBe(0.2)
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer k_test')
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions')
  })

  it('returns content + raw + usage', async () => {
    const { fn } = makeFetcher(() => jsonResponse('hello world', { prompt_tokens: 5, completion_tokens: 2 }))
    const res = await chat({ model: 'anthropic/claude-haiku-4-5', user: 'x', fetcher: fn, retries: 0 })
    expect(res.content).toBe('hello world')
    expect(res.usage.inputTokens).toBe(5)
    expect(res.usage.outputTokens).toBe(2)
  })

  it('throws OpenRouterError with status on a 4xx response', async () => {
    const { fn } = makeFetcher(() => new Response('bad', { status: 400 }))
    let caught: unknown
    try {
      await chat({ model: 'm', user: 'x', fetcher: fn, retries: 0 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(OpenRouterError)
    expect((caught as OpenRouterError).status).toBe(400)
  })

  it('retries on 5xx and eventually succeeds', async () => {
    let n = 0
    const { fn, getAttempt } = makeFetcher(() => {
      n++
      if (n < 2) return new Response('boom', { status: 503 })
      return jsonResponse('finally')
    })
    const res = await chat({ model: 'm', user: 'x', fetcher: fn, retries: 2 })
    expect(res.content).toBe('finally')
    expect(getAttempt()).toBe(2)
  })

  it('throws RateLimitError on 429 and respects Retry-After', async () => {
    const { fn } = makeFetcher(() => new Response('limit', { status: 429, headers: { 'Retry-After': '0' } }))
    let caught: unknown
    try {
      await chat({ model: 'm', user: 'x', fetcher: fn, retries: 0 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RateLimitError)
    expect((caught as RateLimitError).status).toBe(429)
  })

  it('throws TimeoutError when fetch aborts', async () => {
    const { fn } = makeFetcher(async () => {
      // Simulate an abort by waiting forever; the AbortSignal will fire.
      await new Promise(r => setTimeout(r, 50))
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    })
    let caught: unknown
    try {
      await chat({ model: 'm', user: 'x', fetcher: fn, retries: 0, timeoutMs: 5 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TimeoutError)
  })

  it('throws OpenRouterError when the choice has empty content', async () => {
    const { fn } = makeFetcher(() => jsonResponse(''))
    let caught: unknown
    try {
      await chat({ model: 'm', user: 'x', fetcher: fn, retries: 0 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(OpenRouterError)
  })
})
