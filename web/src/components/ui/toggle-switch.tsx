/**
 * ToggleSwitch - Animated on/off pill. Display-only; parent owns state.
 *
 * Pair with <TileToggleRow> (or your own row) for keyboard-activable toggles.
 */

import { cn } from '@/lib/utils'

export function ToggleSwitch({ on }: { on: boolean }) {
  return (
    <div
      className={cn(
        'w-9 h-5 rounded-full transition-colors duration-150 relative shrink-0',
        on ? 'bg-[#7aa2f7]' : 'bg-[#1a1b26] border border-border',
      )}
    >
      <div
        className={cn(
          'absolute top-0.5 w-4 h-4 rounded-full transition-transform duration-150',
          on ? 'translate-x-4 bg-white' : 'translate-x-0.5 bg-[#565f89]',
        )}
      />
    </div>
  )
}

export default ToggleSwitch
