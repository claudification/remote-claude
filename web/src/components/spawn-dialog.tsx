/**
 * Spawn Dialog - Pre-spawn configuration + launch monitor
 *
 * Phase 1 (config): Configure model, effort, mode, etc.
 * Phase 2 (launching): Step-by-step progress via shared LaunchMonitor.
 */

import type { ChatApiConnection } from '@shared/chat-api-types'
import type { CcSessionEntry } from '@shared/protocol'
import { buildSpawnDiagnostics } from '@shared/spawn-diagnostics'
import type { SpawnRequest } from '@shared/spawn-schema'
import { ChevronDown, Zap } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { TileToggleRow } from '@/components/ui/tile-toggle-row'
import { TogglePill } from '@/components/ui/toggle-pill'
import {
  type ProjectSettingsMap,
  updateProjectSettings,
  useConversationsStore,
  wsSend,
} from '@/hooks/use-conversations'
import { useLaunchProgress } from '@/hooks/use-launch-progress'
import { sendSpawnRequest } from '@/hooks/use-spawn'
import { parseEnvText } from '@/lib/env-parse'
import { useKeyLayer } from '@/lib/key-layers'
import { cwdToProjectUri } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { LaunchConfigFields, type LaunchFieldsValue } from './launch-config-fields'
import { LaunchDialogBottom } from './launch-monitor'

interface SpawnDialogOptions {
  path: string
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
  const [resumeId, setResumeId] = useState('')
  const [envText, setEnvText] = useState('')
  const [backend, setBackend] = useState<'claude' | 'chat-api'>('claude')
  const [chatConnectionId, setChatConnectionId] = useState('')
  const [chatConnections, setChatConnections] = useState<ChatApiConnection[]>([])
  const [phase, setPhase] = useState<'config' | 'launching'>('config')
  const [savedFeedback, setSavedFeedback] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [conversationId, setWrapperId] = useState<string | null>(null)
  // Track which session was selected when spawn started -- don't yank the user
  // back to the spawned session if they navigated away during the countdown
  const sessionAtSpawnRef = useRef<string | null>(null)

