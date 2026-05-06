/**
 * Parse recap content from either JSON or plain text.
 * Handles: raw JSON, markdown-fenced JSON, extra text around JSON, and
 * legacy plain-text recaps (pre-structured format).
 */
export function parseRecapContent(raw: string): { title: string | null; recap: string } {
  const stripped = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '')

  try {
    const jsonMatch = stripped.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const obj = JSON.parse(jsonMatch[0])
      const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : null
      const recap = typeof obj.recap === 'string' && obj.recap.trim() ? obj.recap.trim() : raw
      return { title, recap }
    }
  } catch {}

  return { title: null, recap: raw.trim() }
}
