/**
 * Spawn Dialog - Pre-spawn configuration + launch monitor
 *
 * Phase 1 (config): Configure model, effort, mode, etc.
 * Phase 2 (launching): Step-by-step progress via shared LaunchMonitor.
 */

import { buildSpawnDiagnostics } from '@shared/spawn-diagnostics'
import type { SpawnRequest } from '@shared/spawn-schema'
import { Zap } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { TileToggleRow } from '@/components/ui/tile-toggle-row'
import { TogglePill } from '@/components/ui/toggle-pill'
import { updateProjectSettings, useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { useLaunchProgress } from '@/hooks/use-launch-progress'
import { sendSpawnRequest } from '@/hooks/use-spawn'
import { parseEnvText } from '@/lib/env-parse'
import { useKeyLayer } from '@/lib/key-layers'
import { cwdToProjectUri } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { LaunchConfigFields, type LaunchFieldsValue } from './launch-config-fields'
import { LaunchErrorBanner, LaunchFooterActions, LaunchStepList } from './launch-monitor'

interface SpawnDialogOptions {
  cwd: string
  mkdir?: boolean
  sentinel?: string
}

interface SpawnDialogState {
  open: boolean
  options: SpawnDialogOptions | null
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
  const [agent, setAgent] = useState('')
  const [bare, setBare] = useState(false)
  const [repl, setRepl] = useState(false)
  const [useWorktree, setUseWorktree] = useState(false)
  const [worktreeName, setWorktreeName] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [permissionMode, setPermissionMode] = useState('')
  const [autocompactPct, setAutocompactPct] = useState<number | ''>('')
  const [maxBudgetUsd, setMaxBudgetUsd] = useState('')
  const [includePartialMessages, setIncludePartialMessages] = useState(true)
  const [configTab, setConfigTab] = useState<'basic' | 'advanced'>('basic')
  const [envText, setEnvText] = useState('')
  const [phase, setPhase] = useState<'config' | 'launching'>('config')
  const [savedFeedback, setSavedFeedback] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [conversationId, setWrapperId] = useState<string | null>(null)
  // Track which session was selected when spawn started -- don't yank the user
  // back to the spawned session if they navigated away during the countdown
  const sessionAtSpawnRef = useRef<string | null>(null)

  const projectSettings = useConversationsStore(s => s.projectSettings)
  const globalSettings = useConversationsStore(s => s.globalSettings)

  // Shared launch progress hook
  const progress = useLaunchProgress({
    jobId,
    conversationId,
    timeoutMs: 60_000,
    enabled: phase === 'launching',
  })

  // Register the open callback
  const progressReset = progress.reset
  useEffect(() => {
    _openDialog = (options: SpawnDialogOptions) => {
      const ps = projectSettings[cwdToProjectUri(options.cwd)]
      const gs = globalSettings as Record<string, unknown>
      // Resolve defaults: project > global > hardcoded
      const defaultMode = ps?.defaultLaunchMode || (gs.defaultLaunchMode as string) || 'headless'
      setHeadless(defaultMode !== 'pty')
      setModel('')
      setEffort('')
      setAgent('')
      setBare(ps?.defaultBare ?? (gs.defaultBare as boolean) ?? false)
      setRepl(ps?.defaultRepl ?? (gs.defaultRepl as boolean) ?? false)
      setUseWorktree(false)
      setWorktreeName('')
      setName('')
      setDescription('')
      const pm = ps?.defaultPermissionMode || (gs.defaultPermissionMode as string) || 'default'
      setPermissionMode(pm === 'default' ? '' : pm)
      const acp = ps?.defaultAutocompactPct ?? (gs.defaultAutocompactPct as number) ?? 0
      setAutocompactPct(acp > 0 ? acp : '')
      const budget = ps?.defaultMaxBudgetUsd ?? (gs.defaultMaxBudgetUsd as number) ?? 0
      setMaxBudgetUsd(budget > 0 ? String(budget) : '')
      const envDefault = ps?.defaultEnvText || (gs.defaultEnvText as string) || ''
      setEnvText(envDefault)
      setIncludePartialMessages(
        ps?.defaultIncludePartialMessages ?? (gs.defaultIncludePartialMessages as boolean) ?? true,
      )
      setConfigTab('basic')
      setSavedFeedback(null)
      setPhase('config')
      setJobId(null)
      setWrapperId(null)
      // Drop any stale error/steps from a prior failed launch so reopening
      // the dialog doesn't show the old "Session failed to connect" banner.
      progressReset()
      setState({ open: true, options })
    }
    return () => {
      _openDialog = null
    }
  }, [projectSettings, globalSettings, progressReset])

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
    const currentId = useConversationsStore.getState().selectedConversationId
    const userNavigatedAway = currentId !== sessionAtSpawnRef.current && currentId !== null
    const sid =
      progress.launch.sessionId ||
      (progress.spawnedSession && progress.spawnedSession.status !== 'ended' ? progress.spawnedSession.id : null)

    if (sid && !userNavigatedAway) {
      useConversationsStore.getState().selectConversation(sid, 'spawn-dialog-close')
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
    if (sid) useConversationsStore.getState().selectConversation(sid, 'spawn-dialog-view-session')
    progress.setViewCountdown(null)
    setState({ open: false, options: null })
    setJobId(null)
  }, [progress.launch.sessionId, progress.spawnedSession, progress.setViewCountdown])

  const handleSpawn = useCallback(async () => {
    if (!state.options || phase !== 'config') return

    // Validate env before spawning. Errors render inline in LaunchConfigFields
    // as the user types, so we just block submit here.
    const [parsedEnv, errors] = parseEnvText(envText)
    if (errors.length) {
      setConfigTab('advanced')
      haptic('error')
      return
    }

    setPhase('launching')
    sessionAtSpawnRef.current = useConversationsStore.getState().selectedConversationId
    haptic('tap')

    // Generate jobId and subscribe BEFORE making the HTTP request
    const newJobId = crypto.randomUUID()
    setJobId(newJobId)
    progress.start([{ label: 'Sending spawn request', status: 'active', ts: Date.now() }])

    const spawnReq: SpawnRequest = {
      cwd: state.options.cwd,
      mkdir: state.options.mkdir || false,
      headless,
      bare: bare || undefined,
      repl: repl || undefined,
      name: name.trim() || undefined,
      description: description.trim() || undefined,
      model: (model || undefined) as SpawnRequest['model'],
      effort: (effort || undefined) as SpawnRequest['effort'],
      agent: agent.trim() || undefined,
      permissionMode: (permissionMode || undefined) as SpawnRequest['permissionMode'],
      autocompactPct: autocompactPct === '' ? undefined : autocompactPct,
      maxBudgetUsd: maxBudgetUsd ? Number(maxBudgetUsd) : undefined,
      worktree: useWorktree && worktreeName.trim() ? worktreeName.trim() : undefined,
      includePartialMessages: includePartialMessages || undefined,
      sentinel: state.options.sentinel || undefined,
      env: parsedEnv || undefined,
      jobId: newJobId,
    }
    const result = await sendSpawnRequest(spawnReq)
    if (result.ok) {
      haptic('success')
      setWrapperId(result.conversationId)
      progress.setSteps(prev => [
        ...prev.map(s =>
          s.status === 'active'
            ? { ...s, status: 'done' as const, detail: `wrapper=${result.conversationId.slice(0, 8)}` }
            : s,
        ),
        { label: 'Waiting for session...', status: 'active' as const, ts: Date.now() },
      ])
    } else {
      progress.setError(result.error)
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
    agent,
    permissionMode,
    autocompactPct,
    maxBudgetUsd,
    includePartialMessages,
    useWorktree,
    worktreeName,
    envText,
    progress,
  ])

  // Keyboard layer: Enter spawns (config) or views session (launching). Radix Dialog handles Escape.
  // Config-only quick toggles: h/p = Headless/PTY, 1/2 = Basic/Advanced tab.
  // Single-letter/digit bindings are auto-skipped when a text input is focused
  // (see useKeyLayer: `if (inTextInput && !isModified && !isNonPrintable) return`).
  useKeyLayer(
    {
      Enter: () => {
        if (phase === 'config') handleSpawn()
        else if (phase === 'launching' && progress.isConnected) handleViewSession()
      },
      h: () => {
        if (phase !== 'config') return
        setHeadless(true)
        haptic('tap')
      },
      p: () => {
        if (phase !== 'config') return
        setHeadless(false)
        haptic('tap')
      },
      '1': () => {
        if (phase !== 'config') return
        setConfigTab('basic')
        haptic('tick')
      },
      '2': () => {
        if (phase !== 'config') return
        setConfigTab('advanced')
        haptic('tick')
      },
    },
    { id: 'spawn-dialog', enabled: state.open },
  )

  function buildSpawnDefaults() {
    return {
      defaultLaunchMode: headless ? ('headless' as const) : ('pty' as const),
      defaultEffort: effort ? (effort as 'low' | 'medium' | 'high' | 'max') : ('default' as const),
      defaultModel: model || '',
      defaultBare: bare,
      defaultRepl: repl,
      defaultPermissionMode: permissionMode
        ? (permissionMode as 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions')
        : ('default' as const),
      defaultAutocompactPct: autocompactPct ? Number(autocompactPct) : 0,
      defaultMaxBudgetUsd: maxBudgetUsd ? Number(maxBudgetUsd) : 0,
      defaultIncludePartialMessages: includePartialMessages,
      defaultEnvText: envText.trim(),
    }
  }

  function handleSaveProjectDefaults() {
    if (!state.options) return
    const defaults = buildSpawnDefaults()
    updateProjectSettings(cwdToProjectUri(state.options.cwd), defaults)
    setSavedFeedback('project')
    haptic('success')
    setTimeout(() => setSavedFeedback(null), 2000)
  }

  function handleSaveGlobalDefaults() {
    const defaults = buildSpawnDefaults()
    wsSend('update_settings', { settings: defaults })
    setSavedFeedback('global')
    haptic('success')
    setTimeout(() => setSavedFeedback(null), 2000)
  }

  function handleResetDefaults() {
    setHeadless(true)
    setModel('')
    setEffort('')
    setAgent('')
    setBare(false)
    setRepl(false)
    setPermissionMode('')
    setAutocompactPct('')
    setMaxBudgetUsd('')
    setIncludePartialMessages(true)
    setEnvText('')
    haptic('tap')
  }

  function handleCopyLog() {
    const [parsedEnv] = parseEnvText(envText)
    const diag = buildSpawnDiagnostics({
      source: 'spawn-dialog',
      jobId,
      conversationId: conversationId || progress.launch.conversationId || null,
      sessionId: progress.launch.sessionId ?? null,
      elapsedSec: progress.elapsed,
      error: progress.error || progress.launch.error || null,
      config: {
        cwd: state.options?.cwd,
        headless,
        bare,
        name: name || undefined,
        model: (model || undefined) as SpawnRequest['model'],
        effort: (effort || undefined) as SpawnRequest['effort'],
        permissionMode: (permissionMode || undefined) as SpawnRequest['permissionMode'],
        env: parsedEnv ?? undefined,
      },
      steps: progress.steps.map(s => ({
        label: s.label,
        status: s.status,
        detail: s.detail ?? null,
        ts: s.ts ?? null,
      })),
      launchEvents: progress.launch.events.map(e => ({
        step: e.step,
        status: e.status,
        detail: e.detail ?? null,
        t: e.t,
      })),
      launchState: { completed: progress.launch.completed, failed: progress.launch.failed },
    })
    progress.copyToClipboard(JSON.stringify(diag, null, 2))
  }

  const shortPath = state.options?.cwd?.replace(/^\/Users\/[^/]+/, '~') || ''
  const displayError = progress.error || progress.launch.error

  function applyFieldsPatch(patch: Partial<LaunchFieldsValue>) {
    if ('model' in patch) setModel(patch.model ?? '')
    if ('effort' in patch) setEffort(patch.effort ?? '')
    if ('agent' in patch) setAgent(patch.agent ?? '')
    if ('permissionMode' in patch) setPermissionMode(patch.permissionMode ?? '')
    if ('autocompactPct' in patch) setAutocompactPct(patch.autocompactPct ?? '')
    if ('maxBudgetUsd' in patch) setMaxBudgetUsd(patch.maxBudgetUsd ?? '')
    if ('useWorktree' in patch) setUseWorktree(!!patch.useWorktree)
    if ('worktreeName' in patch) setWorktreeName(patch.worktreeName ?? '')
    if ('envText' in patch) setEnvText(patch.envText ?? '')
    if ('name' in patch) setName(patch.name ?? '')
    if ('description' in patch) setDescription(patch.description ?? '')
    if ('includePartialMessages' in patch) setIncludePartialMessages(patch.includePartialMessages ?? true)
  }

  const fieldsValue: LaunchFieldsValue = {
    model,
    effort,
    agent,
    permissionMode,
    autocompactPct,
    maxBudgetUsd,
    includePartialMessages,
    useWorktree,
    worktreeName,
    envText,
    name,
    description,
  }

  return (
    <Dialog open={state.open} onOpenChange={open => !open && handleClose()}>
      <DialogContent className="max-w-md rounded-lg">
        <div className="p-5 flex flex-col gap-4 min-h-0 max-h-[calc(85vh-2rem)]">
          <div className="flex items-center justify-between shrink-0">
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
          <div className="text-[11px] font-mono text-muted-foreground truncate shrink-0">{shortPath}</div>

          {/* ── Config Phase ── */}
          {phase === 'config' && (
            <>
              {/* Tab selector */}
              <div className="flex gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setConfigTab('basic')
                    haptic('tick')
                  }}
                  className={cn(
                    'px-3 py-1 text-[11px] font-mono rounded transition-colors inline-flex items-center gap-1.5',
                    configTab === 'basic'
                      ? 'bg-[#7aa2f7]/15 text-[#7aa2f7] border border-[#7aa2f7]/30'
                      : 'text-[#565f89] hover:text-muted-foreground',
                  )}
                >
                  Basic
                  <Kbd className="text-[10px]">1</Kbd>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfigTab('advanced')
                    haptic('tick')
                  }}
                  className={cn(
                    'px-3 py-1 text-[11px] font-mono rounded transition-colors inline-flex items-center gap-1.5',
                    configTab === 'advanced'
                      ? 'bg-[#7aa2f7]/15 text-[#7aa2f7] border border-[#7aa2f7]/30'
                      : 'text-[#565f89] hover:text-muted-foreground',
                  )}
                >
                  Advanced
                  <Kbd className="text-[10px]">2</Kbd>
                </button>
              </div>

              {/* Scrollable content area.
                  Inner padding gives focus rings (ring-[3px]) room; without
                  this, overflow-y:auto implicitly clips overflow-x and the
                  blue focus ring on inputs/selects gets sliced off. */}
              <div className="overflow-y-auto flex-1 min-h-0 space-y-4 px-1.5 py-1">
                {configTab === 'basic' && (
                  <div className="space-y-3">
                    {/* Mode toggle (dialog-specific: drives headless + keyboard shortcut) */}
                    <div className="space-y-2">
                      <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">
                        Mode
                      </div>
                      <div className="flex gap-2">
                        <TogglePill
                          active={headless}
                          onClick={() => {
                            setHeadless(true)
                            haptic('tap')
                          }}
                          label="Headless"
                          shortcut="H"
                        />
                        <TogglePill
                          active={!headless}
                          onClick={() => {
                            setHeadless(false)
                            haptic('tap')
                          }}
                          label="PTY"
                          shortcut="P"
                        />
                      </div>
                    </div>

                    <LaunchConfigFields
                      value={fieldsValue}
                      onChange={applyFieldsPatch}
                      show={{ name: true, description: true, model: true, effort: true }}
                    />
                  </div>
                )}

                {configTab === 'advanced' && (
                  <div className="space-y-3">
                    <LaunchConfigFields
                      value={fieldsValue}
                      onChange={applyFieldsPatch}
                      show={{
                        agent: true,
                        permissionMode: true,
                        autocompactPct: true,
                        maxBudgetUsd: headless,
                        includePartialMessages: headless,
                        worktree: true,
                      }}
                    />

                    {/* REPL tool toggle (dialog-specific) */}
                    <TileToggleRow
                      title="REPL tool"
                      subtitle="JS sandbox for batched tool calls (CLAUDE_CODE_REPL)"
                      checked={repl}
                      onToggle={() => setRepl(!repl)}
                    />

                    {/* Bare toggle (dialog-specific) */}
                    <TileToggleRow
                      title="Bare session"
                      subtitle="Skip hooks, plugins, CLAUDE.md, auto-memory"
                      checked={bare}
                      onToggle={() => setBare(!bare)}
                    />
                    {bare && (
                      <div className="text-[10px] font-mono text-amber-400/80 bg-amber-950/20 border border-amber-400/30 rounded px-2 py-1.5 leading-snug">
                        <span className="font-bold">warning:</span> --bare uses a separate Claude auth cache and may
                        force a fresh login the first time. Plugins, CLAUDE.md and auto-memory are also disabled.
                      </div>
                    )}

                    {/* Env vars (LaunchConfigFields renders textarea + inline errors) */}
                    <LaunchConfigFields value={fieldsValue} onChange={applyFieldsPatch} show={{ env: true }} />
                    <div className="text-[9px] text-[#565f89]">
                      KEY=value per line, set before executing claude. # comments ok.
                    </div>

                    {/* Save / Reset defaults */}
                    <div className="flex items-center gap-3 pt-1">
                      <button
                        type="button"
                        onClick={handleSaveProjectDefaults}
                        className="text-[10px] font-mono text-[#7aa2f7]/70 hover:text-[#7aa2f7] transition-colors"
                      >
                        {savedFeedback === 'project' ? 'Saved!' : 'Save for project'}
                      </button>
                      <span className="text-[#292e42]">|</span>
                      <button
                        type="button"
                        onClick={handleSaveGlobalDefaults}
                        className="text-[10px] font-mono text-[#565f89] hover:text-muted-foreground transition-colors"
                      >
                        {savedFeedback === 'global' ? 'Saved!' : 'Save globally'}
                      </button>
                      <span className="text-[#292e42]">|</span>
                      <button
                        type="button"
                        onClick={handleResetDefaults}
                        className="text-[10px] font-mono text-[#565f89] hover:text-red-400 transition-colors"
                      >
                        Reset
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Launching Phase ── */}
          {phase === 'launching' && (
            <div className="space-y-3">
              <LaunchStepList steps={progress.steps} />
            </div>
          )}

          {/* Error banner */}
          {displayError && (
            <div className="shrink-0">
              <LaunchErrorBanner error={displayError} copied={progress.copied} onCopy={handleCopyLog} />
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1 shrink-0">
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
