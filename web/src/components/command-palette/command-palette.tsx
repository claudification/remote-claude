import { FileText, FolderPlus } from 'lucide-react'
import { useConversationsStore } from '@/hooks/use-sessions'
import { useKeyLayer } from '@/lib/key-layers'
import { CommandResults, CommandRow } from './command-results'
import { FileResults } from './file-results'
import { FooterHints } from './footer-hints'
import { SessionRow } from './session-results'
import { SpawnResults } from './spawn-results'
import type { CommandPaletteProps } from './types'
import { useCommandPalette } from './use-command-palette'

export function CommandPalette({ onSelect, onFileSelect, onClose }: CommandPaletteProps) {
  const palette = useCommandPalette(onClose)

  useKeyLayer({ Escape: () => onClose() }, { id: 'command-palette' })

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop overlay closes on click
    <div
      role="presentation"
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        className="w-full max-w-lg bg-[#16161e] border border-[#33467c] shadow-2xl font-mono"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="px-3 py-2 border-b border-[#33467c] flex items-center gap-2">
          {palette.mode === 'spawn' && <FolderPlus className="w-4 h-4 text-[#9ece6a] shrink-0" />}
          {palette.mode === 'file' && <FileText className="w-4 h-4 text-[#7aa2f7] shrink-0" />}
          <input
            ref={palette.inputRef}
            type="text"
            value={palette.filter}
            onChange={e => {
              palette.setFilter(e.target.value)
              palette.setActiveIndex(0)
            }}
            onKeyDown={e => palette.handleKeyDown(e, { onSelectSession: onSelect, onFileSelect })}
            placeholder={
              palette.mode === 'command'
                ? 'Type a command...'
                : palette.mode === 'spawn'
                  ? 'Path to spawn (e.g. projects/my-app or /absolute/path)...'
                  : palette.mode === 'file'
                    ? 'Search files...'
                    : palette.mode === 'task'
                      ? 'Search project tasks...'
                      : 'Search sessions + commands... (>cmd  @tasks  F:files  S:spawn)'
            }
            className="w-full bg-transparent text-[19px] sm:text-sm text-[#a9b1d6] placeholder:text-[#565f89] outline-none"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Results */}
        <div className="max-h-[40vh] overflow-y-auto">
          {palette.mode === 'command' ? (
            <CommandResults
              commands={palette.filteredCommands}
              activeIndex={palette.activeIndex}
              setActiveIndex={palette.setActiveIndex}
            />
          ) : palette.mode === 'spawn' ? (
            <SpawnResults
              dirs={palette.filteredSpawnDirs}
              loading={palette.spawnLoading}
              error={palette.spawnError}
              path={palette.spawnPath}
              spawning={palette.spawning}
              sentinelConnected={palette.sentinelConnected}
              canCreateDir={palette.canCreateDir}
              activeIndex={palette.activeIndex}
              setActiveIndex={palette.setActiveIndex}
              onDirSelect={palette.handleDirSelect}
              onSpawn={palette.handleSpawn}
            />
          ) : palette.mode === 'task' ? (
            <div>
              {palette.tasksLoading ? (
                <div className="px-4 py-3 text-[#565f89] text-xs">Loading tasks...</div>
              ) : palette.filteredTasks.length === 0 ? (
                <div className="px-4 py-3 text-[#565f89] text-xs">No matching tasks</div>
              ) : (
                palette.filteredTasks.map((task, i) => (
                  <button
                    key={task.slug}
                    type="button"
                    className={`w-full flex items-center gap-2 px-4 py-2 text-left text-xs transition-colors ${
                      i === palette.activeIndex ? 'bg-[#283457] text-[#c0caf5]' : 'text-[#a9b1d6] hover:bg-[#1a1b26]'
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
                          ? 'bg-[#7aa2f7]/20 text-[#7aa2f7]'
                          : task.status === 'in-progress'
                            ? 'bg-[#e0af68]/20 text-[#e0af68]'
                            : 'bg-[#9ece6a]/20 text-[#9ece6a]'
                      }`}
                    >
                      {task.status}
                    </span>
                    <span className="flex-1 truncate font-mono">{task.title}</span>
                    {task.priority && <span className="text-[9px] text-[#565f89]">{task.priority}</span>}
                  </button>
                ))
              )}
            </div>
          ) : palette.mode === 'file' ? (
            <FileResults
              files={palette.filteredFiles}
              loading={palette.filesLoading}
              selectedSessionId={palette.selectedSessionId}
              activeIndex={palette.activeIndex}
              setActiveIndex={palette.setActiveIndex}
              onFileSelect={onFileSelect}
            />
          ) : palette.mergedItems.length === 0 ? (
            <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">No matches</div>
          ) : (
            palette.mergedItems.map((item, i) =>
              item.kind === 'session' ? (
                <SessionRow
                  key={`s:${item.session.id}`}
                  session={item.session}
                  selectedSessionId={palette.selectedSessionId}
                  projectSettings={palette.projectSettings}
                  active={i === palette.activeIndex}
                  onSelect={() => {
                    const sess = useConversationsStore.getState().sessionsById[item.session.id]
                    if (sess) palette.selectSessionWithTracking(sess, onSelect)
                    else onSelect(item.session.id)
                  }}
                  onMouseEnter={() => palette.setActiveIndex(i)}
                />
              ) : (
                <CommandRow
                  key={`c:${item.command.id}`}
                  command={item.command}
                  active={i === palette.activeIndex}
                  onMouseEnter={() => palette.setActiveIndex(i)}
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
