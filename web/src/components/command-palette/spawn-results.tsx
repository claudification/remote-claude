import { FolderPlus, Server } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SpawnResultsProps } from './types'

export function SpawnResults({
  dirs,
  sentinels,
  isSentinelEntry,
  resolvedSentinel,
  loading,
  error,
  path,
  spawning,
  sentinelConnected,
  canCreateDir,
  activeIndex,
  setActiveIndex,
  onDirSelect,
  onSentinelSelect,
  onSpawn,
}: SpawnResultsProps) {
  if (!sentinelConnected) {
    return <div className="px-3 py-4 text-center text-[10px] text-red-400">No sentinel connected</div>
  }

  // Sentinel autocomplete: user is typing the @<alias> token.
  if (isSentinelEntry) {
    if (sentinels.length === 0) {
      return <div className="px-3 py-4 text-center text-[10px] text-comment">No matching sentinel</div>
    }
    return (
      <>
        {sentinels.map((s, i) => (
          <button
            key={s.alias}
            type="button"
            onClick={() => onSentinelSelect(s.alias)}
            onMouseEnter={() => setActiveIndex(i)}
            className={cn(
              'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
              i === activeIndex ? 'bg-primary/20' : 'hover:bg-primary/10',
            )}
          >
            <Server className={cn('w-3.5 h-3.5 shrink-0', s.connected ? 'text-active' : 'text-comment')} />
            <span className="text-xs text-foreground">@{s.alias}</span>
            {s.isDefault && <span className="text-[9px] text-active uppercase tracking-wide">default</span>}
            {!s.connected && <span className="text-[9px] text-comment">offline</span>}
          </button>
        ))}
      </>
    )
  }

  if (loading) {
    return <div className="px-3 py-4 text-center text-[10px] text-comment">Loading directories...</div>
  }

  if (error) {
    return <div className="px-3 py-4 text-center text-[10px] text-red-400">{error}</div>
  }

  if (!path) {
    return (
      <div className="px-3 py-4 text-center text-[10px] text-comment">
        Type a path (e.g. ~/projects/my-app) -- routing to{' '}
        <span className="text-foreground">@{resolvedSentinel}</span>
      </div>
    )
  }

  return (
    <>
      {dirs.length === 0 && !spawning && !canCreateDir && (
        <div className="px-3 py-4 text-center text-[10px] text-comment">
          {path.endsWith('/') ? 'No subdirectories' : 'No matches'}
        </div>
      )}
      {canCreateDir && !spawning && (
        <button
          type="button"
          onClick={() => onSpawn(path.endsWith('/') ? path.slice(0, -1) : path, true)}
          className="w-full px-3 py-2 flex items-center gap-3 text-left bg-amber-400/10 hover:bg-amber-400/20 transition-colors"
        >
          <FolderPlus className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span className="text-xs">
            <span className="text-amber-400 font-bold">Create</span>{' '}
            <span className="text-foreground">{path.endsWith('/') ? path.slice(0, -1) : path}</span>{' '}
            <span className="text-amber-400 font-bold">& spawn</span>
          </span>
        </button>
      )}
      {dirs.map((dir, i) => (
        <button
          key={dir}
          type="button"
          onClick={() => onDirSelect(dir)}
          onMouseEnter={() => setActiveIndex(i)}
          className={cn(
            'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
            i === activeIndex ? 'bg-primary/20' : 'hover:bg-primary/10',
          )}
        >
          <FolderPlus className="w-3.5 h-3.5 text-active shrink-0" />
          <span className="text-xs text-foreground">{dir}/</span>
        </button>
      ))}
      {path?.endsWith('/') && !spawning && (
        <button
          type="button"
          onClick={() => onSpawn(path.slice(0, -1))}
          className="w-full px-3 py-2 flex items-center gap-3 text-left bg-active/10 hover:bg-active/20 transition-colors border-t border-primary/20"
        >
          <FolderPlus className="w-3.5 h-3.5 text-active shrink-0" />
          <span className="text-xs text-active font-bold">Spawn conversation at {path.slice(0, -1)}</span>
        </button>
      )}
      {spawning && (
        <div className="px-3 py-4 text-center text-[10px] text-active animate-pulse">Spawning conversation...</div>
      )}
    </>
  )
}
