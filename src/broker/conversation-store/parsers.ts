/**
 * Pure parsing/detection helpers for session-store.
 * No closure state, no side effects -- safe to call from anywhere.
 */

import { detectImageMime } from '../../shared/mime-detect'

/** Re-export under the name used by conversation-store consumers */
export { detectImageMime as detectClipboardMime }

/** Parse /model or /context command stdout to detect 1M vs standard context mode.
 * Returns undefined if the entry isn't a relevant local-command-stdout. */
export function detectContextModeFromStdout(content: string): '1m' | 'standard' | undefined {
  // Strip ANSI escape codes for cleaner matching
  const clean = content.replace(/\x1b\[[0-9;]*m/g, '')
  // /model confirmation: "Set model to <label>" or "Kept model as <label>"
  const modelMatch = clean.match(/(?:Set model to|Kept model as)\s+(.+?)(?:\s+·|\n|$)/i)
  if (modelMatch) {
    return /\(1M context\)/i.test(modelMatch[1]) ? '1m' : 'standard'
  }
  // /context output: header "Context Usage" + full model id including variant suffix
  if (/Context Usage/i.test(clean)) {
    return /\[1m\]/i.test(clean) ? '1m' : 'standard'
  }
  return undefined
}

/** Check if decoded text is mostly printable (not garbled binary) */
export function isReadableText(text: string): boolean {
  if (text.length === 0) return false
  let printable = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // Printable ASCII, common Unicode, newlines, tabs
    if ((code >= 0x20 && code < 0x7f) || code === 0x0a || code === 0x0d || code === 0x09 || code >= 0xa0) {
      printable++
    }
  }
  return printable / text.length > 0.8
}
