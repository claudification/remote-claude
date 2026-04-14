/**
 * Spawn Dialog - Pre-spawn configuration + launch monitor
 *
 * Phase 1 (config): Configure model, effort, mode, etc.
 * Phase 2 (launching): Step-by-step progress via launch job channel.
 */

import { ChevronDown, Copy, Zap } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useLaunchChannel } from '@/hooks/use-launch-channel'
import { useSessionsStore } from '@/hooks/use-sessions'
import { cn, haptic } from '@/lib/utils'

export interface SpawnDialogOptions {
  cwd: string
  mkdir?: boolean
}

interface SpawnDialogState {
  open: boolean
  options: SpawnDialogOptions | null
}

const MODEL_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

const EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

const PERMISSION_MODES = [
  { value: '', label: 'Default' },
  { value: 'plan', label: 'Plan' },
  { value: 'acceptEdits', label: 'Accept Edits' },
  { value: 'auto', label: 'Auto' },
  { value: 'bypassPermissions', label: 'Bypass' },
]

// Module-level state so any component can trigger the dialog
let _openDialog: ((options: SpawnDialogOptions) => void) | null = null

/** Open the spawn dialog from anywhere */
export function openSpawnDialog(options: SpawnDialogOptions): void {
  _openDialog?.(options)
}

