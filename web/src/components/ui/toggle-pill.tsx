/**
 * TogglePill - Segmented-style pill button. Render a row of these for a
 * segmented control (Mode = Headless / PTY, Permissions = Plan / Accept / ...).
 *
 * Single-button API: `active` + `onClick`. Parent decides selection logic so
 * the component stays dumb.
 */

import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'

export interface TogglePillProps {
  active: boolean
  onClick: () => void
  label: string
  small?: boolean
  shortcut?: string
  title?: string
}

export function TogglePill({ active, onClick, label, small, shortcut, title }: TogglePillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        'rounded font-mono transition-all duration-150 inline-flex items-center gap-1.5',
        small ? 'px-2.5 py-1 text-[11px]' : 'px-4 py-1.5 text-sm',
        'focus:outline-none focus:ring-1 focus:ring-[#7aa2f7]/50',
        active
          ? 'bg-[#7aa2f7]/20 text-[#7aa2f7] border border-[#7aa2f7]/40'
          : 'bg-transparent text-[#565f89] border border-border hover:text-foreground hover:border-foreground/30',
      )}
    >
      {label}
      {shortcut && <Kbd className="text-[10px]">{shortcut}</Kbd>}
    </button>
  )
}

export default TogglePill
