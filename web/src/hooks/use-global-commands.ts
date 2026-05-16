import { useCallback, useEffect } from 'react'
import { openLaunchProfileManager } from '@/components/launch-profiles/manager-state'
import { openRecapCustomRangeDialog } from '@/components/recap-jobs/recap-custom-range-dialog'
import { createRecap, openRecapHistory } from '@/components/recap-jobs/recap-submenu'
import { openRenameModal } from '@/components/rename-modal'
import { openManageChatConnections } from '@/components/settings/manage-chat-connections-dialog'
import { openManageProjectLinks } from '@/components/settings/manage-project-links-dialog'
import { openSpawnDialog } from '@/components/spawn-dialog'
import { openTerminateConfirm } from '@/components/terminate-confirm'
import { sendInput, useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { formatShortcut, useChordCommand, useCommand, validateChordBindings } from '@/lib/commands'
import { focusInputEditor } from '@/lib/focus-input'
import { canTerminal, projectPath } from '@/lib/types'
import { isMobileViewport } from '@/lib/utils'

export function useGlobalCommands(toggleSidebar: () => void) {
  const openSwitcher = useCallback(() => {
    const store = useConversationsStore.getState()
    if (store.showTerminal) store.setShowTerminal(false)
    store.toggleSwitcher()
  }, [])

  const openCommandMode = useCallback(() => {
    const store = useConversationsStore.getState()
    if (store.showTerminal) store.setShowTerminal(false)
    store.openSwitcherWithFilter('>')
  }, [])

  useCommand('open-switcher', openSwitcher, {
    label: 'Command palette',
    shortcut: 'mod+p',
    group: 'Navigation',
  })

  useCommand('open-command-mode', openCommandMode, {
    label: 'Command palette (commands)',
    shortcut: 'mod+shift+p',
    group: 'Navigation',
  })

  useChordCommand('palette-via-chord', openSwitcher, {
    label: 'Command palette',
    key: 'k',
    group: 'Navigation',
  })

  useCommand(
    'toggle-verbose',
    () => {
      useConversationsStore.getState().toggleExpandAll()
    },
    { label: 'Toggle verbose / expand all', shortcut: 'mod+o', group: 'View' },
  )

  useCommand('toggle-sidebar', toggleSidebar, { label: 'Toggle sidebar', shortcut: 'mod+b', group: 'View' })

  useChordCommand(
    'toggle-debug',
    () => {
      useConversationsStore.getState().toggleDebugConsole()
    },
    { label: 'Toggle debug console', key: 'd', group: 'View' },
  )

  useCommand(
    'toggle-debug-direct',
    () => {
      useConversationsStore.getState().toggleDebugConsole()
    },
    { label: 'Toggle debug console', shortcut: 'ctrl+shift+d', group: 'View' },
  )

  useChordCommand(
    'toggle-tty',
    () => {
      const store = useConversationsStore.getState()
      if (store.showTerminal) {
        store.setShowTerminal(false)
        if (store.selectedConversationId) store.openTab(store.selectedConversationId, 'transcript')
      } else if (store.selectedConversationId) {
        const currentTab = store.requestedTab
        store.openTab(store.selectedConversationId, currentTab === 'tty' ? 'transcript' : 'tty')
      }
    },
    { label: 'Toggle terminal tab', key: 't', group: 'Navigation' },
  )

  useChordCommand(
    'fullscreen-terminal',
    () => {
      const store = useConversationsStore.getState()
      if (store.showTerminal) {
        store.setShowTerminal(false)
        if (store.selectedConversationId) store.openTab(store.selectedConversationId, 'transcript')
      } else {
        const conversation = store.selectedConversationId
          ? store.conversationsById[store.selectedConversationId]
          : undefined
        if (conversation && canTerminal(conversation) && conversation.connectionIds?.[0]) {
          store.openTerminal(conversation.connectionIds[0])
        }
      }
    },
    { label: 'Toggle fullscreen terminal', key: 'f', group: 'Navigation' },
  )

  useChordCommand(
    'spawn-conversation',
    () => {
      useConversationsStore.getState().openSwitcherWithFilter('S:~/')
    },
    { label: 'Spawn new conversation', key: 's', group: 'Conversation' },
  )

  useChordCommand(
    'launch-conversation',
    () => {
      const store = useConversationsStore.getState()
      const conversation = store.selectedConversationId
        ? store.conversationsById[store.selectedConversationId]
        : undefined
      const projectUri = conversation?.project ?? store.selectedProjectUri ?? undefined
      const spawnPath = conversation
        ? projectPath(conversation.project) || store.controlPanelPrefs.defaultConversationCwd
        : projectPath(store.selectedProjectUri ?? '') || store.controlPanelPrefs.defaultConversationCwd
      openSpawnDialog({ path: spawnPath || '~', projectUri })
    },
    { label: 'Launch conversation', key: 'l', group: 'Conversation' },
  )

  useChordCommand(
    'terminate-conversation',
    () => {
      const store = useConversationsStore.getState()
      const sid = store.selectedConversationId
      if (!sid) return
      const conversation = store.conversationsById[sid]
      if (!conversation || conversation.status === 'ended') return
      const name = conversation.title || conversation.agentName || null
      openTerminateConfirm(sid, name)
    },
    { label: 'Terminate conversation', key: 'x', group: 'Conversation' },
  )

  useCommand(
    'rename-conversation',
    () => {
      if (useConversationsStore.getState().selectedConversationId) {
        openRenameModal()
      }
    },
    { label: 'Rename conversation', shortcut: 'ctrl+shift+r', group: 'Conversation' },
  )

  useChordCommand(
    'rename-conversation-chord',
    () => {
      if (useConversationsStore.getState().selectedConversationId) {
        openRenameModal()
      }
    },
    { label: 'Rename conversation', key: 'r', group: 'Conversation' },
  )

  useChordCommand(
    'search-tasks',
    () => {
      useConversationsStore.getState().openSwitcherWithFilter('@')
    },
    { label: 'Search tasks', key: '/', group: 'Navigation' },
  )

  useChordCommand(
    'open-notes',
    () => {
      const store = useConversationsStore.getState()
      if (store.selectedConversationId) {
        store.openTab(store.selectedConversationId, 'files')
        store.setPendingFilePath('NOTES.md')
      }
    },
    { label: 'Open NOTES.md', key: 'o', group: 'Navigation' },
  )

  useChordCommand(
    'open-project',
    () => {
      const store = useConversationsStore.getState()
      const sid = store.selectedConversationId
      if (!sid) return
      const conversation = store.conversationsById[sid]
      if (conversation && conversation.status !== 'ended') {
        store.openTab(sid, 'project')
      }
    },
    { label: 'Open project board', key: 'p', group: 'Navigation' },
  )

  const goHome = useCallback(() => {
    if (isMobileViewport()) return
    const store = useConversationsStore.getState()
    if (store.showSwitcher || store.showDebugConsole || store.showTerminal) return
    if (!store.selectedConversationId) return
    store.selectSubagent(null)
    store.openTab(store.selectedConversationId, 'transcript')
    requestAnimationFrame(() => focusInputEditor())
  }, [])

  useCommand('go-home', goHome, {
    label: 'Go to transcript + focus input',
    shortcut: 'Escape',
    group: 'Navigation',
  })

  useChordCommand('go-home-chord', goHome, {
    label: 'Go to transcript',
    key: 'Space',
    group: 'Navigation',
  })

  useChordCommand(
    'toggle-ended-conversations',
    () => {
      const store = useConversationsStore.getState()
      store.updateControlPanelPrefs({ showEndedConversations: !store.controlPanelPrefs.showEndedConversations })
    },
    { label: 'Toggle show ended conversations', key: 'e', group: 'View' },
  )

  useCommand(
    'interrupt',
    () => {
      const store = useConversationsStore.getState()
      const sid = store.selectedConversationId
      if (!sid) return
      const conversation = store.conversationsById[sid]
      if (conversation && conversation.status !== 'ended') {
        wsSend('send_interrupt', { conversationId: sid })
      }
    },
    { label: 'Interrupt current turn', shortcut: 'Escape Escape', group: 'Conversation' },
  )

  useCommand(
    'switch-conversation',
    () => {
      const { conversationMru, conversations, selectConversation } = useConversationsStore.getState()
      const prev = conversationMru.slice(1).find((id: string) => conversations.some((s: { id: string }) => s.id === id))
      if (prev) selectConversation(prev, 'ctrl-tab')
    },
    { label: 'Switch to previous conversation', shortcut: 'ctrl+Tab', group: 'Navigation' },
  )

  const keepMicOpen = useConversationsStore(
    (s: { controlPanelPrefs: { keepMicOpen: boolean } }) => s.controlPanelPrefs.keepMicOpen,
  )
  useCommand(
    'toggle-keep-mic-open',
    () => {
      const store = useConversationsStore.getState()
      const next = !store.controlPanelPrefs.keepMicOpen
      store.updateControlPanelPrefs({ keepMicOpen: next })
      if (next) {
        import('@/hooks/use-voice-recording').then(m => m.prewarmMicStream())
      }
    },
    { label: keepMicOpen ? 'Keep mic open: ON (disable)' : 'Keep mic open: OFF (enable)', group: 'Voice' },
  )

  useCommand(
    'clear-reload',
    async () => {
      const { clearCacheAndReload } = await import('@/lib/utils')
      clearCacheAndReload()
    },
    { label: 'Clear cache & reload', group: 'System' },
  )

  useCommand('settings', () => window.dispatchEvent(new Event('open-settings')), { label: 'Settings', group: 'System' })

  useCommand('theme', () => {}, { label: 'Theme', group: 'System', submenu: 'theme:' })

  useCommand('manage-users', () => window.dispatchEvent(new Event('open-user-admin')), {
    label: 'Manage users',
    group: 'System',
    when: () => useConversationsStore.getState().permissions.canEditUsers,
  })

  useCommand('manage-sentinels', () => window.dispatchEvent(new Event('open-sentinel-manager')), {
    label: 'Manage sentinels',
    group: 'System',
    when: () => useConversationsStore.getState().permissions.canAdmin,
  })

  useCommand('manage-gateways', () => window.dispatchEvent(new Event('open-gateway-manager')), {
    label: 'Manage Hermes connections',
    group: 'System',
    when: () => useConversationsStore.getState().permissions.canAdmin,
  })

  useCommand('manage-search-index', () => window.dispatchEvent(new Event('open-search-index')), {
    label: 'Manage search index',
    group: 'System',
    when: () => useConversationsStore.getState().permissions.canAdmin,
  })

  useCommand('manage-chat-connections', () => openManageChatConnections(), {
    label: 'Manage chat connections',
    group: 'System',
    when: () => useConversationsStore.getState().permissions.canAdmin,
  })

  useCommand('manage-launch-profiles', () => openLaunchProfileManager(), {
    label: 'Manage Launch Profiles',
    group: 'Launch',
  })

  // ─── Recap commands ───────────────────────────────────────────────────
  // Resolves the "this project" target for project-scoped recaps. Falls back
  // to '*' (cross-project) when no conversation is selected.
  function selectedProjectOrCross(): string {
    const sid = useConversationsStore.getState().selectedConversationId
    const conversations = useConversationsStore.getState().conversations
    const selected = conversations.find((s: { id: string; project?: string }) => s.id === sid)
    return selected?.project ?? '*'
  }

  useCommand(
    'recap-this-project-7',
    () => {
      const proj = selectedProjectOrCross()
      createRecap({ projectUri: proj, label: 'last_7' })
    },
    { label: 'Recap this project (last 7 days)', group: 'Recap' },
  )
  useCommand('recap-this-project-today', () => createRecap({ projectUri: selectedProjectOrCross(), label: 'today' }), {
    label: 'Recap this project (today)',
    group: 'Recap',
  })
  useCommand(
    'recap-this-project-yesterday',
    () => createRecap({ projectUri: selectedProjectOrCross(), label: 'yesterday' }),
    { label: 'Recap this project (yesterday)', group: 'Recap' },
  )
  useCommand(
    'recap-this-project-month',
    () => createRecap({ projectUri: selectedProjectOrCross(), label: 'this_month' }),
    { label: 'Recap this project (this month)', group: 'Recap' },
  )
  useCommand('recap-this-project-custom', () => openRecapCustomRangeDialog({ projectUri: selectedProjectOrCross() }), {
    label: 'Recap this project (custom range)...',
    group: 'Recap',
  })

  useCommand('recap-cross-today', () => createRecap({ projectUri: '*', label: 'today' }), {
    label: 'Recap all projects (today)',
    group: 'Recap',
  })
  useCommand('recap-cross-yesterday', () => createRecap({ projectUri: '*', label: 'yesterday' }), {
    label: 'Recap all projects (yesterday)',
    group: 'Recap',
  })
  useCommand('recap-cross-7', () => createRecap({ projectUri: '*', label: 'last_7' }), {
    label: 'Recap all projects (last 7 days)',
    group: 'Recap',
  })
  useCommand('recap-cross-month', () => createRecap({ projectUri: '*', label: 'this_month' }), {
    label: 'Recap all projects (this month)',
    group: 'Recap',
  })
  useCommand('recap-cross-custom', () => openRecapCustomRangeDialog({ projectUri: '*' }), {
    label: 'Recap all projects (custom range)...',
    group: 'Recap',
  })

  useCommand('recap-view-all', () => openRecapHistory(), {
    label: 'View recaps',
    group: 'Recap',
  })

  useCommand(
    'manage-project-links',
    () => {
      const sid = useConversationsStore.getState().selectedConversationId
      const conversations = useConversationsStore.getState().conversations
      const selected = conversations.find((s: { id: string; project?: string }) => s.id === sid)
      openManageProjectLinks(selected?.project)
    },
    { label: 'Manage project links', group: 'System' },
  )

  useCommand(
    'effort',
    (level = 'medium') => {
      const sid = useConversationsStore.getState().selectedConversationId
      if (sid) sendInput(sid, `/effort ${level}`)
    },
    { label: 'Set effort level', group: 'Conversation' },
  )

  useEffect(() => {
    const timer = setTimeout(() => {
      const conflicts = validateChordBindings()
      for (const c of conflicts) {
        const longer = c.longerChords.map(l => formatShortcut(l.shortcut)).join(', ')
        window.dispatchEvent(
          new CustomEvent('rclaude-toast', {
            detail: {
              title: 'CHORD CONFLICT',
              body: `"${c.bindingLabel}" (${formatShortcut(c.binding)}) is also a prefix of: ${longer} -- it will only fire on timeout`,
              variant: 'warning',
            },
          }),
        )
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [])
}
