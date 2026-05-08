import type { PaletteMode } from './types'

/**
 * Pure mode derivation from the raw filter string.
 *
 * Prefixes:
 *   `>`     command mode
 *   `f:`    file mode (but `f:/` is treated as a literal filter, not file mode)
 *   `s:`    spawn mode
 *   `@`     task mode (VSCode-style)
 *   `t:`    task mode (legacy)
 *   none    session mode (sessions + commands merged)
 *
 * Modes are mutually exclusive and resolved in priority order: command > file
 * > spawn > task > session. The boolean flags exposed alongside `mode` are
 * convenience accessors for downstream hooks that branch on a single mode.
 */
export interface PaletteModeFlags {
  mode: PaletteMode
  isCommandMode: boolean
  isFileMode: boolean
  isSpawnMode: boolean
  isTaskMode: boolean
  isThemeMode: boolean
  isConversationMode: boolean
}

export function derivePaletteMode(filter: string): PaletteModeFlags {
  const lower = filter.toLowerCase()
  const isCommandMode = filter.startsWith('>')
  const isThemeMode = !isCommandMode && lower.startsWith('theme:')
  const isFileMode = !isCommandMode && !isThemeMode && lower.startsWith('f:') && !lower.startsWith('f:/')
  const isSpawnMode = !isCommandMode && !isThemeMode && lower.startsWith('s:')
  const isTaskMode = !isCommandMode && !isThemeMode && (filter.startsWith('@') || lower.startsWith('t:'))
  const isConversationMode = !isFileMode && !isSpawnMode && !isCommandMode && !isTaskMode && !isThemeMode

  const mode: PaletteMode = isCommandMode
    ? 'command'
    : isThemeMode
      ? 'theme'
      : isSpawnMode
        ? 'spawn'
        : isFileMode
          ? 'file'
          : isTaskMode
            ? 'task'
            : 'session'

  return { mode, isCommandMode, isFileMode, isSpawnMode, isTaskMode, isThemeMode, isConversationMode }
}
