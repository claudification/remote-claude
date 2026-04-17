/**
 * LaunchMonitor - Shared launch monitoring UI primitives used by
 * SpawnDialog and ReviveDialog. Each dialog hosts its own Dialog/phase
 * wrapper; this file just exports the pieces they share.
 *
 * Exports:
 *   LaunchStepList    - Step rendering with status icons
 *   LaunchErrorBanner - Error display with copy button
 *   LaunchFooterActions - View Session + Close buttons
 */

import { Copy } from 'lucide-react'
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
