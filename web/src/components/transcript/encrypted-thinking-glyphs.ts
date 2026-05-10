// Deterministic "matrix rain" glyph soup for encrypted thinking blocks.
// Same seed (signature) -> same visual every render. Length scales with
// estimated byte count so the visual conveys the size of the sealed blob.

const SHADING = ['░', '▒', '▓', '█']
const JOINS = ['╳', '╋']

function fnv1a(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h || 1
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function makeEncryptedGlyphs(seed: string, bytes: number, lineLen = 56): string {
  const rng = mulberry32(fnv1a(seed))
  const total = Math.max(60, Math.min(540, bytes))
  const chars: string[] = []
  for (let i = 0; i < total; i++) {
    const r = rng()
    let ch: string
    if (r < 0.05) ch = SHADING[Math.floor(rng() * SHADING.length)]
    else if (r < 0.07) ch = JOINS[Math.floor(rng() * JOINS.length)]
    else if (r < 0.17) ch = String.fromCharCode(0x30 + Math.floor(rng() * 10))
    else ch = String.fromCharCode(0xff66 + Math.floor(rng() * (0xff9d - 0xff66 + 1)))
    chars.push(ch)
  }
  const lines: string[] = []
  for (let i = 0; i < chars.length; i += lineLen) {
    lines.push(chars.slice(i, i + lineLen).join(''))
  }
  return lines.join('\n')
}
