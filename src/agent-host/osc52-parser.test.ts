import { describe, expect, test } from 'bun:test'
import { type ClipboardCapture, detectImageMime, Osc52Parser } from './osc52-parser'

function parse(input: string | string[]): { output: string; captures: ClipboardCapture[] } {
  const parser = new Osc52Parser()
  const captures: ClipboardCapture[] = []
  const cb = (c: ClipboardCapture) => captures.push(c)

  let output = ''
  if (typeof input === 'string') {
    output = parser.write(input, cb)
  } else {
    for (const chunk of input) {
      output += parser.write(chunk, cb)
    }
  }

  return { output, captures }
}

// Helper: create OSC 52 sequence
function osc52(text: string, targets = 'c', terminator: 'bel' | 'st' = 'bel'): string {
  const b64 = Buffer.from(text).toString('base64')
  const term = terminator === 'bel' ? '\x07' : '\x1b\\'
  return `\x1b]52;${targets};${b64}${term}`
}

describe('Osc52Parser', () => {
  // ─── Basic detection ──────────────────────────────────────────

  test('passthrough: no escape sequences', () => {
    const { output, captures } = parse('hello world')
    expect(output).toBe('hello world')
    expect(captures).toHaveLength(0)
  })

  test('passthrough: empty string', () => {
    const { output, captures } = parse('')
    expect(output).toBe('')
    expect(captures).toHaveLength(0)
  })

  test('passthrough: non-OSC escape sequences', () => {
    const { output, captures } = parse('\x1b[32mgreen\x1b[0m')
    expect(output).toBe('\x1b[32mgreen\x1b[0m')
    expect(captures).toHaveLength(0)
  })

  test('detect OSC 52 with BEL terminator', () => {
    const { output, captures } = parse(osc52('hello'))
    expect(output).toBe('')
    expect(captures).toHaveLength(1)
    expect(captures[0].text).toBe('hello')
    expect(captures[0].contentType).toBe('text')
    expect(captures[0].targets).toBe('c')
  })

  test('detect OSC 52 with ST terminator', () => {
    const { output, captures } = parse(osc52('world', 'c', 'st'))
    expect(output).toBe('')
    expect(captures).toHaveLength(1)
    expect(captures[0].text).toBe('world')
  })

  test('strips OSC 52 from output', () => {
    const { output, captures } = parse(`before${osc52('clip')}after`)
    expect(output).toBe('beforeafter')
    expect(captures).toHaveLength(1)
    expect(captures[0].text).toBe('clip')
  })

  test('multiple OSC 52 in one chunk', () => {
    const { output, captures } = parse(`${osc52('first')}middle${osc52('second')}`)
    expect(output).toBe('middle')
    expect(captures).toHaveLength(2)
    expect(captures[0].text).toBe('first')
    expect(captures[1].text).toBe('second')
  })

  // ─── Selection targets ────────────────────────────────────────

  test('target: primary selection', () => {
    const { captures } = parse(osc52('text', 'p'))
    expect(captures[0].targets).toBe('p')
  })

  test('target: multiple targets', () => {
    const { captures } = parse(osc52('text', 'cp'))
    expect(captures[0].targets).toBe('cp')
  })

  test('target: empty defaults to c', () => {
    const b64 = Buffer.from('test').toString('base64')
    const { captures } = parse(`\x1b]52;;${b64}\x07`)
    expect(captures[0].targets).toBe('c')
  })

  // ─── Query handling ───────────────────────────────────────────

  test('query (?) is ignored', () => {
    const { output, captures } = parse('\x1b]52;c;?\x07')
    expect(output).toBe('')
    expect(captures).toHaveLength(0)
  })

  // ─── Split buffer handling ────────────────────────────────────

  test('split: ESC and ] in separate chunks', () => {
    const { output, captures } = parse(['\x1b', `]52;c;${Buffer.from('split').toString('base64')}\x07`])
    expect(captures).toHaveLength(1)
    expect(captures[0].text).toBe('split')
    expect(output).toBe('')
  })

  test('split: mid-ID', () => {
    const b64 = Buffer.from('test').toString('base64')
    const { captures } = parse(['\x1b]5', `2;c;${b64}\x07`])
    expect(captures).toHaveLength(1)
    expect(captures[0].text).toBe('test')
  })

  test('split: mid-targets', () => {
    const b64 = Buffer.from('test').toString('base64')
    const { captures } = parse(['\x1b]52;c', `;${b64}\x07`])
    expect(captures).toHaveLength(1)
    expect(captures[0].text).toBe('test')
  })

  test('split: mid-payload', () => {
    const b64 = Buffer.from('split payload test').toString('base64')
    const mid = Math.floor(b64.length / 2)
    const { captures } = parse([`\x1b]52;c;${b64.slice(0, mid)}`, `${b64.slice(mid)}\x07`])
    expect(captures).toHaveLength(1)
    expect(captures[0].text).toBe('split payload test')
  })

  test('split: terminator split (\\x1b and \\\\ in separate chunks)', () => {
    const b64 = Buffer.from('st-split').toString('base64')
    const { captures } = parse([`\x1b]52;c;${b64}\x1b`, '\\'])
    expect(captures).toHaveLength(1)
    expect(captures[0].text).toBe('st-split')
  })

  test('split: payload across 5 chunks', () => {
    const b64 = Buffer.from('five chunk test with longer text').toString('base64')
    const chunks = ['\x1b]52;c;']
    const chunkSize = Math.ceil(b64.length / 4)
    for (let i = 0; i < b64.length; i += chunkSize) {
      chunks.push(b64.slice(i, i + chunkSize))
    }
    chunks[chunks.length - 1] += '\x07'
    const { captures } = parse(chunks)
    expect(captures).toHaveLength(1)
    expect(captures[0].text).toBe('five chunk test with longer text')
  })

  test('split: byte-by-byte', () => {
    const seq = osc52('byte')
    const chars = seq.split('')
    const { captures } = parse(chars)
    expect(captures).toHaveLength(1)
    expect(captures[0].text).toBe('byte')
  })

  // ─── Interleaved with normal output ───────────────────────────

  test('OSC 52 between ANSI color codes', () => {
    const { output, captures } = parse(`\x1b[31mred${osc52('clip')}\x1b[0mnormal`)
    expect(output).toBe('\x1b[31mred\x1b[0mnormal')
    expect(captures).toHaveLength(1)
    expect(captures[0].text).toBe('clip')
  })

  test('normal ESC sequences before and after', () => {
    const { output } = parse(`\x1b[H\x1b[2J${osc52('x')}\x1b[?25h`)
    expect(output).toBe('\x1b[H\x1b[2J\x1b[?25h')
  })

  // ─── Non-OSC-52 OSC sequences ─────────────────────────────────

  test('non-52 OSC passes through', () => {
    const { output, captures } = parse('\x1b]0;window title\x07')
    expect(output).toBe('\x1b]0;window title\x07')
    expect(captures).toHaveLength(0)
  })

  test('OSC 7 (cwd) passes through', () => {
    const { output, captures } = parse('\x1b]7;file:///Users/test\x07')
    expect(output).toBe('\x1b]7;file:///Users/test\x07')
    expect(captures).toHaveLength(0)
  })

  // ─── Image detection ──────────────────────────────────────────

  test('detect PNG image', () => {
    // PNG magic: \x89PNG\r\n\x1a\n
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
    const b64 = pngHeader.toString('base64')
    const { captures } = parse(`\x1b]52;c;${b64}\x07`)
    expect(captures).toHaveLength(1)
    expect(captures[0].contentType).toBe('image')
    expect(captures[0].mimeType).toBe('image/png')
    expect(captures[0].text).toBeUndefined()
  })

  test('detect JPEG image', () => {
    const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const b64 = jpegHeader.toString('base64')
    const { captures } = parse(`\x1b]52;c;${b64}\x07`)
    expect(captures[0].contentType).toBe('image')
    expect(captures[0].mimeType).toBe('image/jpeg')
  })

  test('detect GIF image', () => {
    const gifHeader = Buffer.from('GIF89a')
    const b64 = gifHeader.toString('base64')
    const { captures } = parse(`\x1b]52;c;${b64}\x07`)
    expect(captures[0].contentType).toBe('image')
    expect(captures[0].mimeType).toBe('image/gif')
  })

  // ─── Edge cases ───────────────────────────────────────────────

  test('empty payload (clipboard clear) is ignored', () => {
    const { captures } = parse('\x1b]52;c;\x07')
    expect(captures).toHaveLength(0)
  })

  test('malformed: no semicolon after ID', () => {
    const { output, captures } = parse('\x1b]52X')
    expect(output).toBe('\x1b]52X')
    expect(captures).toHaveLength(0)
  })

  test('malformed: non-digit in ID', () => {
    const { output } = parse('\x1b]5a;foo\x07')
    expect(output).toBe('\x1b]5a;foo\x07')
  })

  test('consecutive OSC 52 with no gap', () => {
    const { captures } = parse(`${osc52('first')}${osc52('second')}`)
    expect(captures).toHaveLength(2)
    expect(captures[0].text).toBe('first')
    expect(captures[1].text).toBe('second')
  })

  test('accumulating state between writes', () => {
    const parser = new Osc52Parser()
    const captures: ClipboardCapture[] = []
    const cb = (c: ClipboardCapture) => captures.push(c)

    parser.write('\x1b]52;c;', cb)
    expect(parser.isAccumulating).toBe(true)

    parser.write(Buffer.from('hello').toString('base64'), cb)
    expect(parser.isAccumulating).toBe(true)
    expect(captures).toHaveLength(0)

    parser.write('\x07', cb)
    expect(parser.isAccumulating).toBe(false)
    expect(captures).toHaveLength(1)
    expect(captures[0].text).toBe('hello')
  })

  test('aborted sequence does not leak to output', () => {
    // Start an OSC 52, then hit a new ESC sequence before terminator
    const parser = new Osc52Parser()
    const captures: ClipboardCapture[] = []
    const cb = (c: ClipboardCapture) => captures.push(c)

    // Start OSC 52 but interrupt with CSI (ESC [)
    const out = parser.write('\x1b]52;c;AAAA\x1b[31m', cb)
    // The ESC inside payload triggers SAW_ESC_IN_PAYLOAD,
    // [ is not \\, so it aborts and re-processes as SAW_ESC -> GROUND
    expect(out).toBe('\x1b[31m')
    expect(captures).toHaveLength(0)
  })

  test('unicode text content', () => {
    const { captures } = parse(osc52('Hello, world! Hej pa dig! こんにちは'))
    expect(captures[0].text).toBe('Hello, world! Hej pa dig! こんにちは')
  })

  test('multiline text content', () => {
    const text = 'line 1\nline 2\nline 3\n'
    const { captures } = parse(osc52(text))
    expect(captures[0].text).toBe(text)
  })

  test('large text payload', () => {
    const text = 'x'.repeat(100_000)
    const { captures } = parse(osc52(text))
    expect(captures).toHaveLength(1)
    expect(captures[0].text).toBe(text)
  })

  // ─── Overflow protection ──────────────────────────────────────

  test('payload exceeding 10MB is dropped', () => {
    // Create a payload just over the limit
    const b64 = 'A'.repeat(10_000_001)
    const { captures } = parse(`\x1b]52;c;${b64}\x07`)
    expect(captures).toHaveLength(0)
  })

  test('overflow resets cleanly for next sequence', () => {
    const b64 = 'A'.repeat(10_000_001)
    const { captures } = parse(`\x1b]52;c;${b64}\x07${osc52('after overflow')}`)
    expect(captures).toHaveLength(1)
    expect(captures[0].text).toBe('after overflow')
  })
})

describe('detectImageMime', () => {
  test('PNG prefix', () => expect(detectImageMime('iVBORw0K')).toBe('image/png'))
  test('JPEG prefix', () => expect(detectImageMime('/9j/')).toBe('image/jpeg'))
  test('GIF87a prefix', () => expect(detectImageMime('R0lGODdh')).toBe('image/gif'))
  test('GIF89a prefix', () => expect(detectImageMime('R0lGODlh')).toBe('image/gif'))
  test('WebP prefix', () => expect(detectImageMime('UklGR')).toBe('image/webp'))
  test('text returns null', () => expect(detectImageMime('aGVsbG8=')).toBeNull())
  test('empty returns null', () => expect(detectImageMime('')).toBeNull())
})