export function SpawnDialog() {
  const [state, setState] = useState<SpawnDialogState>({ open: false, options: null })
  const [headless, setHeadless] = useState(true)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [bare, setBare] = useState(false)
  const [name, setName] = useState('')
  const [permissionMode, setPermissionMode] = useState('')
  const [autocompactPct, setAutocompactPct] = useState<number | ''>('')
  const [maxBudgetUsd, setMaxBudgetUsd] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [phase, setPhase] = useState<'config' | 'launching'>('config')
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [wrapperId, setWrapperId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const startTimeRef = useRef(0)
  const [elapsed, setElapsed] = useState(0)

  const projectSettings = useSessionsStore(s => s.projectSettings)
  const globalSettings = useSessionsStore(s => s.globalSettings)

  // Launch channel - streams job events from agent
  const launch = useLaunchChannel(jobId)

  // Track the spawned session by wrapperId (fallback if job_complete doesn't fire)
  const spawnedSession = useSessionsStore(
    useCallback(
      state => {
        const wid = launch.wrapperId || wrapperId
        if (!wid) return null
        return state.sessions.find(s => s.wrapperIds?.includes(wid)) || null
      },
      [launch.wrapperId, wrapperId],
    ),
  )

  // Elapsed timer for launch phase
  useEffect(() => {
    if (phase !== 'launching') return
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [phase])

  // Register the open callback
  useEffect(() => {
    _openDialog = (options: SpawnDialogOptions) => {
      const projSettings = projectSettings[options.cwd]
      const defaultMode = projSettings?.defaultLaunchMode || (globalSettings.defaultLaunchMode as string) || 'headless'
      setHeadless(defaultMode !== 'pty')
      setModel('')
      setEffort('')
      setBare(false)
      setName('')
      setPermissionMode('')
      setAutocompactPct('')
      setMaxBudgetUsd('')
      setShowAdvanced(false)
      setError(null)
      setPhase('config')
      setJobId(null)
      setWrapperId(null)
      setElapsed(0)
      setCopied(false)
      setState({ open: true, options })
    }
    return () => {
      _openDialog = null
    }
  }, [projectSettings, globalSettings])

  // Focus name input when dialog opens in config phase
  useEffect(() => {
    if (state.open && phase === 'config') {
      setTimeout(() => nameRef.current?.focus(), 100)
    }
  }, [state.open, phase])

  // Timeout watchdog
  useEffect(() => {
    if (phase !== 'launching' || !startTimeRef.current) return
    const timer = setInterval(() => {
      const el = Date.now() - startTimeRef.current
      if (el > 60_000 && !spawnedSession && !launch.completed && !launch.failed) {
        setError('Session failed to connect within 60s')
        clearInterval(timer)
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [phase, spawnedSession, launch.completed, launch.failed])

  const handleClose = useCallback(() => {
    // If session connected, auto-select it
    if (launch.sessionId) {
      useSessionsStore.getState().selectSession(launch.sessionId)
    } else if (spawnedSession && spawnedSession.status !== 'ended') {
      useSessionsStore.getState().selectSession(spawnedSession.id)
    }
    setState({ open: false, options: null })
    setJobId(null)
  }, [launch.sessionId, spawnedSession])

  const handleSpawn = useCallback(async () => {
    if (!state.options || phase !== 'config') return
    setPhase('launching')
    setError(null)
    startTimeRef.current = Date.now()
    haptic('tap')

    // Generate jobId and subscribe BEFORE making the HTTP request
    const newJobId = crypto.randomUUID()
    setJobId(newJobId)

    try {
      const res = await fetch('/api/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: state.options.cwd,
          mkdir: state.options.mkdir || false,
          headless,
          bare: bare || undefined,
          name: name.trim() || undefined,
          model: model || undefined,
          effort: effort || undefined,
          permissionMode: permissionMode || undefined,
          autocompactPct: autocompactPct || undefined,
          maxBudgetUsd: maxBudgetUsd ? Number(maxBudgetUsd) : undefined,
          jobId: newJobId,
        }),
      })
      const data = await res.json()
      if (data.success) {
        haptic('success')
        setWrapperId(data.wrapperId)
      } else {
        setError(data.error || 'Spawn failed')
        haptic('error')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Network error')
      haptic('error')
    }
  }, [state.options, phase, headless, bare, name, model, effort, permissionMode, autocompactPct, maxBudgetUsd])

  // Handle Enter key to submit
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && phase === 'config') {
        e.preventDefault()
        handleSpawn()
      }
    },
    [handleSpawn, phase],
  )

  async function handleCopyLog() {
    const log = {
      type: 'spawn_log',
      time: new Date().toISOString(),
      cwd: state.options?.cwd,
      jobId,
      wrapperId: wrapperId || launch.wrapperId || null,
      sessionId: launch.sessionId || null,
      elapsed: `${elapsed}s`,
      error: error || launch.error || null,
      events: launch.events.map(e => ({
        status: e.status,
        step: e.step,
        detail: e.detail || null,
        t: e.t,
      })),
      config: {
        headless,
        bare,
        name: name || null,
        model: model || null,
        effort: effort || null,
        permissionMode: permissionMode || null,
      },
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(log, null, 2))
      setCopied(true)
      haptic('success')
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  const shortPath = state.options?.cwd?.replace(/^\/Users\/[^/]+/, '~') || ''
  const projSettings = state.options ? projectSettings[state.options.cwd] : undefined
  const defaultModel = projSettings?.defaultModel || (globalSettings.defaultModel as string) || 'opus'
  const defaultEffort = projSettings?.defaultEffort || (globalSettings.defaultEffort as string) || 'default'

  const isSessionConnected = launch.completed || (spawnedSession && spawnedSession.status !== 'ended')
  const hasError = error || launch.failed

  return (
    <Dialog open={state.open} onOpenChange={open => !open && handleClose()}>
      <DialogContent className="max-w-md rounded-lg" onKeyDown={handleKeyDown}>
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-sm font-bold font-mono flex items-center gap-2">
              {phase === 'launching' && <Zap className="w-4 h-4 text-[#7aa2f7]" />}
              {phase === 'config'
                ? 'SPAWN SESSION'
                : isSessionConnected
                  ? 'SESSION CONNECTED'
                  : hasError
                    ? 'SPAWN FAILED'
                    : 'LAUNCHING...'}
            </DialogTitle>
            {phase === 'launching' && (
              <span className="text-[10px] font-mono text-muted-foreground/60 tabular-nums">{elapsed}s</span>
            )}
          </div>

          {/* CWD display */}
          <div className="text-[11px] font-mono text-muted-foreground truncate">{shortPath}</div>

          {/* ── Config Phase ── */}
          {phase === 'config' && (
            <>
              {/* Name input */}
              <div className="space-y-1.5">
                <label
                  htmlFor="spawn-name"
                  className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide"
                >
                  Name <span className="text-[#565f89]">(optional)</span>
                </label>
                <input
                  ref={nameRef}
                  id="spawn-name"
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. refactor-auth"
                  className={cn(
                    'w-full bg-[#1a1b26] border border-border rounded px-3 py-1.5',
                    'text-sm font-mono text-foreground placeholder:text-[#565f89]',
                    'focus:outline-none focus:border-[#7aa2f7]/50',
                  )}
                />
              </div>

              {/* Mode toggle */}
              <div className="space-y-2">
                <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide">Mode</div>
                <div className="flex gap-2">
                  <TogglePill
                    active={headless}
                    onClick={() => {
                      setHeadless(true)
                      haptic('tap')
                    }}
                    label="Headless"
                  />
                  <TogglePill
                    active={!headless}
                    onClick={() => {
                      setHeadless(false)
                      haptic('tap')
                    }}
                    label="PTY"
                  />
                </div>
              </div>

              {/* Model selector */}
              <div className="space-y-2">
                <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide">Model</div>
                <div className="flex gap-1.5 flex-wrap">
                  {MODEL_OPTIONS.map(opt => (
                    <TogglePill
                      key={opt.value}
                      active={model === opt.value}
                      onClick={() => {
                        setModel(opt.value)
                        haptic('tap')
                      }}
                      label={opt.value === '' ? `Default (${defaultModel})` : opt.label}
                    />
                  ))}
                </div>
              </div>

              {/* Effort selector */}
              <div className="space-y-2">
                <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide">Effort</div>
                <div className="flex gap-1.5 flex-wrap">
                  {EFFORT_OPTIONS.map(opt => (
                    <TogglePill
                      key={opt.value}
                      active={effort === opt.value}
                      onClick={() => {
                        setEffort(opt.value)
                        haptic('tap')
                      }}
                      label={opt.value === '' ? `Default (${defaultEffort})` : opt.label}
                    />
                  ))}
                </div>
              </div>

              {/* Advanced toggle */}
              <button
                type="button"
                className="flex items-center gap-1.5 text-[11px] font-mono text-[#565f89] hover:text-muted-foreground transition-colors"
                onClick={() => {
                  setShowAdvanced(!showAdvanced)
                  haptic('tick')
                }}
              >
                <ChevronDown
                  className={cn('w-3 h-3 transition-transform duration-150', showAdvanced && 'rotate-180')}
                />
                Advanced
              </button>

              {showAdvanced && (
                <div className="space-y-3 pl-1 border-l-2 border-border/50 ml-1">
                  {/* Permission mode */}
                  <div className="space-y-2 pl-3">
                    <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide">
                      Permission mode
                    </div>
                    <div className="flex gap-1.5 flex-wrap">
                      {PERMISSION_MODES.map(opt => (
                        <TogglePill
                          key={opt.value}
                          active={permissionMode === opt.value}
                          onClick={() => {
                            setPermissionMode(opt.value)
                            haptic('tap')
                          }}
                          label={opt.label}
                          small
                        />
                      ))}
                    </div>
                  </div>

                  {/* Autocompact threshold */}
                  <div className="space-y-2 pl-3">
                    <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide">
                      Autocompact threshold
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={50}
                        max={99}
                        value={autocompactPct || 83}
                        onChange={e => {
                          setAutocompactPct(Number(e.target.value))
                          haptic('tick')
                        }}
                        className="flex-1 h-1.5 accent-[#7aa2f7] bg-muted rounded-full"
                      />
                      <span
                        className={cn(
                          'text-sm font-mono w-12 text-right tabular-nums',
                          autocompactPct ? 'text-[#7aa2f7]' : 'text-[#565f89]',
                        )}
                      >
                        {autocompactPct || 83}%
                      </span>
                      {autocompactPct && (
                        <button
                          type="button"
                          onClick={() => {
                            setAutocompactPct('')
                            haptic('tap')
                          }}
                          className="text-[10px] text-[#565f89] hover:text-foreground font-mono"
                        >
                          reset
                        </button>
                      )}
                    </div>
                    <div className="text-[9px] text-[#565f89]">Context % that triggers compaction (default ~83%)</div>
                  </div>

                  {/* Max budget (headless only) */}
                  {headless && (
                    <div className="space-y-2 pl-3">
                      <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide">
                        Max budget (USD)
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[#565f89] text-sm">$</span>
                        <input
                          type="number"
                          min={0.01}
                          step={0.01}
                          placeholder="no limit"
                          value={maxBudgetUsd}
                          onChange={e => setMaxBudgetUsd(e.target.value)}
                          className="w-24 bg-[#1a1b26] border border-[#292e42] rounded px-2 py-1 text-sm font-mono text-foreground focus:outline-none focus:border-[#7aa2f7] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        {maxBudgetUsd && (
                          <button
                            type="button"
                            onClick={() => setMaxBudgetUsd('')}
                            className="text-[10px] text-[#565f89] hover:text-foreground font-mono"
                          >
                            clear
                          </button>
                        )}
                      </div>
                      <div className="text-[9px] text-[#565f89]">
                        Stop session after spending this amount (--max-budget-usd, headless only)
                      </div>
                    </div>
                  )}

                  {/* Bare toggle */}
                  <div
                    role="button"
                    tabIndex={0}
                    className="flex items-center justify-between py-1.5 pl-3 cursor-pointer select-none"
                    onClick={() => {
                      setBare(!bare)
                      haptic('tap')
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        setBare(!bare)
                        haptic('tap')
                      }
                    }}
                  >
                    <div>
                      <div className="text-sm font-mono">Bare session</div>
                      <div className="text-[10px] text-[#565f89]">Skip hooks, plugins, CLAUDE.md, auto-memory</div>
                    </div>
                    <ToggleSwitch on={bare} />
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Launching Phase ── */}
          {phase === 'launching' && (
            <div className="space-y-3">
              {/* Built-in steps */}
              <StepLine
                status={wrapperId ? 'done' : error && !wrapperId ? 'error' : 'active'}
                label="Sending spawn request"
                detail={wrapperId ? `wrapper=${wrapperId.slice(0, 8)}` : undefined}
              />

              {/* Agent events from launch channel */}
              {launch.events.map((evt, i) => {
                // info = "in progress" step. Active only if it's the last event overall
                // (any subsequent event -- info or ok -- means this step is past)
                const isCurrentStep = evt.status === 'info' && i === launch.events.length - 1
                const stepStatus =
                  evt.status === 'ok'
                    ? 'done'
                    : evt.status === 'error'
                      ? 'error'
                      : isCurrentStep && !isSessionConnected
                        ? 'active'
                        : 'done'
                return <StepLine key={i} status={stepStatus} label={evt.step} detail={evt.detail} />
              })}

              {/* Session connection step */}
              {wrapperId && !launch.failed && (
                <StepLine
                  status={isSessionConnected ? 'done' : hasError ? 'error' : 'active'}
                  label={isSessionConnected ? 'Session connected' : 'Waiting for session...'}
                  detail={
                    launch.sessionId
                      ? launch.sessionId.slice(0, 8)
                      : spawnedSession
                        ? spawnedSession.id.slice(0, 8)
                        : undefined
                  }
                />
              )}
            </div>
          )}

          {/* Error banner with copy */}
          {(error || launch.error) && (
            <div className="flex items-start justify-between gap-2 bg-red-500/5 border border-red-500/20 px-3 py-2">
              <span className="text-[10px] font-mono text-red-400 break-all">{error || launch.error}</span>
              <button
                type="button"
                onClick={handleCopyLog}
                className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 text-[9px] font-mono text-red-400 border border-red-500/30 hover:bg-red-500/10 transition-colors"
              >
                <Copy className="w-3 h-3" />
                {copied ? 'Copied' : 'Copy Log'}
              </button>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            {phase === 'config' && (
              <>
                <button
                  type="button"
                  onClick={handleClose}
                  className={cn(
                    'flex-1 px-4 py-2 rounded text-sm font-mono',
                    'bg-transparent border border-border text-muted-foreground',
                    'hover:bg-accent/10 transition-colors',
                  )}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSpawn}
                  className={cn(
                    'flex-1 px-4 py-2 rounded text-sm font-mono font-bold',
                    'bg-[#7aa2f7] text-[#1a1b26] hover:bg-[#7aa2f7]/90',
                    'transition-colors',
                  )}
                >
                  Spawn
                </button>
              </>
            )}
            {phase === 'launching' && (
              <>
                {isSessionConnected && (
                  <button
                    type="button"
                    onClick={() => {
                      const sid = launch.sessionId || spawnedSession?.id
                      if (sid) useSessionsStore.getState().selectSession(sid)
                      handleClose()
                    }}
                    className={cn(
                      'flex-1 px-4 py-2 rounded text-sm font-mono font-bold',
                      'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
                      'hover:bg-emerald-500/25 transition-colors',
                    )}
                  >
                    View Session
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleClose}
                  className={cn(
                    'flex-1 px-4 py-2 rounded text-sm font-mono',
                    'bg-transparent border border-border text-muted-foreground',
                    'hover:bg-accent/10 transition-colors',
                  )}
                >
                  {hasError || isSessionConnected ? 'Close' : 'Background'}
                </button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Sub-components ──────────────────────────────────────────────

function StepLine({
  status,
  label,
  detail,
}: {
  status: 'active' | 'done' | 'error' | 'info'
  label: string
  detail?: string
}) {
  return (
    <div className="flex items-start gap-2 font-mono">
      <span className="mt-0.5 w-3 flex-shrink-0 text-center">
        {status === 'active' && <span className="w-2 h-2 rounded-full bg-[#7aa2f7] inline-block animate-pulse" />}
        {status === 'done' && <span className="text-[10px] text-emerald-400">&#x2713;</span>}
        {status === 'error' && <span className="text-[10px] text-red-400">&#x2717;</span>}
        {status === 'info' && <span className="w-1.5 h-1.5 rounded-full bg-[#565f89] inline-block" />}
      </span>
      <div className="min-w-0">
        <span
          className={cn(
            'text-[11px]',
            status === 'error' ? 'text-red-400' : status === 'done' ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {label}
        </span>
        {detail && <span className="text-[10px] text-muted-foreground/60 ml-2">{detail}</span>}
      </div>
    </div>
  )
}

function TogglePill({
  active,
  onClick,
  label,
  small,
}: {
  active: boolean
  onClick: () => void
  label: string
  small?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded font-mono transition-all duration-150',
        small ? 'px-2.5 py-1 text-[11px]' : 'px-4 py-1.5 text-sm',
        active
          ? 'bg-[#7aa2f7]/20 text-[#7aa2f7] border border-[#7aa2f7]/40'
          : 'bg-transparent text-[#565f89] border border-border hover:text-foreground hover:border-foreground/30',
      )}
    >
      {label}
    </button>
  )
}

function ToggleSwitch({ on }: { on: boolean }) {
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
