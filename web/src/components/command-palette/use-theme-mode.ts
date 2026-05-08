import { useEffect, useRef } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { applyTheme, findTheme, THEMES } from '@/lib/themes'

export interface ThemeModeState {
  themes: typeof THEMES
  confirm: (index: number) => void
  revert: () => void
}

export function useThemeMode(isThemeMode: boolean, activeIndex: number): ThemeModeState {
  const originalThemeRef = useRef<string | null>(null)

  // Capture original theme when entering theme mode
  useEffect(() => {
    if (isThemeMode) {
      originalThemeRef.current = useConversationsStore.getState().controlPanelPrefs.theme || 'tokyo-night'
    } else {
      originalThemeRef.current = null
    }
  }, [isThemeMode])

  // Live-preview on arrow navigation
  useEffect(() => {
    if (!isThemeMode) return
    const theme = THEMES[activeIndex]
    if (theme) applyTheme(theme)
  }, [isThemeMode, activeIndex])

  function confirm(index: number) {
    const theme = THEMES[index]
    if (!theme) return
    applyTheme(theme)
    useConversationsStore.getState().updateControlPanelPrefs({ theme: theme.id })
    originalThemeRef.current = null
  }

  function revert() {
    const id = originalThemeRef.current || 'tokyo-night'
    applyTheme(findTheme(id))
    originalThemeRef.current = null
  }

  return { themes: THEMES, confirm, revert }
}
