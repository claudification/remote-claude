/**
 * Spawn Dialog - Pre-spawn configuration + launch monitor
 *
 * Phase 1 (config): Configure model, effort, mode, etc.
 * Phase 2 (launching): Step-by-step progress via shared LaunchMonitor.
 */

import { ChevronDown, Zap } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useLaunchProgress } from '@/hooks/use-launch-progress'
import { useSessionsStore } from '@/hooks/use-sessions'
import { useKeyLayer } from '@/lib/key-layers'
import { cn, haptic } from '@/lib/utils'
import { LaunchErrorBanner, LaunchFooterActions, LaunchStepList } from './launch-monitor'

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

/** Parse KEY=value lines into env record. Returns [env, errors]. */
function parseEnvText(text: string): [Record<string, string> | null, string[]] {
  if (!text.trim()) return [null, []]
  const env: Record<string, string> = {}
  const errors: string[] = []
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) {
      errors.push(`Line ${i + 1}: missing KEY=value`)
      continue
    }
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(`Line ${i + 1}: invalid key "${key}"`)
      continue
    }
    if (/["']/.test(value)) {
      errors.push(`Line ${i + 1}: no quotes needed, use raw value`)
      continue
    }
    env[key] = value
  }
  return [errors.length ? null : Object.keys(env).length ? env : null, errors]
}

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
  const [repl, setRepl] = useState(false)
  const [useWorktree, setUseWorktree] = useState(false)
  const [worktreeName, setWorktreeName] = useState('')
  const [name, setName] = useState('')
  const [permissionMode, setPermissionMode] = useState('')
  const [autocompactPct, setAutocompactPct] = useState<number | ''>('')
  const [maxBudgetUsd, setMaxBudgetUsd] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [envText, setEnvText] = useState('')
  const [envErrors, setEnvErrors] = useState<string[]>([])
  const [phase, setPhase] = useState<'config' | 'launching'>('config')
  const [jobId, setJobId] = useState<string | null>(null)
  const [wrapperId, setWrapperId] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  // Track which session was selected when spawn started -- don't yank the user
  // back to the spawned session if they navigated away during the countdown
  const sessionAtSpawnRef = useRef<string | null>(null)

  const projectSettings = useSessionsStore(s => s.projectSettings)
  const globalSettings = useSessionsStore(s => s.globalSettings)

  // Shared launch progress hook
  const progress = useLaunchProgress({
    jobId,
    wrapperId,
    timeoutMs: 60_000,
    enabled: phase === 'launching',
  })

  // Register the open callback
  useEffect(() => {
    _openDialog = (options: SpawnDialogOptions) => {
      const projSettings = projectSettings[options.cwd]
      const defaultMode = projSettings?.defaultLaunchMode || (globalSettings.defaultLaunchMode as string) || 'headless'
      setHeadless(defaultMode !== 'pty')
      setModel('')
      setEffort('')
      setBare(false)
      setRepl(false)
      setUseWorktree(false)
      setWorktreeName('')
      setName('')
      setPermissionMode('')
      setAutocompactPct('')
      setMaxBudgetUsd('')
      setShowAdvanced(false)
      setEnvText('')
      setEnvErrors([])
      setPhase('config')
      setJobId(null)
      setWrapperId(null)
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

  // Add "Session connected" step when session connects
  const addedConnectedStepRef = useRef(false)
  useEffect(() => {
    if (!progress.isConnected || addedConnectedStepRef.current) return
    addedConnectedStepRef.current = true
    progress.setSteps(prev => [
      ...prev,
      {
        label: 'Session connected',
        status: 'done',
        ts: Date.now(),
        detail: (progress.launch.sessionId || progress.spawnedSession?.id || '').slice(0, 8),
      },
    ])
  }, [progress.isConnected, progress.launch.sessionId, progress.spawnedSession?.id])

  // Auto-redirect when countdown reaches 0
  useEffect(() => {
    if (progress.viewCountdown !== 0) return
    handleClose()
  }, [progress.viewCountdown]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Close and optionally navigate to spawned session.
   *  Skips navigation if the user switched sessions during the spawn countdown. */
  const handleClose = useCallback(() => {
    addedConnectedStepRef.current = false
    const currentId = useSessionsStore.getState().selectedSessionId
    const userNavigatedAway = currentId !== sessionAtSpawnRef.current && currentId !== null
    const sid =
      progress.launch.sessionId ||
      (progress.spawnedSession && progress.spawnedSession.status !== 'ended' ? progress.spawnedSession.id : null)

    if (sid && !userNavigatedAway) {
      useSessionsStore.getState().selectSession(sid, 'spawn-dialog-close')
    } else if (sid && userNavigatedAway) {
      console.log(
        `[nav] spawn-dialog: NOT switching to ${sid.slice(0, 8)} -- user navigated to ${currentId?.slice(0, 8)} during spawn`,
      )
    }
    setState({ open: false, options: null })
    setJobId(null)
  }, [progress.launch.sessionId, progress.spawnedSession])

  /** Explicitly navigate to the spawned session and close. */
  const handleViewSession = useCallback(() => {
    const sid = progress.launch.sessionId || progress.spawnedSession?.id
    if (sid) useSessionsStore.getState().selectSession(sid, 'spawn-dialog-view-session')
    progress.setViewCountdown(null)
    setState({ open: false, options: null })
    setJobId(null)
  }, [progress.launch.sessionId, progress.spawnedSession, progress.setViewCountdown])

  const handleSpawn = useCallback(async () => {
    if (!state.options || phase !== 'config') return

    // Validate env before spawning
    const [parsedEnv, errors] = parseEnvText(envText)
    if (errors.length) {
      setEnvErrors(errors)
      return
    }

    setPhase('launching')
    sessionAtSpawnRef.current = useSessionsStore.getState().selectedSessionId
    haptic('tap')

    // Generate jobId and subscribe BEFORE making the HTTP request
    const newJobId = crypto.randomUUID()
    setJobId(newJobId)
    progress.start([{ label: 'Sending spawn request', status: 'active', ts: Date.now() }])

    try {
      const res = await fetch('/api/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: state.options.cwd,
          mkdir: state.options.mkdir || false,
          headless,
          bare: bare || undefined,
          repl: repl || undefined,
          name: name.trim() || undefined,
          model: model || undefined,
          effort: effort || undefined,
          permissionMode: permissionMode || undefined,
          autocompactPct: autocompactPct || undefined,
          maxBudgetUsd: maxBudgetUsd ? Number(maxBudgetUsd) : undefined,
          worktree: useWorktree && worktreeName.trim() ? worktreeName.trim() : undefined,
          env: parsedEnv || undefined,
          jobId: newJobId,
        }),
      })
      const data = await res.json()
      if (data.success) {
        haptic('success')
        setWrapperId(data.wrapperId)
        progress.setSteps(prev => [
          ...prev.map(s =>
            s.status === 'active'
              ? { ...s, status: 'done' as const, detail: `wrapper=${data.wrapperId.slice(0, 8)}` }
              : s,
          ),
          { label: 'Waiting for session...', status: 'active' as const, ts: Date.now() },
        ])
      } else {
        progress.setError(data.error || 'Spawn failed')
        haptic('error')
      }
    } catch (err: unknown) {
      progress.setError(err instanceof Error ? err.message : 'Network error')
      haptic('error')
    }
  }, [
    state.options,
    phase,
    headless,
    bare,
    repl,
    name,
    model,
    effort,
    permissionMode,
    autocompactPct,
    maxBudgetUsd,
    useWorktree,
    worktreeName,
    envText,
    progress,
  ])

  // Keyboard layer: ESC closes, Enter spawns (config) or views session (launching)
  useKeyLayer(
    {
      Escape: handleClose,
      Enter: () => {
        if (phase === 'config') handleSpawn()
        else if (phase === 'launching' && progress.isConnected) handleViewSession()
      },
    },
    { id: 'spawn-dialog', enabled: state.open },
  )

  function handleCopyLog() {
    const log = {
      type: 'spawn_log',
      time: new Date().toISOString(),
      cwd: state.options?.cwd,
      jobId,
      wrapperId: wrapperId || progress.launch.wrapperId || null,
      sessionId: progress.launch.sessionId || null,
      elapsed: `${progress.elapsed}s`,
      error: progress.error || progress.launch.error || null,
      events: progress.launch.events.map(e => ({
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
        env: envText.trim() || null,
      },
    }
    progress.copyToClipboard(JSON.stringify(log, null, 2))
  }

  const shortPath = state.options?.cwd?.replace(/^\/Users\/[^/]+/, '~') || ''
  const projSettings = state.options ? projectSettings[state.options.cwd] : undefined
  const defaultModel = projSettings?.defaultModel || (globalSettings.defaultModel as string) || 'opus'
  const defaultEffort = projSettings?.defaultEffort || (globalSettings.defaultEffort as string) || 'default'
  const displayError = progress.error || progress.launch.error

  return (
    <Dialog open={state.open} onOpenChange={open => !open && handleClose()}>
      <DialogContent className="max-w-md rounded-lg">
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <DialogTitle className="text-sm font-bold font-mono flex items-center gap-2">
              {phase === 'launching' && <Zap className="w-4 h-4 text-[#7aa2f7]" />}
              {phase === 'config'
                ? 'SPAWN SESSION'
                : progress.isConnected
                  ? 'SESSION CONNECTED'
                  : progress.hasError
                    ? 'SPAWN FAILED'
                    : 'LAUNCHING...'}
            </DialogTitle>
            {phase === 'launching' && (
              <span className="text-[10px] font-mono text-muted-foreground/60 tabular-nums">{progress.elapsed}s</span>
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

                  {/* Worktree toggle */}
                  <div className="space-y-1.5 pl-3">
                    <div
                      role="button"
                      tabIndex={0}
                      className="flex items-center justify-between py-1.5 cursor-pointer select-none"
                      onClick={() => {
                        const next = !useWorktree
                        setUseWorktree(next)
                        if (next && !worktreeName) setWorktreeName(name.trim() || '')
                        haptic('tap')
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          const next = !useWorktree
                          setUseWorktree(next)
                          if (next && !worktreeName) setWorktreeName(name.trim() || '')
                          haptic('tap')
                        }
                      }}
                    >
                      <div>
                        <div className="text-sm font-mono">Git worktree</div>
                        <div className="text-[10px] text-[#565f89]">Isolated branch, auto-merges on completion</div>
                      </div>
                      <ToggleSwitch on={useWorktree} />
                    </div>
                    {useWorktree && (
                      <input
                        type="text"
                        value={worktreeName}
                        onChange={e => setWorktreeName(e.target.value)}
                        placeholder="Branch name..."
                        className={cn(
                          'w-full bg-[#1a1b26] border border-border rounded px-3 py-1.5',
                          'text-sm font-mono text-foreground placeholder:text-[#565f89]',
                          'focus:outline-none focus:border-[#7aa2f7]/50',
                        )}
                      />
                    )}
                  </div>

                  {/* REPL tool toggle */}
                  <div
                    role="button"
                    tabIndex={0}
                    className="flex items-center justify-between py-1.5 pl-3 cursor-pointer select-none"
                    onClick={() => {
                      setRepl(!repl)
                      haptic('tap')
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        setRepl(!repl)
                        haptic('tap')
                      }
                    }}
                  >
                    <div>
                      <div className="text-sm font-mono">REPL tool</div>
                      <div className="text-[10px] text-[#565f89]">
                        JS sandbox for batched tool calls (CLAUDE_CODE_REPL)
                      </div>
                    </div>
                    <ToggleSwitch on={repl} />
                  </div>

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

                  {/* Custom env vars */}
                  <div className="space-y-1.5 pl-3">
                    <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide">
                      Environment variables
                    </div>
                    <textarea
                      value={envText}
                      onChange={e => {
                        setEnvText(e.target.value)
                        setEnvErrors([])
                      }}
                      placeholder={'MAX_THINKING_TOKENS=16000\nCLAUDE_CODE_EFFORT_LEVEL=max'}
                      rows={3}
                      spellCheck={false}
                      className={cn(
                        'w-full bg-[#1a1b26] border rounded px-3 py-2',
                        'text-xs font-mono text-foreground placeholder:text-[#565f89]/60',
                        'focus:outline-none resize-y leading-relaxed',
                        envErrors.length
                          ? 'border-red-500/60 focus:border-red-500'
                          : 'border-border focus:border-[#7aa2f7]/50',
                      )}
                    />
                    {envErrors.length > 0 && (
                      <div className="text-[10px] font-mono text-red-400 space-y-0.5">
                        {envErrors.map(e => (
                          <div key={e}>{e}</div>
                        ))}
                      </div>
                    )}
                    <div className="text-[9px] text-[#565f89]">
                      KEY=value per line, set before executing claude. # comments ok.
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Launching Phase ── */}
          {phase === 'launching' && (
            <div className="space-y-3">
              <LaunchStepList steps={progress.steps} />
            </div>
          )}

          {/* Error banner */}
          {displayError && <LaunchErrorBanner error={displayError} copied={progress.copied} onCopy={handleCopyLog} />}

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
                    'flex items-center justify-center gap-2',
                  )}
                >
                  Cancel
                  <Kbd>Esc</Kbd>
                </button>
                <button
                  type="button"
                  onClick={handleSpawn}
                  className={cn(
                    'flex-1 px-4 py-2 rounded text-sm font-mono font-bold',
                    'bg-[#7aa2f7] text-[#1a1b26] hover:bg-[#7aa2f7]/90',
                    'transition-colors',
                    'flex items-center justify-center gap-2',
                  )}
                >
                  Spawn
                  <KbdGroup>
                    <Kbd className="bg-[#1a1b26]/20 text-[#1a1b26]/70">↵</Kbd>
                  </KbdGroup>
                </button>
              </>
            )}
            {phase === 'launching' && (
              <LaunchFooterActions
                isConnected={progress.isConnected}
                isComplete={progress.isComplete}
                hasError={progress.hasError}
                viewCountdown={progress.viewCountdown}
                onViewSession={() => {
                  progress.setViewCountdown(null)
                  handleViewSession()
                }}
                onClose={handleClose}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Sub-components ──────────────────────────────────────────────

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
