import { FolderPlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SpawnResultsProps } from './types'

export function SpawnResults({
  dirs,
  loading,
  error,
  path,
  spawning,
  agentConnected,
  activeIndex,
  setActiveIndex,
  onDirSelect,
  onSpawn,
}: SpawnResultsProps) {
  if (!agentConnected) {
    return <div className="px-3 py-4 text-center text-[10px] text-red-400">No host agent connected</div>
  }

  if (loading) {
    return <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">Loading directories...</div>
  }

  if (error) {
    return <div className="px-3 py-4 text-center text-[10px] text-red-400">{error}</div>
  }

  if (!path) {
    return <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">Type a path (e.g. ~/projects/my-app)</div>
  }

  return (
    <>
      {dirs.length === 0 && !spawning && (
        <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">
          {path.endsWith('/') ? 'No subdirectories' : 'No matches'}
        </div>
      )}
      {dirs.map((dir, i) => (
        <button
          key={dir}
          type="button"
          onClick={() => onDirSelect(dir)}
          onMouseEnter={() => setActiveIndex(i)}
          className={cn(
            'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
            i === activeIndex ? 'bg-[#33467c]/50' : 'hover:bg-[#33467c]/25',
          )}
        >
          <FolderPlus className="w-3.5 h-3.5 text-[#9ece6a] shrink-0" />
          <span className="text-xs text-[#a9b1d6]">{dir}/</span>
        </button>
      ))}
      {path && path.endsWith('/') && !spawning && (
        <button
          type="button"
          onClick={() => onSpawn(path.slice(0, -1))}
          className="w-full px-3 py-2 flex items-center gap-3 text-left bg-[#9ece6a]/10 hover:bg-[#9ece6a]/20 transition-colors border-t border-[#33467c]/50"
        >
          <FolderPlus className="w-3.5 h-3.5 text-[#9ece6a] shrink-0" />
          <span className="text-xs text-[#9ece6a] font-bold">Spawn session at {path.slice(0, -1)}</span>
        </button>
      )}
      {spawning && (
        <div className="px-3 py-4 text-center text-[10px] text-[#9ece6a] animate-pulse">Spawning session...</div>
      )}
    </>
  )
}
