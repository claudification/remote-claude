const HAIKU_MODEL = 'anthropic/claude-haiku-4.5'
const SONNET_MODEL = 'anthropic/claude-sonnet-4'

const ESCALATE_THRESHOLD_CHARS = 50_000
const CHUNK_CEILING_CHARS = 600_000

export interface ModelChoice {
  model: string
  reason: 'small' | 'escalated' | 'too-big'
}

export function pickModel(inputChars: number): ModelChoice {
  if (inputChars > CHUNK_CEILING_CHARS) return { model: SONNET_MODEL, reason: 'too-big' }
  if (inputChars > ESCALATE_THRESHOLD_CHARS) return { model: SONNET_MODEL, reason: 'escalated' }
  return { model: HAIKU_MODEL, reason: 'small' }
}
