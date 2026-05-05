import type { BuildUpdate } from '@/hooks/use-build-update'
import { clearCacheAndReload } from '@/lib/utils'

interface UpdateBannerProps {
  swUpdate: BuildUpdate
  onDismiss: () => void
}

export function UpdateBanner({ swUpdate, onDismiss }: UpdateBannerProps) {
  return (
    <div className="mb-2 px-3 py-2 bg-cyan-500/10 border border-cyan-500/30 rounded font-mono text-xs text-cyan-400 flex items-center gap-2 shrink-0">
      <span className="font-bold" title="New web app build available">
        WEB UPDATE
      </span>
      <span className="flex-1 truncate">
        {swUpdate.from && swUpdate.to ? `${swUpdate.from} -> ${swUpdate.to}` : 'New web build available'}
      </span>
      <button
        type="button"
        onClick={() => clearCacheAndReload()}
        className="px-2 py-0.5 text-[10px] font-bold bg-cyan-500/20 border border-cyan-500/40 hover:bg-cyan-500/30 transition-colors"
      >
        RELOAD
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="px-2 py-0.5 text-[10px] font-bold text-muted-foreground hover:text-foreground transition-colors"
      >
        LATER
      </button>
    </div>
  )
}
