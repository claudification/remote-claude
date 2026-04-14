/**
 * LaunchMonitor - Unified pipeline progress modal for spawn and revive operations.
 * Shows step-by-step progress, handles timeouts, captures errors with copy-to-clipboard.
 */

import { Copy, X, Zap } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { useKeyLayer } from '@/lib/key-layers'
import { cn, haptic } from '@/lib/utils'

export type LaunchStep = {
  label: string
  status: 'pending' | 'active' | 'done' | 'error'
  detail?: string
  ts?: number
}

export interface LaunchMonitorProps {
  /** Dialog title - "Run Task" or "Revive Session" */
  title: string
  /** Subtitle - task name or session name */
  subtitle?: string
  /** Wrapper ID to track for session connection */
  wrapperId: string | null
  /** Externally managed steps */
  steps: LaunchStep[]
  /** Error message */
  error?: string | null
  /** Full structured error log for clipboard */
  errorLog?: string | null
  /** Timeout in ms (default 30000) */
  timeoutMs?: number
  /** Called when timeout fires */
  onTimeout?: () => void
  /** Close the modal */
  onClose: () => void
  /** Optional: extra header icon color */
  accentColor?: 'amber' | 'teal' | 'emerald'
  /** Children rendered below steps (e.g. config form) */
  children?: React.ReactNode
}

function stepIcon(status: LaunchStep['status']) {
  switch (status) {
    case 'pending':
      return <span className="w-2 h-2 rounded-full bg-[#33467c]/50 inline-block" />
    case 'active':
      return <span className="w-2 h-2 rounded-full bg-amber-400 inline-block animate-pulse" />
    case 'done':
      return <span className="text-[10px] text-emerald-400">&#x2713;</span>
    case 'error':
      return <span className="text-[10px] text-red-400">&#x2717;</span>
  }
}

export function LaunchMonitor({
  title,
  subtitle,
  wrapperId,
  steps,
  error,
  errorLog,
  timeoutMs = 30000,
  onTimeout,
  onClose,
  accentColor = 'amber',
  children,
}: LaunchMonitorProps) {
  const startTimeRef = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)
  const [copied, setCopied] = useState(false)

  useKeyLayer({ Escape: onClose })

  // Track the spawned session by wrapperId
  const spawnedSession = useSessionsStore(
    useCallback(
      state => {
        if (!wrapperId) return null
        return state.sessions.find(s => s.wrapperIds?.includes(wrapperId)) || null
      },
      [wrapperId],
    ),
  )

  // Elapsed timer
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // Timeout watchdog
  useEffect(() => {
    if (!wrapperId || !onTimeout) return
    const hasError = steps.some(s => s.status === 'error')
    const isDone = spawnedSession?.status === 'ended'
    if (hasError || isDone) return

    const timer = setInterval(() => {
      const el = Date.now() - startTimeRef.current
      if (el > timeoutMs && !spawnedSession) {
        onTimeout()
        clearInterval(timer)
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [wrapperId, onTimeout, timeoutMs, spawnedSession, steps])

  const isComplete = spawnedSession?.status === 'ended'
  const isRunning = spawnedSession && !isComplete
  const hasError = error || steps.some(s => s.status === 'error')

  function handleViewSession() {
    if (spawnedSession) {
      useSessionsStore.getState().selectSession(spawnedSession.id)
      onClose()
    }
  }

  async function handleCopyLog() {
    const log = buildErrorLog()
    try {
      await navigator.clipboard.writeText(log)
      setCopied(true)
      haptic('success')
      globalThis.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: select a textarea
      const ta = document.createElement('textarea')
      ta.value = log
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      setCopied(true)
      haptic('success')
      globalThis.setTimeout(() => setCopied(false), 2000)
    }
  }

  function buildErrorLog(): string {
    if (errorLog) return errorLog

    const lines = [
      '=== rclaude launch log ===',
      `Time: ${new Date().toISOString()}`,
      `Title: ${title}`,
      subtitle ? `Subtitle: ${subtitle}` : null,
      wrapperId ? `Wrapper: ${wrapperId}` : null,
      spawnedSession ? `Session: ${spawnedSession.id}` : null,
      '',
      'Steps:',
      ...steps.map(s => {
        const icon =
          s.status === 'done' ? '[OK]' : s.status === 'error' ? '[FAIL]' : s.status === 'active' ? '[...]' : '[ ]'
        return `  ${icon} ${s.label}${s.detail ? ` -- ${s.detail}` : ''}`
      }),
    ].filter(l => l !== null) as string[]

    if (error) {
      lines.push('', `Error: ${error}`)
    }

    lines.push('', `Elapsed: ${elapsed}s`)
    return lines.join('\n')
  }

  const accentBorder =
    accentColor === 'teal'
      ? 'border-teal-500/30'
      : accentColor === 'emerald'
        ? 'border-emerald-500/30'
        : 'border-amber-500/30'
  const accentBg =
    accentColor === 'teal'
      ? 'border-teal-500/20'
      : accentColor === 'emerald'
        ? 'border-emerald-500/20'
        : 'border-amber-500/20'
  const accentText =
    accentColor === 'teal' ? 'text-teal-400' : accentColor === 'emerald' ? 'text-emerald-400' : 'text-amber-400'

  return (
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
        className={cn('relative w-full max-w-md bg-[#1a1b26] border shadow-2xl', accentBorder)}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className={cn('flex items-center gap-2 px-4 py-3 border-b', accentBg)}>
          <Zap className={cn('w-4 h-4', accentText)} />
          <span className={cn('text-sm font-mono font-bold', accentText)}>
            {isComplete ? 'Complete' : hasError ? 'Failed' : title}
          </span>
          {steps.length > 0 && (
            <span className="text-[10px] font-mono text-muted-foreground/60 ml-auto mr-2">{elapsed}s</span>
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
          <div className="px-4 py-3 space-y-2">
            {steps.map((step, i) => (
              <div key={i} className="flex items-start gap-2 font-mono">
                <span className="mt-0.5 w-3 flex-shrink-0 text-center">{stepIcon(step.status)}</span>
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
        )}

        {/* Error banner with copy button */}
        {error && (
          <div className="px-4 py-2 border-t border-red-500/20 bg-red-500/5">
            <div className="flex items-start justify-between gap-2">
              <span className="text-[10px] font-mono text-red-400 break-all">{error}</span>
              <button
                type="button"
                onClick={handleCopyLog}
                className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 text-[9px] font-mono text-red-400 border border-red-500/30 hover:bg-red-500/10 transition-colors"
                title="Copy full error log to clipboard"
              >
                <Copy className="w-3 h-3" />
                {copied ? 'Copied' : 'Copy Log'}
              </button>
            </div>
          </div>
        )}

        {/* Footer actions */}
        {steps.length > 0 && (
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[#33467c]/30">
            {isRunning && (
              <button
                type="button"
                onClick={handleViewSession}
                className="flex items-center gap-1.5 px-3 py-1 text-xs font-bold font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
              >
                View Session
              </button>
            )}
            {isComplete && (
              <button
                type="button"
                onClick={handleViewSession}
                className="flex items-center gap-1.5 px-3 py-1 text-xs font-bold font-mono bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
              >
                View Result
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1 text-xs font-mono text-muted-foreground hover:text-foreground"
            >
              {isComplete || hasError ? 'Close' : 'Background'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
