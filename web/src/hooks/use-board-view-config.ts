import { useCallback, useEffect, useState } from 'react'

export type Density = 'compact' | 'normal' | 'roomy'
export type TitleSize = 'xs' | 'sm'

export type BoardViewConfig = {
  columnWidth: number
  bodyLines: number
  density: Density
  titleSize: TitleSize
}

export const BOARD_VIEW_DEFAULTS: BoardViewConfig = {
  columnWidth: 220,
  bodyLines: 2,
  density: 'normal',
  titleSize: 'xs',
}

const STORAGE_KEY = 'rclaude.project-board-view.v1'

function load(): BoardViewConfig {
  if (typeof localStorage === 'undefined') return BOARD_VIEW_DEFAULTS
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return BOARD_VIEW_DEFAULTS
    const parsed = JSON.parse(raw)
    return {
      columnWidth: clampNum(parsed.columnWidth, 200, 400, BOARD_VIEW_DEFAULTS.columnWidth),
      bodyLines: clampNum(parsed.bodyLines, 0, 6, BOARD_VIEW_DEFAULTS.bodyLines),
      density: ['compact', 'normal', 'roomy'].includes(parsed.density) ? parsed.density : BOARD_VIEW_DEFAULTS.density,
      titleSize: ['xs', 'sm'].includes(parsed.titleSize) ? parsed.titleSize : BOARD_VIEW_DEFAULTS.titleSize,
    }
  } catch {
    return BOARD_VIEW_DEFAULTS
  }
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function useBoardViewConfig() {
  const [config, setConfig] = useState<BoardViewConfig>(load)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
    } catch {}
  }, [config])

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setConfig(load())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const update = useCallback(<K extends keyof BoardViewConfig>(key: K, value: BoardViewConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }))
  }, [])

  const reset = useCallback(() => setConfig(BOARD_VIEW_DEFAULTS), [])

  return { config, update, reset }
}

export const CLAMP_CLASS: Record<number, string> = {
  0: 'hidden',
  1: 'line-clamp-1',
  2: 'line-clamp-2',
  3: 'line-clamp-3',
  4: 'line-clamp-4',
  5: 'line-clamp-5',
  6: 'line-clamp-6',
}

export const DENSITY_PADDING: Record<Density, string> = {
  compact: 'px-2 py-1',
  normal: 'px-3 py-2',
  roomy: 'px-4 py-3',
}

export const TITLE_SIZE_CLASS: Record<TitleSize, string> = {
  xs: 'text-xs',
  sm: 'text-sm',
}
