import { useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { recordSwitch } from '@/lib/conversation-frequency'
import type { Conversation } from '@/lib/types'
import { createKeyHandler, type KeyHandlerCallbacks } from './key-handlers'
import { derivePaletteMode } from './mode-detect'
import { useCommandMode } from './use-command-mode'
import { useConversationMode } from './use-conversation-mode'
import { useFileMode } from './use-file-mode'
import { useSpawnMode } from './use-spawn-mode'
import { useTaskMode } from './use-task-mode'
import { useThemeMode } from './use-theme-mode'

/**
 * Top-level command palette hook. Owns the search filter, active index, and
 * input ref. Each mode (conversation / command / file / spawn / task) is
 * implemented by a dedicated hook colocated in this folder; this orchestrator
 * stitches them together and produces the keyboard handler for the input.
 */
export function useCommandPalette(onClose: () => void) {
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const projectSettings = useConversationsStore(state => state.projectSettings)
  const sentinelConnected = useConversationsStore(state => state.sentinelConnected)

  const switcherInitialFilter = useConversationsStore(state => state.switcherInitialFilter)
  const [filter, setFilter] = useState(switcherInitialFilter)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Apply initial filter when switcher opens with a prefilled value, or when
  // a command inside the palette sets a new filter (e.g. Theme -> 'TH:')
  useEffect(() => {
    if (switcherInitialFilter) {
      setFilter(switcherInitialFilter)
      setActiveIndex(0)
      useConversationsStore.getState().openSwitcherWithFilter('')
    }
  }, [switcherInitialFilter])

  const { mode, isCommandMode, isFileMode, isSpawnMode, isTaskMode, isThemeMode, isConversationMode } =
    derivePaletteMode(filter)

  const command = useCommandMode(filter, isCommandMode, onClose)
  const conversation = useConversationMode(filter, isConversationMode, command.registryCommands)
  const file = useFileMode(filter, isFileMode)
  const spawn = useSpawnMode({
    filter,
    isSpawnMode,
    sentinelConnected,
    inputRef,
    setFilter,
    setActiveIndex,
    onClose,
  })
  const task = useTaskMode(filter, isTaskMode, selectedConversationId)
  const theme = useThemeMode(isThemeMode, activeIndex)

  const itemCount = isThemeMode
    ? theme.themes.length
    : isCommandMode
      ? command.filteredCommands.length
      : isSpawnMode
        ? spawn.isSentinelEntry
          ? spawn.filteredSentinels.length
          : spawn.filteredSpawnDirs.length
        : isFileMode
          ? file.filteredFiles.length
          : isTaskMode
            ? task.filteredTasks.length
            : conversation.mergedItems.length

  // Clamp activeIndex when the result count shrinks below it
  useEffect(() => {
    if (activeIndex >= itemCount) {
      setActiveIndex(Math.max(0, itemCount - 1))
    }
  }, [itemCount, activeIndex])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function handleKeyDown(e: React.KeyboardEvent, callbacks: KeyHandlerCallbacks) {
    const dispatch = createKeyHandler(
      {
        itemCount,
        activeIndex,
        setActiveIndex,
        setFilter,
        isCommandMode,
        isSpawnMode,
        isFileMode,
        isTaskMode,
        isThemeMode,
        command,
        conversation,
        file: { filteredFiles: file.filteredFiles },
        spawn,
        task,
        theme,
        selectedConversationId,
        onClose,
      },
      callbacks,
    )
    dispatch(e)
  }

  function selectConversationWithTracking(s: Conversation, onSelectConversation: (id: string) => void) {
    recordSwitch(s.project)
    onSelectConversation(s.id)
  }

  return {
    // State
    filter,
    setFilter,
    activeIndex,
    setActiveIndex,
    inputRef,
    mode,

    // Store data
    conversations: conversation.filteredConversations,
    mergedItems: conversation.mergedItems,
    allConversations: conversation.allConversations,
    selectedConversationId,
    projectSettings,
    sentinelConnected,

    // Command mode
    filteredCommands: command.filteredCommands,

    // File mode
    filteredFiles: file.filteredFiles,
    filesLoading: file.filesLoading,

    // Spawn mode
    filteredSpawnDirs: spawn.filteredSpawnDirs,
    filteredSentinels: spawn.filteredSentinels,
    isSentinelEntry: spawn.isSentinelEntry,
    spawnPath: spawn.spawnPath,
    spawnParentDir: spawn.spawnParentDir,
    spawnSentinel: spawn.spawnSentinel,
    spawnLoading: spawn.spawnLoading,
    spawnError: spawn.spawnError,
    spawning: spawn.spawning,
    canCreateDir: spawn.canCreateDir,

    // Task mode
    filteredTasks: task.filteredTasks,
    tasksLoading: task.tasksLoading,

    // Theme mode
    themes: theme.themes,
    themeConfirm: theme.confirm,
    themeRevert: theme.revert,

    // Actions
    handleKeyDown,
    handleSpawn: spawn.handleSpawn,
    handleDirSelect: spawn.handleDirSelect,
    handleSentinelSelect: spawn.handleSentinelSelect,
    selectConversationWithTracking,
  }
}
