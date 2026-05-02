import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type BannerAccent = 'teal' | 'amber' | 'cyan' | 'violet' | 'emerald' | 'red' | 'blue' | 'muted'

const ACCENT_CARD: Record<BannerAccent, string> = {
  teal: 'bg-teal-500/10 border-teal-500/30',
  amber: 'bg-amber-500/10 border-amber-500/30',
  cyan: 'bg-cyan-500/10 border-cyan-500/30',
  violet: 'bg-violet-500/10 border-violet-400/40',
  emerald: 'bg-emerald-500/10 border-emerald-500/30',
  red: 'bg-red-500/10 border-red-500/30',
  blue: 'bg-blue-500/10 border-blue-500/30',
  muted: 'bg-muted/20 border-border/30',
}

const ACCENT_LABEL: Record<BannerAccent, string> = {
  teal: 'text-teal-400',
  amber: 'text-amber-400',
  cyan: 'text-cyan-400',
  violet: 'text-violet-400',
  emerald: 'text-emerald-400',
  red: 'text-red-400',
  blue: 'text-blue-400',
  muted: 'text-muted-foreground',
}

const ACCENT_BUTTON: Record<BannerAccent, string> = {
  teal: 'bg-teal-500/20 text-teal-400 border-teal-500/40 hover:bg-teal-500/30',
  amber: 'bg-amber-500/20 text-amber-400 border-amber-500/40 hover:bg-amber-500/30',
  cyan: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/40 hover:bg-cyan-500/30',
  violet: 'bg-violet-500/20 text-violet-400 border-violet-500/40 hover:bg-violet-500/30',
  emerald: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40 hover:bg-emerald-500/30',
  red: 'bg-red-500/20 text-red-400 border-red-500/40 hover:bg-red-500/30',
  blue: 'bg-blue-500/20 text-blue-400 border-blue-500/40 hover:bg-blue-500/30',
  muted: 'bg-muted/20 text-muted-foreground border-border/30 hover:bg-muted/30',
}

interface ConversationBannerProps {
  accent: BannerAccent
  label: string
  title?: ReactNode
  meta?: ReactNode
  children?: ReactNode
  actions?: ReactNode
  /** Layout of header + body: 'row' (default, single-line head) or 'stack' (head then body stacked). */
  layout?: 'row' | 'stack'
  className?: string
}

export function ConversationBanner({
  accent,
  label,
  title,
  meta,
  children,
  actions,
  layout = 'stack',
  className,
}: ConversationBannerProps) {
  if (layout === 'row') {
    return (
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 rounded border font-mono text-xs',
          ACCENT_CARD[accent],
          className,
        )}
      >
        <span className={cn('font-bold shrink-0', ACCENT_LABEL[accent])}>{label}</span>
        {title && <span className="text-foreground/80 flex-1 truncate">{title}</span>}
        {meta && <span className="text-muted-foreground text-[10px]">{meta}</span>}
        {actions}
      </div>
    )
  }
  return (
    <div
      className={cn('flex flex-col gap-1.5 px-3 py-2 rounded border font-mono text-xs', ACCENT_CARD[accent], className)}
    >
      <div className="flex items-center gap-2">
        <span className={cn('font-bold shrink-0', ACCENT_LABEL[accent])}>{label}</span>
        {title && <span className="text-foreground truncate">{title}</span>}
        {meta && <span className="text-muted-foreground text-[10px] ml-auto">{meta}</span>}
      </div>
      {children}
      {actions && <div className="flex items-center gap-2 mt-0.5">{actions}</div>}
    </div>
  )
}

interface BannerButtonProps {
  accent: BannerAccent
  label: string
  onClick: () => void
  disabled?: boolean
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const BUTTON_SIZE: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'px-2 py-0.5 text-[10px]',
  md: 'px-3 py-1 text-[11px]',
  lg: 'px-3 py-2 text-[11px] touch-manipulation',
}

export function BannerButton({ accent, label, onClick, disabled, size = 'md', className }: BannerButtonProps) {
  const accentClasses = disabled
    ? 'bg-muted/20 text-muted-foreground border-border/30 cursor-not-allowed'
    : ACCENT_BUTTON[accent]
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn('font-bold border transition-colors', BUTTON_SIZE[size], accentClasses, className)}
    >
      {label}
    </button>
  )
}

/**
 * Wrapper for a list of banners -- consistent outer container across all banner types.
 * Renders nothing when `items` is empty.
 */
export function BannerStack<T>({
  items,
  render,
  gap = 'tight',
  className,
}: {
  items: T[]
  render: (item: T) => ReactNode
  gap?: 'tight' | 'loose'
  className?: string
}) {
  if (items.length === 0) return null
  return (
    <div className={cn('shrink-0 p-2', gap === 'tight' ? 'space-y-1' : 'space-y-2', className)}>
      {items.map(render)}
    </div>
  )
}
