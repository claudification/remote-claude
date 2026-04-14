/**
 * Spawn Dialog - Pre-spawn configuration modal
 *
 * Shows before spawning a session to let the user configure:
 * - Headless vs PTY mode
 * - Model (opus/sonnet/haiku)
 * - Effort level (low/medium/high/max)
 * - Optional session name
 * - Permission mode
 * - Bare mode (skip hooks, plugins, CLAUDE.md)
 *
 * Defaults are pulled from project settings (if CWD has them) or global settings.
 */

import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
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
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [spawning, setSpawning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const projectSettings = useSessionsStore(s => s.projectSettings)
  const globalSettings = useSessionsStore(s => s.globalSettings)

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
      setShowAdvanced(false)
      setError(null)
      setSpawning(false)
      setState({ open: true, options })
    }
    return () => {
      _openDialog = null
    }
  }, [projectSettings, globalSettings])

  // Focus name input when dialog opens
  useEffect(() => {
    if (state.open) {
      setTimeout(() => nameRef.current?.focus(), 100)
    }
  }, [state.open])

  const handleClose = useCallback(() => {
    setState({ open: false, options: null })
  }, [])

  const handleSpawn = useCallback(async () => {
    if (!state.options || spawning) return
    setSpawning(true)
    setError(null)
    haptic('tap')

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
        }),
      })
      const data = await res.json()
      if (data.success) {
        haptic('success')
        handleClose()
      } else {
        setError(data.error || 'Spawn failed')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setSpawning(false)
    }
  }, [state.options, spawning, headless, bare, name, model, effort, permissionMode, autocompactPct, handleClose])

  // Handle Enter key to submit
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSpawn()
      }
    },
    [handleSpawn],
  )

  const shortPath = state.options?.cwd?.replace(/^\/Users\/[^/]+/, '~') || ''

  // Resolve what defaults mean for the hint text
  const projSettings = state.options ? projectSettings[state.options.cwd] : undefined
  const defaultModel = projSettings?.defaultModel || (globalSettings.defaultModel as string) || 'opus'
  const defaultEffort = projSettings?.defaultEffort || (globalSettings.defaultEffort as string) || 'default'

  return (
    <Dialog open={state.open} onOpenChange={open => !open && handleClose()}>
      <DialogContent className="max-w-md rounded-lg" onKeyDown={handleKeyDown}>
        <div className="p-5 space-y-4">
          <DialogTitle className="text-sm font-bold font-mono">SPAWN SESSION</DialogTitle>

          {/* CWD display */}
          <div className="text-[11px] font-mono text-muted-foreground truncate">{shortPath}</div>

          {/* Name input */}
          <div className="space-y-1.5">
            <label htmlFor="spawn-name" className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide">
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
            <ChevronDown className={cn('w-3 h-3 transition-transform duration-150', showAdvanced && 'rotate-180')} />
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

          {/* Error */}
          {error && <div className="text-[11px] font-mono text-red-400 bg-red-500/10 rounded px-3 py-2">{error}</div>}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
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
              disabled={spawning}
              className={cn(
                'flex-1 px-4 py-2 rounded text-sm font-mono font-bold',
                'bg-[#7aa2f7] text-[#1a1b26] hover:bg-[#7aa2f7]/90',
                'transition-colors disabled:opacity-50',
              )}
            >
              {spawning ? 'Spawning...' : 'Spawn'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
