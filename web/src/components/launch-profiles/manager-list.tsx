import type { LaunchProfile } from '@shared/launch-profile'
import { Plus } from 'lucide-react'
import { formatShortcut } from '@/lib/commands'
import { cn } from '@/lib/utils'

interface Props {
  profiles: LaunchProfile[]
  selectedId: string | undefined
  onSelect: (id: string) => void
  onCreate: () => void
}

export function ManagerList({ profiles, selectedId, onSelect, onCreate }: Props) {
  return (
    <div className="flex flex-col gap-1 p-2 border-r border-border min-w-[200px] max-w-[260px]">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground px-2 pt-1 pb-2">Profiles</div>
      <div className="flex-1 overflow-y-auto flex flex-col gap-1">
        {profiles.length === 0 ? (
          <div className="text-xs text-muted-foreground px-2 py-3">No profiles yet.</div>
        ) : (
          profiles.map(p => (
            <ListRow key={p.id} profile={p} selected={p.id === selectedId} onClick={() => onSelect(p.id)} />
          ))
        )}
      </div>
      <button
        type="button"
        onClick={onCreate}
        className="flex items-center gap-2 px-2 py-1.5 text-xs text-primary hover:bg-muted/40 transition-colors"
      >
        <Plus className="h-3.5 w-3.5" />
        <span>New profile</span>
      </button>
    </div>
  )
}

function ListRow({ profile, selected, onClick }: { profile: LaunchProfile; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center justify-between gap-2 text-left px-2 py-1.5 text-xs font-mono transition-colors',
        selected ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/40',
      )}
    >
      <span className="truncate">{profile.name || '(unnamed)'}</span>
      {profile.chord && (
        <span className="text-[10px] text-muted-foreground/70 shrink-0">{formatShortcut(`mod+j ${profile.chord}`)}</span>
      )}
    </button>
  )
}
