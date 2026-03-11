import { FileText, FolderPlus } from 'lucide-react'
import { CommandResults } from './command-results'
import { FileResults } from './file-results'
import { FooterHints } from './footer-hints'
import { SessionResults } from './session-results'
import { SpawnResults } from './spawn-results'
import type { CommandPaletteProps } from './types'
import { useCommandPalette } from './use-command-palette'

export function CommandPalette({ onSelect, onFileSelect, onClose }: CommandPaletteProps) {
  const palette = useCommandPalette(onClose)

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-[#16161e] border border-[#33467c] shadow-2xl font-mono"
        onClick={e => e.stopPropagation()}
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
                    : 'Switch session... (>cmd  F:files  S:spawn)'
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
              agentConnected={palette.agentConnected}
              activeIndex={palette.activeIndex}
              setActiveIndex={palette.setActiveIndex}
              onDirSelect={palette.handleDirSelect}
              onSpawn={palette.handleSpawn}
            />
          ) : palette.mode === 'file' ? (
            <FileResults
              files={palette.filteredFiles}
              loading={palette.filesLoading}
              selectedSessionId={palette.selectedSessionId}
              activeIndex={palette.activeIndex}
              setActiveIndex={palette.setActiveIndex}
              onFileSelect={onFileSelect}
            />
          ) : (
            <SessionResults
              sessions={palette.sessions}
              selectedSessionId={palette.selectedSessionId}
              projectSettings={palette.projectSettings}
              activeIndex={palette.activeIndex}
              setActiveIndex={palette.setActiveIndex}
              onSelect={onSelect}
            />
          )}
        </div>

        <FooterHints mode={palette.mode} agentConnected={palette.agentConnected} />
      </div>
    </div>
  )
}
