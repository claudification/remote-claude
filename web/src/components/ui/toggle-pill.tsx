/**
 * TogglePill - Segmented-style pill button. Render a row of these for a
 * segmented control (Mode = Headless / PTY, Permissions = Plan / Accept / ...).
 *
 * Single-button API: `active` + `onClick`. Parent decides selection logic so
 * the component stays dumb.
 */

import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'

interface TogglePillProps {
  active: boolean
  onClick: () => void
  label: string
  icon?: React.ReactNode
  small?: boolean
  shortcut?: string
  title?: string
}

export function TogglePill({ active, onClick, label, icon, small, shortcut, title }: TogglePillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        'rounded font-mono transition-all duration-150 inline-flex items-center gap-1.5',
        small ? 'px-2.5 py-1 text-[11px]' : 'px-4 py-1.5 text-sm',
        'focus:outline-none focus:ring-1 focus:ring-primary/50',
        active
          ? 'bg-primary/20 text-primary border border-primary/40'
          : 'bg-transparent text-comment border border-border hover:text-foreground hover:border-foreground/30',
      )}
    >
      {icon}
      {label}
      {shortcut && <Kbd className="text-[10px]">{shortcut}</Kbd>}
    </button>
  )
}
