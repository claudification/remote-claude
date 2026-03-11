import { cn } from '@/lib/utils'
import type { CommandResultsProps } from './types'

export function CommandResults({ commands, activeIndex, setActiveIndex }: CommandResultsProps) {
  if (commands.length === 0) {
    return <div className="px-3 py-4 text-center text-[10px] text-[#565f89]">No matching commands</div>
  }

  return (
    <>
      {commands.map((cmd, i) => (
        <button
          key={cmd.id}
          type="button"
          onClick={cmd.action}
          onMouseEnter={() => setActiveIndex(i)}
          className={cn(
            'w-full px-3 py-2 flex items-center justify-between text-left transition-colors',
            i === activeIndex ? 'bg-[#33467c]/50' : 'hover:bg-[#33467c]/25',
          )}
        >
          <span className="text-xs text-[#a9b1d6]">{cmd.label}</span>
          {cmd.shortcut && (
            <kbd className="px-1.5 py-0.5 bg-[#33467c]/30 text-[10px] text-[#565f89]">{cmd.shortcut}</kbd>
          )}
        </button>
      ))}
    </>
  )
}
