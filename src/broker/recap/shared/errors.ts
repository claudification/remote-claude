export class OpenRouterError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'OpenRouterError'
  }
}

export class NoApiKeyError extends Error {
  constructor() {
    super('OPENROUTER_API_KEY is not configured')
    this.name = 'NoApiKeyError'
  }
}

export class RateLimitError extends OpenRouterError {
  constructor(retryAfterMs?: number) {
    super('OpenRouter rate limit hit', 429, retryAfterMs)
    this.name = 'RateLimitError'
  }
}

export class TimeoutError extends Error {
  constructor(message = 'Request timed out') {
    super(message)
    this.name = 'TimeoutError'
  }
}
