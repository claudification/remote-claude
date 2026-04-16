/**
 * LaunchMonitor - Shared launch monitoring UI components.
 *
 * Exports:
 *   LaunchStepList    - Step rendering with status icons
 *   LaunchErrorBanner - Error display with copy button
 *   LaunchFooterActions - View Session + Close buttons
 *   LaunchMonitor     - Full modal wrapper (used by ReviveMonitor)
 */

import { Copy, X, Zap } from 'lucide-react'
import { Kbd } from '@/components/ui/kbd'
import type { LaunchStep } from '@/hooks/use-launch-progress'
import { cn } from '@/lib/utils'

// Re-export for backward compat
export type { LaunchStep } from '@/hooks/use-launch-progress'

// ─── Shared sub-components ──────────────────────────────────────

/** Step list with status icons (pulse/check/cross) */
export function LaunchStepList({ steps }: { steps: LaunchStep[] }) {
  return (
    <div className="space-y-2">
      {steps.map((step, i) => (
        <div key={i} className="flex items-start gap-2 font-mono">
          <span className="mt-0.5 w-3 flex-shrink-0 text-center">
            {step.status === 'pending' && <span className="w-2 h-2 rounded-full bg-[#33467c]/50 inline-block" />}
            {step.status === 'active' && (
              <span className="w-2 h-2 rounded-full bg-[#7aa2f7] inline-block animate-pulse" />
            )}
            {step.status === 'done' && <span className="text-[10px] text-emerald-400">&#x2713;</span>}
            {step.status === 'error' && <span className="text-[10px] text-red-400">&#x2717;</span>}
          </span>
          <div className="min-w-0">
            <span
              className={cn(
                'text-[11px]',
                step.status === 'error'
                  ? 'text-red-400'
                  : step.status === 'done'
                    ? 'text-muted-foreground'
                    : 'text-foreground',
              )}
            >
              {step.label}
            </span>
            {step.detail && <span className="text-[10px] text-muted-foreground/60 ml-2">{step.detail}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Error banner with copy-to-clipboard button */
export function LaunchErrorBanner({
  error,
  copied,
  onCopy,
  copyLabel = 'Copy Log',
}: {
  error: string
  copied: boolean
  onCopy: () => void
  copyLabel?: string
}) {
  return (
    <div className="flex items-start justify-between gap-2 bg-red-500/5 border border-red-500/20 px-3 py-2">
      <span className="text-[10px] font-mono text-red-400 break-all">{error}</span>
      <button
        type="button"
        onClick={onCopy}
        className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 text-[9px] font-mono text-red-400 border border-red-500/30 hover:bg-red-500/10 transition-colors"
      >
        <Copy className="w-3 h-3" />
        {copied ? 'Copied' : copyLabel}
      </button>
    </div>
  )
}

/** View Session / Background / Close action buttons */
export function LaunchFooterActions({
  isConnected,
  isComplete,
  hasError,
  viewCountdown,
  onViewSession,
  onClose,
}: {
  isConnected: boolean
  isComplete: boolean
  hasError: boolean
  viewCountdown: number | null
  onViewSession: () => void
  onClose: () => void
}) {
  return (
    <>
      {isConnected && !isComplete && (
        <button
          type="button"
          onClick={onViewSession}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1 text-xs font-bold font-mono',
            'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
            'hover:bg-emerald-500/25 transition-colors',
          )}
        >
          View Session{viewCountdown != null && viewCountdown > 0 ? ` (${viewCountdown}s)` : ''}
          <Kbd className="bg-emerald-500/20 text-emerald-400/70">↵</Kbd>
        </button>
      )}
      {isComplete && (
        <button
          type="button"
          onClick={onViewSession}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1 text-xs font-bold font-mono',
            'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
            'hover:bg-emerald-500/25 transition-colors',
          )}
        >
          View Result
          <Kbd className="bg-emerald-500/20 text-emerald-400/70">↵</Kbd>
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        className="flex items-center gap-1.5 px-3 py-1 text-xs font-mono text-muted-foreground hover:text-foreground"
      >
        {hasError || isConnected || isComplete ? 'Close' : 'Background'}
        <Kbd className="opacity-60">Esc</Kbd>
      </button>
    </>
  )
}

// ─── Full modal wrapper (backward compat for ReviveMonitor) ─────

const ACCENT = {
  amber: { border: 'border-amber-500/30', headerBorder: 'border-amber-500/20', text: 'text-amber-400' },
  teal: { border: 'border-teal-500/30', headerBorder: 'border-teal-500/20', text: 'text-teal-400' },
  emerald: { border: 'border-emerald-500/30', headerBorder: 'border-emerald-500/20', text: 'text-emerald-400' },
  blue: { border: 'border-[#7aa2f7]/30', headerBorder: 'border-[#7aa2f7]/20', text: 'text-[#7aa2f7]' },
} as const

export interface LaunchMonitorProps {
  title: string
  subtitle?: string
  steps: LaunchStep[]
  error?: string | null
  elapsed?: number
  isConnected?: boolean
  isComplete?: boolean
  hasError?: boolean
  viewCountdown?: number | null
  copied?: boolean
  onCopyLog?: () => void
  onViewSession?: () => void
  onClose: () => void
  accentColor?: keyof typeof ACCENT
  children?: React.ReactNode
}

export function LaunchMonitor({
  title,
  subtitle,
  steps,
  error,
  elapsed = 0,
  isConnected = false,
  isComplete = false,
  hasError: hasErrorProp,
  viewCountdown = null,
  copied = false,
  onCopyLog,
  onViewSession,
  onClose,
  accentColor = 'amber',
  children,
}: LaunchMonitorProps) {
  const hasError = hasErrorProp ?? (!!error || steps.some(s => s.status === 'error'))
  const accent = ACCENT[accentColor]

  return (
    // biome-ignore lint/a11y/useSemanticElements: modal backdrop
    <div
      role="button"
      tabIndex={-1}
      aria-label="Close dialog"
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      onClick={onClose}
      onKeyDown={e => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        className={cn('relative w-full max-w-md bg-[#1a1b26] border shadow-2xl', accent.border)}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className={cn('flex items-center gap-2 px-4 py-3 border-b', accent.headerBorder)}>
          <Zap className={cn('w-4 h-4', accent.text)} />
          <span className={cn('text-sm font-mono font-bold', accent.text)}>
            {isComplete ? 'Complete' : hasError ? 'Failed' : title}
          </span>
          {steps.length > 0 && (
            <span className="text-[10px] font-mono text-muted-foreground/60 ml-auto mr-2 tabular-nums">{elapsed}s</span>
          )}
          <button
            type="button"
            onClick={onClose}
            className={cn('text-muted-foreground hover:text-foreground', steps.length === 0 && 'ml-auto')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Subtitle */}
        {subtitle && (
          <div className="px-4 py-3 border-b border-[#33467c]/30">
            <div className="text-xs font-mono text-foreground truncate">{subtitle}</div>
          </div>
        )}

        {/* Children (config form, etc.) */}
        {children}

        {/* Steps */}
        {steps.length > 0 && (
          <div className="px-4 py-3">
            <LaunchStepList steps={steps} />
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="px-4 py-2 border-t border-red-500/20">
            <LaunchErrorBanner error={error} copied={copied} onCopy={onCopyLog || (() => {})} />
          </div>
        )}

        {/* Footer */}
        {steps.length > 0 && (
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[#33467c]/30">
            <LaunchFooterActions
              isConnected={isConnected}
              isComplete={isComplete}
              hasError={hasError}
              viewCountdown={viewCountdown}
              onViewSession={onViewSession || (() => {})}
              onClose={onClose}
            />
          </div>
        )}
      </div>
    </div>
  )
}
