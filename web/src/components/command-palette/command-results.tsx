import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CommandResultsProps, PaletteCommand } from './types'

interface CommandRowProps {
  command: PaletteCommand & { submenu?: string }
  active: boolean
  onMouseEnter: () => void
  onClick?: () => void
  dim?: boolean
}

export function CommandRow({ command, active, onMouseEnter, onClick, dim }: CommandRowProps) {
  const hasSubmenu = !!command.submenu
  return (
    <button
      type="button"
      onClick={onClick || command.action}
      onMouseEnter={onMouseEnter}
      className={cn(
        'w-full px-3 py-2 flex items-center justify-between gap-2 text-left transition-colors',
        active ? 'bg-primary/20' : 'hover:bg-primary/10',
      )}
    >
      <span className="flex items-center gap-2 min-w-0">
        <span
          className={cn(
            'text-[9px] font-bold uppercase shrink-0 px-1 py-0.5',
            dim ? 'bg-primary/10 text-comment' : 'bg-event-prompt/20 text-event-prompt',
          )}
        >
          cmd
        </span>
        <span className={cn('text-xs truncate', dim ? 'text-comment' : 'text-foreground')}>{command.label}</span>
      </span>
      {hasSubmenu ? (
        <ChevronRight className="w-3.5 h-3.5 text-comment shrink-0" />
      ) : (
        (command.shortcuts || (command.shortcut ? [command.shortcut] : [])).length > 0 && (
          <span className="flex items-center gap-1.5 shrink-0">
            {(command.shortcuts || [command.shortcut!]).map(s => (
              <kbd key={s} className="px-1.5 py-0.5 bg-primary/12 text-[10px] text-comment">
                {s}
              </kbd>
            ))}
          </span>
        )
      )}
    </button>
  )
}

export function CommandResults({ commands, activeIndex, setActiveIndex }: CommandResultsProps) {
  if (commands.length === 0) {
    return <div className="px-3 py-4 text-center text-[10px] text-comment">No matching commands</div>
  }

  return (
    <>
      {commands.map((cmd, i) => (
        <CommandRow key={cmd.id} command={cmd} active={i === activeIndex} onMouseEnter={() => setActiveIndex(i)} />
      ))}
    </>
  )
}
