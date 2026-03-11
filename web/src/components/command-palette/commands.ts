import { useSessionsStore } from '@/hooks/use-sessions'
import { canTerminal } from '@/lib/types'
import type { PaletteCommand } from './types'

export function getPaletteCommands(onClose: () => void): PaletteCommand[] {
  const store = useSessionsStore.getState()
  const session = store.sessions.find(s => s.id === store.selectedSessionId)
  return [
    {
      id: 'debug-console',
      label: 'Toggle debug console',
      shortcut: 'Ctrl+Shift+D',
      action: () => {
        store.toggleDebugConsole()
        onClose()
      },
    },
    {
      id: 'verbose',
      label: 'Toggle verbose / expand all',
      shortcut: 'Ctrl+O',
      action: () => {
        store.toggleExpandAll()
        onClose()
      },
    },
    {
      id: 'quick-note',
      label: 'Quick note (append to NOTES.md)',
      shortcut: 'Ctrl+Shift+N',
      action: () => {
        window.dispatchEvent(new Event('open-quick-note'))
        onClose()
      },
    },
    ...(session && canTerminal(session) && session.wrapperIds?.[0]
      ? [
          {
            id: 'terminal',
            label: 'Open terminal for current session',
            shortcut: 'Ctrl+Shift+T',
            action: () => {
              store.openTerminal(session.wrapperIds![0])
              onClose()
            },
          },
        ]
      : []),
  ]
}
