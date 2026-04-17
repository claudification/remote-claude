export const PALETTE = [
  '#f9a8d4',
  '#f472b6',
  '#c084fc',
  '#a78bfa',
  '#818cf8',
  '#60a5fa',
  '#38bdf8',
  '#22d3ee',
  '#2dd4bf',
  '#4ade80',
  '#a3e635',
  '#facc15',
  '#fbbf24',
  '#fb923c',
  '#f87171',
  '#e2e8f0',
]

export const OPACITY_STEPS = [100, 85, 70, 50, 35, 20, 10, 0]

export function hexToRgba(hex: string, opacity: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${(opacity / 100).toFixed(2)})`
}

export function parseRgbaOpacity(rgba: string): number {
  const m = rgba.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/)
  return m ? Math.round(Number.parseFloat(m[1]) * 100) : 100
}

export function parseRgbaHex(rgba: string): string | null {
  const m = rgba.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (!m) return null
  const toHex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${toHex(Number(m[1]))}${toHex(Number(m[2]))}${toHex(Number(m[3]))}`
}
