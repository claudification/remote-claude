/**
 * MIME type detection from base64-encoded content.
 *
 * Checks the leading characters of a base64 string to identify common
 * image formats without decoding the full payload.
 */

/** Detect image MIME type from base64 prefix. Returns null for non-image content. */
export function detectImageMime(base64: string): string | null {
  if (base64.startsWith('iVBORw0K')) return 'image/png'
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('R0lGOD')) return 'image/gif'
  if (base64.startsWith('UklGR')) return 'image/webp'
  return null
}