  const projectSettings = useConversationsStore((s: { projectSettings: ProjectSettingsMap }) => s.projectSettings)
  const globalSettings = useConversationsStore((s: { globalSettings: Record<string, unknown> }) => s.globalSettings)

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
      const ps = projectSettings[cwdToProjectUri(options.path)]
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
      setResumeId('')
      setEnvText(envDefault)
      setIncludePartialMessages(
        ps?.defaultIncludePartialMessages ?? (gs.defaultIncludePartialMessages as boolean) ?? true,
      )
      setBackend('claude')
      setChatConnectionId('')
      setConfigTab('basic')
      setSavedFeedback(null)
      setPhase('config')
      setJobId(null)
      setWrapperId(null)
      // Fetch chat connections
      fetch(`${window.location.protocol}//${window.location.host}/api/chat/connections`)
        .then(r => (r.ok ? r.json() : { connections: [] }))
        .then(d => setChatConnections(d.connections || []))
        .catch(() => setChatConnections([]))
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
        label: 'Conversation connected',
        status: 'done',
        ts: Date.now(),
        detail: (progress.launch.conversationId || progress.spawnedConversation?.id || '').slice(0, 8),
      },
    ])
  }, [progress.isConnected, progress.launch.conversationId, progress.spawnedConversation?.id, progress.setSteps])

  const handleClose = useCallback(() => {
    addedConnectedStepRef.current = false
    const currentId = useConversationsStore.getState().selectedConversationId
    const userNavigatedAway = currentId !== sessionAtSpawnRef.current && currentId !== null
    const sid =
      progress.launch.conversationId ||
      (progress.spawnedConversation && progress.spawnedConversation.status !== 'ended'
        ? progress.spawnedConversation.id
        : null)

    if (sid && !userNavigatedAway) {
      useConversationsStore.getState().selectConversation(sid, 'spawn-dialog-close')
    } else if (sid && userNavigatedAway) {
      console.log(
        `[nav] spawn-dialog: NOT switching to ${sid.slice(0, 8)} -- user navigated to ${currentId?.slice(0, 8)} during spawn`,
      )
    }
    setState({ open: false, options: null })
    setJobId(null)
  }, [progress.launch.conversationId, progress.spawnedConversation])

  // Auto-redirect when countdown reaches 0
  useEffect(() => {
    if (progress.viewCountdown !== 0) return
    handleClose()
  }, [progress.viewCountdown, handleClose])

  /** Explicitly navigate to the spawned session and close. */
  const handleViewConversation = useCallback(() => {
    const sid = progress.launch.conversationId || progress.spawnedConversation?.id
    if (sid) useConversationsStore.getState().selectConversation(sid, 'spawn-dialog-view-session')
    progress.setViewCountdown(null)
    setState({ open: false, options: null })
    setJobId(null)
  }, [progress.launch.conversationId, progress.spawnedConversation, progress.setViewCountdown])

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

    const trimmedResumeId = resumeId.trim()
    const spawnReq: SpawnRequest = {
      cwd: state.options.path,
      mkdir: state.options.mkdir || false,
      mode: trimmedResumeId ? 'resume' : undefined,
      resumeId: trimmedResumeId || undefined,
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
      backend: backend !== 'claude' ? backend : undefined,
      chatConnectionId: backend === 'chat-api' ? chatConnectionId || undefined : undefined,
      chatConnectionName: backend === 'chat-api' ? chatConnections.find(a => a.id === chatConnectionId)?.name : undefined,
    }
    const result = await sendSpawnRequest(spawnReq)
    if (result.ok) {
      haptic('success')
      setWrapperId(result.conversationId)
      progress.setSteps(prev => [
        ...prev.map(s =>
          s.status === 'active'
            ? { ...s, status: 'done' as const, detail: `agent-host=${result.conversationId.slice(0, 8)}` }
            : s,
        ),
        { label: 'Waiting for conversation...', status: 'active' as const, ts: Date.now() },
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
    resumeId,
    includePartialMessages,
    useWorktree,
    worktreeName,
    envText,
    backend,
    chatConnectionId,
    chatConnections,
    progress,
    description.trim,
  ])

  // Keyboard layer: Enter spawns (config) or views session (launching). Radix Dialog handles Escape.
  // Config-only quick toggles: h/p = Headless/PTY, 1/2 = Basic/Advanced tab.
  // Single-letter/digit bindings are auto-skipped when a text input is focused
  // (see useKeyLayer: `if (inTextInput && !isModified && !isNonPrintable) return`).
  useKeyLayer(
    {
      Enter: () => {
        if (phase === 'config') handleSpawn()
        else if (phase === 'launching' && progress.isConnected) handleViewConversation()
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
    updateProjectSettings(cwdToProjectUri(state.options.path), defaults)
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
      connectionId: conversationId || progress.launch.conversationId || null,
      conversationId: progress.launch.conversationId ?? null,
      elapsedSec: progress.elapsed,
      error: progress.error || progress.launch.error || null,
      config: {
        cwd: state.options?.path,
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

  const shortPath = state.options?.path?.replace(/^\/Users\/[^/]+/, '~') || ''
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
    <Dialog open={state.open} onOpenChange={(open: boolean) => !open && handleClose()}>
      <DialogContent className="max-w-md rounded-lg">
        <div className="p-5 flex flex-col gap-4 min-h-0 max-h-[calc(85vh-2rem)]">
          <div className="flex items-center justify-between shrink-0">
            <DialogTitle className="text-sm font-bold font-mono flex items-center gap-2">
              {phase === 'launching' && <Zap className="w-4 h-4 text-primary" />}
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
              {/* Backend selector (Claude / Chat) */}
              {chatConnections.length > 0 && (
                <div className="flex gap-1.5 shrink-0">
                  <TogglePill
                    active={backend === 'claude'}
                    onClick={() => {
                      setBackend('claude')
                      haptic('tap')
                    }}
                    label="Claude"
                  />
                  <TogglePill
                    active={backend === 'chat-api'}
                    onClick={() => {
                      setBackend('chat-api')
                      haptic('tap')
                    }}
                    label="Chat"
                  />
                </div>
              )}

              {/* -- Chat API config -- */}
              {backend === 'chat-api' ? (
                <div className="space-y-3 px-1.5 py-1">
                  <div className="space-y-2">
                    <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">
                      Connection
                    </div>
                    <select
                      value={chatConnectionId}
                      onChange={e => setChatConnectionId(e.target.value)}
                      className="w-full bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                    >
                      <option value="">Select connection...</option>
                      {chatConnections
                        .filter(a => a.enabled)
                        .map(a => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <LaunchConfigFields
                    value={fieldsValue}
                    onChange={applyFieldsPatch}
                    show={{ name: true, description: true }}
                  />
                </div>
              ) : (
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
                          ? 'bg-primary/15 text-primary border border-primary/30'
                          : 'text-comment hover:text-muted-foreground',
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
                          ? 'bg-primary/15 text-primary border border-primary/30'
                          : 'text-comment hover:text-muted-foreground',
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
                          title="Bare conversation"
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

                        {/* Resume existing CC session */}
                        <ResumeSessionField
                          resumeId={resumeId}
                          onResumeIdChange={setResumeId}
                          cwd={state.options?.path || ''}
                          sentinel={state.options?.sentinel}
                        />

                        {/* Env vars (LaunchConfigFields renders textarea + inline errors) */}
                        <LaunchConfigFields value={fieldsValue} onChange={applyFieldsPatch} show={{ env: true }} />
                        <div className="text-[9px] text-comment">
                          KEY=value per line, set before executing claude. # comments ok.
                        </div>

                        {/* Save / Reset defaults */}
                        <div className="flex items-center gap-3 pt-1">
                          <button
                            type="button"
                            onClick={handleSaveProjectDefaults}
                            className="text-[10px] font-mono text-primary/70 hover:text-primary transition-colors"
                          >
                            {savedFeedback === 'project' ? 'Saved!' : 'Save for project'}
                          </button>
                          <span className="text-border">|</span>
                          <button
                            type="button"
                            onClick={handleSaveGlobalDefaults}
                            className="text-[10px] font-mono text-comment hover:text-muted-foreground transition-colors"
                          >
                            {savedFeedback === 'global' ? 'Saved!' : 'Save globally'}
                          </button>
                          <span className="text-border">|</span>
                          <button
                            type="button"
                            onClick={handleResetDefaults}
                            className="text-[10px] font-mono text-comment hover:text-red-400 transition-colors"
                          >
                            Reset
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          <LaunchDialogBottom
            phase={phase}
            steps={progress.steps}
            displayError={displayError}
            copied={progress.copied}
            onCopyLog={handleCopyLog}
            onClose={handleClose}
            onAction={handleSpawn}
            actionLabel="Spawn"
            actionColorClass="bg-primary text-background hover:bg-primary/90"
            isConnected={progress.isConnected}
            isComplete={progress.isComplete}
            hasError={progress.hasError}
            viewCountdown={progress.viewCountdown}
            onViewConversation={() => {
              progress.setViewCountdown(null)
              handleViewConversation()
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Resume Session Field ──────────────────────────────────────────────

function ResumeSessionField({
  resumeId,
  onResumeIdChange,
  cwd,
  sentinel,
}: {
  resumeId: string
  onResumeIdChange: (id: string) => void
  cwd: string
  sentinel?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [sessions, setSessions] = useState<CcSessionEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleToggle() {
    const next = !expanded
    setExpanded(next)
    if (next && sessions.length === 0 && !loading) fetchSessions()
  }

  function fetchSessions() {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ cwd })
    if (sentinel) params.set('sentinel', sentinel)
    fetch(`/api/cc-sessions?${params}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) setError(data.error)
        else setSessions(data.sessions || [])
      })
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false))
  }

  function formatAge(mtime: number): string {
    const diff = Date.now() - mtime
    const mins = Math.floor(diff / 60_000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronDown className={cn('w-3 h-3 transition-transform', !expanded && '-rotate-90')} />
        Resume CC session
        {resumeId.trim() && <span className="text-amber-400/80 ml-1">(set)</span>}
      </button>

      {expanded && (
        <div className="space-y-1.5 pl-4">
          <input
            type="text"
            value={resumeId}
            onChange={e => onResumeIdChange(e.target.value)}
            placeholder="CC session ID"
            className="w-full bg-surface-inset border border-border rounded px-2 py-1.5 text-[11px] font-mono text-foreground placeholder:text-comment/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          {resumeId.trim() && (
            <div className="text-[9px] text-amber-400/80">
              Will pass --resume to CC. Fails if session ID is invalid.
            </div>
          )}

          {loading && <div className="text-[9px] font-mono text-comment">Loading sessions...</div>}
          {error && <div className="text-[9px] font-mono text-red-400">{error}</div>}

          {sessions.length > 0 && (
            <div className="max-h-[160px] overflow-y-auto border border-border rounded">
              {sessions.map(s => (
                <button
                  key={s.ccSessionId}
                  type="button"
                  onClick={() => {
                    onResumeIdChange(s.ccSessionId)
                    haptic('tap')
                  }}
                  className={cn(
                    'w-full text-left px-2 py-1.5 text-[10px] font-mono border-b border-border last:border-b-0 transition-colors',
                    resumeId === s.ccSessionId
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-surface-inset hover:text-foreground',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{s.title || s.ccSessionId.slice(0, 8)}</span>
                    <span className="text-[9px] text-comment shrink-0">
                      {formatAge(s.mtime)} / {formatSize(s.sizeBytes)}
                    </span>
                  </div>
                  <div className="text-[9px] text-comment truncate">{s.ccSessionId}</div>
                </button>
              ))}
            </div>
          )}

          {!loading && !error && sessions.length === 0 && expanded && (
            <div className="text-[9px] font-mono text-comment">No CC sessions found for this path.</div>
          )}
        </div>
      )}
    </div>
  )
}
