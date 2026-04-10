import { sendInput, useSessionsStore } from '@/hooks/use-sessions'
import { canTerminal } from '@/lib/types'
import type { PaletteCommand } from './types'

export function getPaletteCommands(onClose: () => void): PaletteCommand[] {
  const store = useSessionsStore.getState()
  const session = store.sessions.find(s => s.id === store.selectedSessionId)
  const { canEditUsers } = store.permissions
  return [
    ...(canEditUsers
      ? [
          {
            id: 'manage-users',
            label: 'Manage users',
            action: () => {
              window.dispatchEvent(new Event('open-user-admin'))
              onClose()
            },
          },
        ]
      : []),
    ...(store.selectedSessionId
      ? [
          {
            id: 'go-home',
            label: 'Go to transcript + focus input',
            shortcut: 'Esc',
            action: () => {
              store.selectSubagent(null)
              if (store.selectedSessionId) store.openTab(store.selectedSessionId, 'transcript')
              onClose()
              requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus())
            },
          },
        ]
      : []),
    {
      id: 'settings',
      label: 'Settings',
      action: () => {
        window.dispatchEvent(new Event('open-settings'))
        onClose()
      },
    },
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
      id: 'quick-task',
      label: 'Quick task',
      shortcut: 'Ctrl+Shift+N',
      action: () => {
        window.dispatchEvent(new Event('open-quick-task'))
        onClose()
      },
    },
    ...(store.selectedSessionId
      ? [
          {
            id: 'open-notes',
            label: 'Open NOTES.md in file editor',
            shortcut: 'Ctrl+Shift+Alt+N',
            action: () => {
              if (store.selectedSessionId) store.openTab(store.selectedSessionId, 'files')
              store.setPendingFilePath('NOTES.md')
              onClose()
            },
          },
        ]
      : []),
    ...(session && canTerminal(session) && session.wrapperIds?.[0]
      ? [
          {
            id: 'terminal',
            label: 'Toggle terminal for current session',
            shortcut: 'Ctrl+Shift+T',
            action: () => {
              if (store.showTerminal) {
                store.setShowTerminal(false)
              } else {
                if (session.wrapperIds?.[0]) store.openTerminal(session.wrapperIds[0])
              }
              onClose()
            },
          },
        ]
      : []),
    ...(store.selectedSessionId && session?.status === 'active'
      ? (['low', 'medium', 'high', 'max'] as const).map(level => ({
          id: `effort-${level}`,
          label: `Set effort: ${level}`,
          action: () => {
            if (store.selectedSessionId) sendInput(store.selectedSessionId, `/effort ${level}`)
            onClose()
          },
        }))
      : []),
  ]
}
