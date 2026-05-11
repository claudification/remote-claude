/**
 * Robust JSON extraction from LLM output. LLMs love to wrap JSON in
 * markdown fences, prepend "Sure! Here's your JSON:", or trail off with
 * "Hope this helps". We strip all of that and grab the first balanced
 * object we can find.
 */

export interface RecapContent {
  title: string | null
  recap: string
}

export function findFirstJsonObject(raw: string): string | null {
  const stripped = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '')
  const match = stripped.match(/\{[\s\S]*\}/)
  return match ? match[0] : null
}

export function parseRecapContent(raw: string): RecapContent {
  const obj = tryParseJsonObject(findFirstJsonObject(raw))
  if (!obj) return { title: null, recap: raw.trim() }
  return { title: stringFieldOrNull(obj.title), recap: stringFieldOrFallback(obj.recap, raw) }
}

function tryParseJsonObject(candidate: string | null): Record<string, unknown> | null {
  if (!candidate) return null
  try {
    return JSON.parse(candidate) as Record<string, unknown>
  } catch {
    return null
  }
}

function stringFieldOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stringFieldOrFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}
