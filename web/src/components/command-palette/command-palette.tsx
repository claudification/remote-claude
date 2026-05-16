import { FileText, FolderPlus } from 'lucide-react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useKeyLayer } from '@/lib/key-layers'
import { CommandResults, CommandRow } from './command-results'
import { ConversationRow } from './conversation-results'
import { FileResults } from './file-results'
import { FooterHints } from './footer-hints'
import { SpawnResults } from './spawn-results'
import { ThemeResults } from './theme-results'
import type { CommandPaletteProps } from './types'
import { useCommandPalette } from './use-command-palette'

export function CommandPalette({ onSelect, onFileSelect, onClose }: CommandPaletteProps) {
  const palette = useCommandPalette(onClose)

  useKeyLayer(
    {
      Escape: () => {
        if (palette.mode === 'theme') {
          palette.themeRevert()
          palette.setFilter('>')
          palette.setActiveIndex(0)
        } else {
          onClose()
        }
      },
    },
    { id: 'command-palette' },
  )

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop overlay closes on click
    <div
      role="presentation"
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        className="w-full max-w-lg bg-surface-inset border border-primary/20 shadow-2xl font-mono"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="px-3 py-2 border-b border-primary/20 flex items-center gap-2">
          {palette.mode === 'spawn' && <FolderPlus className="w-4 h-4 text-active shrink-0" />}
          {palette.mode === 'file' && <FileText className="w-4 h-4 text-primary shrink-0" />}
          <input
            ref={palette.inputRef}
            type="text"
            value={palette.filter}
            onChange={e => {
              palette.setFilter(e.target.value)
              palette.setActiveIndex(0)
            }}
            onKeyDown={e => palette.handleKeyDown(e, { onSelectConversation: onSelect, onFileSelect })}
            placeholder={
              palette.mode === 'theme'
                ? 'Select theme (arrows to preview, enter to apply, esc to revert)...'
                : palette.mode === 'command'
                  ? 'Type a command...'
                  : palette.mode === 'spawn'
                    ? 'Path to spawn (e.g. projects/my-app or /absolute/path)...'
                    : palette.mode === 'file'
                      ? 'Search files...'
                      : palette.mode === 'task'
                        ? 'Search project tasks...'
                        : 'Search conversations + commands... (>cmd  @tasks  F:files  S:spawn)'
            }
            className="w-full bg-transparent text-[19px] sm:text-sm text-foreground placeholder:text-comment outline-none"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Results */}
        <div className="max-h-[40vh] overflow-y-auto">
          {palette.mode === 'theme' ? (
            <ThemeResults
              themes={palette.themes}
              currentThemeId={useConversationsStore.getState().controlPanelPrefs.theme || 'tokyo-night'}
              activeIndex={palette.activeIndex}
              setActiveIndex={palette.setActiveIndex}
              onSelect={i => {
                palette.themeConfirm(i)
                onClose()
              }}
            />
          ) : palette.mode === 'command' ? (
            <CommandResults
              commands={palette.filteredCommands}
              activeIndex={palette.activeIndex}
              setActiveIndex={palette.setActiveIndex}
            />
          ) : palette.mode === 'spawn' ? (
            <SpawnResults
              dirs={palette.filteredSpawnDirs}
              sentinels={palette.filteredSentinels}
              isSentinelEntry={palette.isSentinelEntry}
              resolvedSentinel={palette.spawnSentinel}
              loading={palette.spawnLoading}
              error={palette.spawnError}
              path={palette.spawnPath}
              spawning={palette.spawning}
              sentinelConnected={palette.sentinelConnected}
              canCreateDir={palette.canCreateDir}
              activeIndex={palette.activeIndex}
              setActiveIndex={palette.setActiveIndex}
              onDirSelect={palette.handleDirSelect}
              onSentinelSelect={palette.handleSentinelSelect}
              onSpawn={palette.handleSpawn}
            />
          ) : palette.mode === 'task' ? (
            <div>
              {palette.tasksLoading ? (
                <div className="px-4 py-3 text-comment text-xs">Loading tasks...</div>
              ) : palette.filteredTasks.length === 0 ? (
                <div className="px-4 py-3 text-comment text-xs">No matching tasks</div>
              ) : (
                palette.filteredTasks.map((task, i) => (
                  <button
                    key={task.slug}
                    type="button"
                    className={`w-full flex items-center gap-2 px-4 py-2 text-left text-xs transition-colors ${
                      i === palette.activeIndex
                        ? 'bg-primary/20 text-foreground'
                        : 'text-foreground hover:bg-surface-inset'
                    }`}
                    onClick={() => {
                      useConversationsStore.getState().setPendingTaskEdit({ slug: task.slug, status: task.status })
                      onClose()
                    }}
                    onMouseEnter={() => palette.setActiveIndex(i)}
                  >
                    <span
                      className={`px-1 py-0.5 text-[9px] font-bold uppercase ${
                        task.status === 'open'
                          ? 'bg-primary/20 text-primary'
                          : task.status === 'in-progress'
                            ? 'bg-accent/20 text-accent'
                            : 'bg-active/20 text-active'
                      }`}
                    >
                      {task.status}
                    </span>
                    <span className="flex-1 truncate font-mono">{task.title}</span>
                    {task.priority && <span className="text-[9px] text-comment">{task.priority}</span>}
                  </button>
                ))
              )}
            </div>
          ) : palette.mode === 'file' ? (
            <FileResults
              files={palette.filteredFiles}
              loading={palette.filesLoading}
              selectedConversationId={palette.selectedConversationId}
              activeIndex={palette.activeIndex}
              setActiveIndex={palette.setActiveIndex}
              onFileSelect={onFileSelect}
            />
          ) : palette.mergedItems.length === 0 ? (
            <div className="px-3 py-4 text-center text-[10px] text-comment">No matches</div>
          ) : (
            palette.mergedItems.map((item, i) =>
              item.kind === 'conversation' ? (
                <ConversationRow
                  key={`s:${item.conversation.id}`}
                  conversation={item.conversation}
                  selectedConversationId={palette.selectedConversationId}
                  projectSettings={palette.projectSettings}
                  active={i === palette.activeIndex}
                  onSelect={() => {
                    const sess = useConversationsStore.getState().conversationsById[item.conversation.id]
                    if (sess) palette.selectConversationWithTracking(sess, onSelect)
                    else onSelect(item.conversation.id)
                  }}
                  onMouseEnter={() => palette.setActiveIndex(i)}
                />
              ) : (
                <CommandRow
                  key={`c:${item.command.id}`}
                  command={item.command}
                  active={i === palette.activeIndex}
                  onMouseEnter={() => palette.setActiveIndex(i)}
                  onClick={
                    (item.command as { submenu?: string }).submenu
                      ? () => {
                          palette.setFilter((item.command as { submenu?: string }).submenu!)
                          palette.setActiveIndex(0)
                        }
                      : undefined
                  }
                  dim
                />
              ),
            )
          )}
        </div>

        <FooterHints
          mode={palette.mode}
          sentinelConnected={palette.sentinelConnected}
          onPrefixTap={prefix => {
            palette.setFilter(prefix)
            palette.setActiveIndex(0)
            palette.inputRef.current?.focus()
          }}
        />
      </div>
    </div>
  )
}
