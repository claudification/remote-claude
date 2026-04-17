/**
 * TileToggleRow - Keyboard-activable row tile wrapping a ToggleSwitch.
 *
 * role=button + tabIndex=0 + Enter/Space onKeyDown makes the whole row a
 * keyboard-navigable target. Pair with the existing base useKeyLayer gate --
 * single-letter shortcuts still skip when text input is focused.
 */

import type React from 'react'
import { ToggleSwitch } from '@/components/ui/toggle-switch'
import { cn, haptic } from '@/lib/utils'

export interface TileToggleRowProps {
  title: string
  subtitle?: string
  checked: boolean
  onToggle: () => void
  disabled?: boolean
  'aria-label'?: string
}

export function TileToggleRow({
  title,
  subtitle,
  checked,
  onToggle,
  disabled,
  'aria-label': ariaLabel,
}: TileToggleRowProps) {
  function handleToggle() {
    if (disabled) return
    onToggle()
    haptic('tap')
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleToggle()
    }
  }

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel || title}
      aria-pressed={checked}
      aria-disabled={disabled || undefined}
      className={cn(
        'flex items-center justify-between py-1.5 px-1 rounded cursor-pointer select-none',
        'focus:outline-none focus:ring-1 focus:ring-[#7aa2f7]/50',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
      onClick={handleToggle}
      onKeyDown={handleKey}
    >
      <div>
        <div className="text-sm font-mono">{title}</div>
        {subtitle && <div className="text-[10px] text-[#565f89]">{subtitle}</div>}
      </div>
      <ToggleSwitch on={checked} />
    </div>
  )
}

export default TileToggleRow
