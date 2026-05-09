/**
 * LaunchMonitor - Shared launch monitoring UI primitives used by
 * SpawnDialog and ReviveDialog. Each dialog hosts its own Dialog/phase
 * agent host; this file just exports the pieces they share.
 *
 * Exports:
 *   LaunchStepList      - Step rendering with status icons
 *   LaunchErrorBanner   - Error display with copy button
 *   LaunchFooterActions - View Session + Close buttons
 *   LaunchDialogBottom  - Composed launching steps + error + footer (used by both dialogs)
 */

import { Copy } from 'lucide-react'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
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
        // biome-ignore lint/suspicious/noArrayIndexKey: steps have no stable ID
        <div key={i} className="flex items-start gap-2 font-mono">
          <span className="mt-0.5 w-3 flex-shrink-0 text-center">
            {step.status === 'pending' && <span className="w-2 h-2 rounded-full bg-primary/20 inline-block" />}
            {step.status === 'active' && (
              <span className="w-2 h-2 rounded-full bg-primary inline-block animate-pulse" />
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
  onViewConversation,
  onClose,
}: {
  isConnected: boolean
  isComplete: boolean
  hasError: boolean
  viewCountdown: number | null
  onViewConversation: () => void
  onClose: () => void
}) {
  return (
    <>
      {isConnected && !isComplete && (
        <button
          type="button"
          onClick={onViewConversation}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1 text-xs font-bold font-mono',
            'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
            'hover:bg-emerald-500/25 transition-colors',
          )}
        >
          View Conversation{viewCountdown != null && viewCountdown > 0 ? ` (${viewCountdown}s)` : ''}
          <Kbd className="bg-emerald-500/20 text-emerald-400/70">↵</Kbd>
        </button>
      )}
      {isComplete && (
        <button
          type="button"
          onClick={onViewConversation}
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

/** Composed bottom section shared by SpawnDialog and ReviveDialog:
 *  launching step list + error banner + two-phase footer (config buttons / launch actions). */
export function LaunchDialogBottom({
  phase,
  steps,
  displayError,
  copied,
  onCopyLog,
  onClose,
  onAction,
  actionLabel,
  actionColorClass,
  isConnected,
  isComplete,
  hasError,
  viewCountdown,
  onViewConversation,
}: {
  phase: 'config' | 'launching'
  steps: LaunchStep[]
  displayError: string | null | undefined
  copied: boolean
  onCopyLog: () => void
  onClose: () => void
  onAction: () => void
  actionLabel: string
  actionColorClass: string
  isConnected: boolean
  isComplete: boolean
  hasError: boolean
  viewCountdown: number | null
  onViewConversation: () => void
}) {
  return (
    <>
      {phase === 'launching' && (
        <div className="space-y-3">
          <LaunchStepList steps={steps} />
        </div>
      )}

      {displayError && (
        <div className="shrink-0">
          <LaunchErrorBanner error={displayError} copied={copied} onCopy={onCopyLog} />
        </div>
      )}

      <div className="flex gap-2 pt-1 shrink-0">
        {phase === 'config' && (
          <>
            <button
              type="button"
              onClick={onClose}
              className={cn(
                'flex-1 px-4 py-2 rounded text-sm font-mono',
                'bg-transparent border border-border text-muted-foreground',
                'hover:bg-accent/10 transition-colors',
                'flex items-center justify-center gap-2',
              )}
            >
              Cancel
              <Kbd>Esc</Kbd>
            </button>
            <button
              type="button"
              onClick={onAction}
              className={cn(
                'flex-1 px-4 py-2 rounded text-sm font-mono font-bold',
                actionColorClass,
                'transition-colors',
                'flex items-center justify-center gap-2',
              )}
            >
              {actionLabel}
              <KbdGroup>
                <Kbd className="bg-surface-inset/20 text-surface-inset/70">↵</Kbd>
              </KbdGroup>
            </button>
          </>
        )}
        {phase === 'launching' && (
          <LaunchFooterActions
            isConnected={isConnected}
            isComplete={isComplete}
            hasError={hasError}
            viewCountdown={viewCountdown}
            onViewConversation={onViewConversation}
            onClose={onClose}
          />
        )}
      </div>
    </>
  )
}
