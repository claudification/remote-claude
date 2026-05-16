import type { RecapAudience } from '../../../../shared/protocol'

const HAIKU_MODEL = 'anthropic/claude-haiku-4.5'
const SONNET_MODEL = 'anthropic/claude-sonnet-4'

const ESCALATE_THRESHOLD_CHARS = 50_000
const CHUNK_CEILING_CHARS = 600_000

export interface ModelChoice {
  model: string
  reason: 'small' | 'escalated' | 'too-big' | 'audience-floor'
}

export function pickModel(inputChars: number, audience: RecapAudience = 'human'): ModelChoice {
  if (inputChars > CHUNK_CEILING_CHARS) return { model: SONNET_MODEL, reason: 'too-big' }
  if (inputChars > ESCALATE_THRESHOLD_CHARS) return { model: SONNET_MODEL, reason: 'escalated' }
  // The agent brief's whole value is judgment -- separating signal from
  // noise, fact from inference, spotting dead ends. Haiku misjudges that.
  // Floor the agent audience at Sonnet regardless of input size.
  if (audience === 'agent') return { model: SONNET_MODEL, reason: 'audience-floor' }
  return { model: HAIKU_MODEL, reason: 'small' }
}
