/**
 * OSC 52 Clipboard Sequence Parser
 *
 * Scans PTY output stream for OSC 52 clipboard write sequences and extracts
 * the payload. Handles sequences split across multiple write chunks.
 *
 * Format: \x1b]52;<targets>;<base64-payload><terminator>
 * Terminators: \x07 (BEL) or \x1b\\ (ST)
 *
 * The parser is a simple state machine that persists between write() calls.
 * Non-OSC-52 data passes through unchanged.
 */

import { detectImageMime } from '../shared/mime-detect'

export { detectImageMime }

const MAX_PAYLOAD_SIZE = 10_000_000 // 10MB (matches xterm.js limit)

// fallow-ignore-next-line duplicate-export
export interface ClipboardCapture {
  targets: string // e.g. 'c', 'p', 'cp'
  base64: string // raw base64 payload
  contentType: 'text' | 'image'
  mimeType?: string // 'image/png', 'image/jpeg', etc.
  text?: string // decoded text (only for text content)
}

enum State {
  GROUND = 0,
  SAW_ESC, // saw \x1b
  IN_OSC_ID, // saw \x1b], accumulating numeric ID
  IN_OSC_TARGETS, // past "52;", accumulating target chars
  IN_OSC_PAYLOAD, // past second ";", accumulating base64
  SAW_ESC_IN_PAYLOAD, // saw \x1b inside payload (potential ST)
}

export class Osc52Parser {
  private state: State = State.GROUND
  private oscId = ''
  private targets = ''
  private payload = ''
  private payloadOverflow = false

  /** Process a chunk of PTY output. Returns cleaned output (OSC 52 sequences stripped). */
  write(data: string, onCapture: (capture: ClipboardCapture) => void): string {
    let out = ''
    let i = 0

    while (i < data.length) {
      const ch = data[i]
      const code = data.charCodeAt(i)

      switch (this.state) {
        case State.GROUND:
          if (code === 0x1b) {
            this.state = State.SAW_ESC
          } else {
            out += ch
          }
          break

        case State.SAW_ESC:
          if (ch === ']') {
            this.state = State.IN_OSC_ID
            this.oscId = ''
          } else {
            // Not an OSC -- emit the ESC and current char
            out += `\x1b${ch}`
            this.state = State.GROUND
          }
          break

        case State.IN_OSC_ID:
          if (ch >= '0' && ch <= '9') {
            this.oscId += ch
          } else if (ch === ';') {
            if (this.oscId === '52') {
              this.state = State.IN_OSC_TARGETS
              this.targets = ''
              this.payload = ''
              this.payloadOverflow = false
            } else {
              // Not OSC 52 -- emit what we consumed and scan for terminator
              out += `\x1b]${this.oscId};`
              this.state = State.GROUND
            }
          } else {
            // Malformed OSC -- emit and reset
            out += `\x1b]${this.oscId}${ch}`
            this.state = State.GROUND
          }
          break

        case State.IN_OSC_TARGETS:
          if (ch === ';') {
            this.state = State.IN_OSC_PAYLOAD
          } else if (code === 0x07 || code === 0x1b) {
            // Empty payload (clear clipboard) or premature terminator
            if (code === 0x1b) {
              this.state = State.SAW_ESC_IN_PAYLOAD
            } else {
              this.reset()
            }
          } else {
            this.targets += ch
          }
          break

        case State.IN_OSC_PAYLOAD:
          if (code === 0x07) {
            // BEL terminator -- sequence complete
            this.complete(onCapture)
          } else if (code === 0x1b) {
            this.state = State.SAW_ESC_IN_PAYLOAD
          } else {
            if (!this.payloadOverflow) {
              this.payload += ch
              if (this.payload.length > MAX_PAYLOAD_SIZE) {
                this.payloadOverflow = true
                this.payload = ''
              }
            }
          }
          break

        case State.SAW_ESC_IN_PAYLOAD:
          if (ch === '\\') {
            // ST terminator (\x1b\\) -- sequence complete
            this.complete(onCapture)
          } else {
            // Not ST -- the \x1b starts something else, abort this OSC
            // Don't emit the accumulated payload (it was meant for clipboard)
            this.state = State.SAW_ESC
            // Re-process this character in SAW_ESC state
            continue
          }
          break
      }

      i++
    }

    return out
  }

  private complete(onCapture: (capture: ClipboardCapture) => void): void {
    if (!this.payloadOverflow && this.payload.length > 0 && this.payload !== '?') {
      const mime = detectImageMime(this.payload)
      if (mime) {
        onCapture({
          targets: this.targets || 'c',
          base64: this.payload,
          contentType: 'image',
          mimeType: mime,
        })
      } else {
        try {
          const text = Buffer.from(this.payload, 'base64').toString('utf-8')
          onCapture({
            targets: this.targets || 'c',
            base64: this.payload,
            contentType: 'text',
            text,
          })
        } catch {
          // Invalid base64 -- ignore
        }
      }
    }
    this.reset()
  }

  private reset(): void {
    this.state = State.GROUND
    this.oscId = ''
    this.targets = ''
    this.payload = ''
    this.payloadOverflow = false
  }

  /** Check if the parser is mid-sequence (useful for testing) */
  get isAccumulating(): boolean {
    return this.state !== State.GROUND
  }
}
