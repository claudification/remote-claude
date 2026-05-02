/**
 * Revive Dialog - Pre-revive configuration + launch monitor.
 *
 * Mirrors SpawnDialog (two-phase config -> launching) but for reviving an
 * ended conversations. Only the minimal overrides are exposed (mode + model +
 * effort) -- everything else (permissionMode, bare, repl, worktree, env,
 * autocompact, budget) is inherited from the conversation's stored launch config
 * and project/global defaults. See `reviveConversation` handler in
 * `src/broker/handlers/control-panel-actions.ts` for the resolution chain.
 */

import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { TogglePill } from '@/components/ui/toggle-pill'
import { reviveConversation, useConversationsStore } from '@/hooks/use-conversations'
import { useLaunchProgress } from '@/hooks/use-launch-progress'
import { useKeyLayer } from '@/lib/key-layers'
import { projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { LaunchConfigFields, type LaunchFieldsValue } from './launch-config-fields'
import { LaunchErrorBanner, LaunchFooterActions, LaunchStepList } from './launch-monitor'

interface ReviveDialogOptions {
  conversationId: string
}

interface ReviveDialogState {
  open: boolean
  options: ReviveDialogOptions | null
}

let _openDialog: ((options: ReviveDialogOptions) => void) | null = null

/** Open the revive dialog from anywhere */
export function openReviveDialog(options: ReviveDialogOptions): void {
  _openDialog?.(options)
}

export function ReviveDialog() {
  const [state, setState] = useState<ReviveDialogState>({ open: false, options: null })
  const [headless, setHeadless] = useState(true)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [phase, setPhase] = useState<'config' | 'launching'>('config')
  const [jobId, setJobId] = useState<string | null>(null)
  const [conversationId, setWrapperId] = useState<string | null>(null)
  const sessionAtReviveRef = useRef<string | null>(null)

  const sessionsById = useConversationsStore(s => s.sessionsById)
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const globalSettings = useConversationsStore(s => s.globalSettings)

  const session = state.options ? sessionsById[state.options.conversationId] : undefined

  const progress = useLaunchProgress({
    jobId,
    conversationId,
    timeoutMs: 30_000,
    enabled: phase === 'launching',
    onTimeout: () => {
      progress.setSteps(prev =>
        prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: 'timed out' } : s)),
      )
    },
  })

  const progressReset = progress.reset
  useEffect(() => {
    _openDialog = (options: ReviveDialogOptions) => {
      const sess = useConversationsStore.getState().sessionsById[options.conversationId]
      const ps = sess ? projectSettings[sess.project] : undefined
      const gs = globalSettings as Record<string, unknown>
      const lc = sess?.launchConfig

      // Resolution chain matches the server handler: launch config > project > global.
      const lcMode = lc ? (lc.headless ? 'headless' : 'pty') : undefined
      const defaultMode = lcMode || ps?.defaultLaunchMode || (gs.defaultLaunchMode as string) || 'headless'
      setHeadless(defaultMode !== 'pty')

      const defaultModel = lc?.model || ps?.defaultModel || (gs.defaultModel as string) || ''
      setModel(defaultModel)

      const defaultEffortRaw = lc?.effort || ps?.defaultEffort || (gs.defaultEffort as string) || ''
      setEffort(defaultEffortRaw === 'default' ? '' : defaultEffortRaw)

      setPhase('config')
      setJobId(null)
      setWrapperId(null)
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
        detail: (progress.launch.conversationId || progress.spawnedConversation?.id || '').slice(0, 8),
      },
    ])
  }, [progress.isConnected, progress.launch.conversationId, progress.spawnedConversation?.id])

  // Auto-redirect when countdown reaches 0
  useEffect(() => {
    if (progress.viewCountdown !== 0) return
    handleClose()
  }, [progress.viewCountdown]) // eslint-disable-line react-hooks/exhaustive-deps

  // Legacy agent events -- keep the listeners from the old ReviveMonitor for
  // backwards compat with older agents that don't emit launch channel events.
  useEffect(() => {
    function handleAck(e: Event) {
      const detail = (e as CustomEvent).detail
      if (!detail) return
      if (detail.ok === false) {
        progress.setError(detail.error || 'Revive rejected')
        progress.setSteps(prev =>
          prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: detail.error } : s)),
        )
        return
      }
      const wid = detail.conversationId as string
      setWrapperId(wid)
      progress.setSteps(prev => [
        ...prev.map(s =>
          s.status === 'active'
            ? { ...s, status: 'done' as const, detail: detail.name ? `${detail.name}` : `wrapper=${wid?.slice(0, 8)}` }
            : s,
        ),
        { label: 'Sentinel processing...', status: 'active', ts: Date.now() },
      ])
    }
    window.addEventListener('revive-session-result', handleAck)
    return () => window.removeEventListener('revive-session-result', handleAck)
  }, [progress.setError, progress.setSteps])

  const handleClose = useCallback(() => {
    addedConnectedStepRef.current = false
    const currentId = useConversationsStore.getState().selectedConversationId
    const userNavigatedAway = currentId !== sessionAtReviveRef.current && currentId !== null
    const sid =
      progress.launch.conversationId ||
      (progress.spawnedConversation && progress.spawnedConversation.status !== 'ended'
        ? progress.spawnedConversation.id
        : null)

    if (sid && !userNavigatedAway) {
      useConversationsStore.getState().selectConversation(sid, 'revive-dialog-close')
    }
    setState({ open: false, options: null })
    setJobId(null)
  }, [progress.launch.conversationId, progress.spawnedConversation])

  const handleViewConversation = useCallback(() => {
    const sid = progress.launch.conversationId || progress.spawnedConversation?.id
    if (sid) useConversationsStore.getState().selectConversation(sid, 'revive-dialog-view-session')
    progress.setViewCountdown(null)
    setState({ open: false, options: null })
    setJobId(null)
  }, [progress.launch.conversationId, progress.spawnedConversation, progress.setViewCountdown])

  const handleRevive = useCallback(() => {
    if (!state.options || phase !== 'config' || !session) return

    setPhase('launching')
    sessionAtReviveRef.current = useConversationsStore.getState().selectedConversationId
    haptic('tap')

    const newJobId = crypto.randomUUID()
    setJobId(newJobId)
    progress.start([{ label: 'Sending revive request...', status: 'active', ts: Date.now() }])

    const sent = reviveConversation(state.options.conversationId, {
      headless,
      jobId: newJobId,
      model: model || undefined,
      effort: effort || undefined,
    })

    if (!sent) {
      progress.setError('WebSocket not connected')
      progress.setSteps(prev =>
        prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: 'WS disconnected' } : s)),
      )
      haptic('error')
    }
  }, [state.options, phase, session, headless, model, effort, progress])

  // Keyboard layer: Enter revives (config) or views session (launching).
  // h/p = Headless/PTY (config only).
  useKeyLayer(
    {
      Enter: () => {
        if (phase === 'config') handleRevive()
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
    },
    { id: 'revive-dialog', enabled: state.open },
  )

  function applyFieldsPatch(patch: Partial<LaunchFieldsValue>) {
    if ('model' in patch) setModel(patch.model ?? '')
    if ('effort' in patch) setEffort(patch.effort ?? '')
  }

  function handleCopyLog() {
    const log = [
      '=== rclaude revive log ===',
      `Time: ${new Date().toISOString()}`,
      `Session: ${state.options?.conversationId ?? 'n/a'}${session?.title ? ` (${session.title})` : ''}`,
      `Project: ${session?.project ?? 'n/a'}`,
      `Wrapper: ${conversationId || 'n/a'}`,
      `Job: ${jobId || 'n/a'}`,
      `Headless: ${headless}`,
      `Model: ${model || '(inherited)'}`,
      `Effort: ${effort || '(inherited)'}`,
      '',
      'Steps:',
      ...progress.steps.map(s => {
        const icon =
          s.status === 'done' ? '[OK]' : s.status === 'error' ? '[FAIL]' : s.status === 'active' ? '[...]' : '[ ]'
        return `  ${icon} ${s.label}${s.detail ? ` -- ${s.detail}` : ''}`
      }),
      '',
      `Error: ${progress.error || progress.launch.error || 'none'}`,
      `Elapsed: ${progress.elapsed}s`,
    ].join('\n')
    progress.copyToClipboard(log)
  }

  const shortPath = (session ? projectPath(session.project) : '').replace(/^\/Users\/[^/]+/, '~')
  const displayError = progress.error || progress.launch.error
  const titleLabel = session?.title || session?.agentName || shortPath

  const fieldsValue: LaunchFieldsValue = { model, effort }

  return (
    <Dialog open={state.open} onOpenChange={open => !open && handleClose()}>
      <DialogContent className="max-w-md rounded-lg">
        <div className="p-5 flex flex-col gap-4 min-h-0 max-h-[calc(85vh-2rem)]">
          <div className="flex items-center justify-between shrink-0">
            <DialogTitle className="text-sm font-bold font-mono flex items-center gap-2">
              {phase === 'launching' && <RefreshCw className="w-4 h-4 text-emerald-400" />}
              {phase === 'config'
                ? 'REVIVE SESSION'
                : progress.isConnected
                  ? 'SESSION CONNECTED'
                  : progress.hasError
                    ? 'REVIVE FAILED'
                    : 'REVIVING...'}
            </DialogTitle>
            {phase === 'launching' && (
              <span className="text-[10px] font-mono text-muted-foreground/60 tabular-nums">{progress.elapsed}s</span>
            )}
          </div>

          {/* Session display */}
          <div className="shrink-0 space-y-0.5">
            {titleLabel && <div className="text-[11px] font-mono text-foreground truncate">{titleLabel}</div>}
            <div className="text-[10px] font-mono text-muted-foreground/60 truncate">{shortPath}</div>
          </div>

          {/* Config Phase */}
          {phase === 'config' && (
            <div className="overflow-y-auto flex-1 min-h-0 space-y-4 px-1.5 py-1">
              {/* Mode toggle */}
              <div className="space-y-2">
                <div className="text-[11px] font-mono text-muted-foreground uppercase tracking-wide pl-0.5">Mode</div>
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
                show={{ model: true, effort: true }}
              />

              <div className="text-[9px] text-[#565f89] leading-snug">
                Other settings (permission mode, env, budget, worktree, etc.) are restored from the original launch
                config. Spawn a new session to change them.
              </div>
            </div>
          )}

          {/* Launching Phase */}
          {phase === 'launching' && (
            <div className="space-y-3">
              <LaunchStepList steps={progress.steps} />
            </div>
          )}

          {displayError && (
            <div className="shrink-0">
              <LaunchErrorBanner error={displayError} copied={progress.copied} onCopy={handleCopyLog} />
            </div>
          )}

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
                  onClick={handleRevive}
                  className={cn(
                    'flex-1 px-4 py-2 rounded text-sm font-mono font-bold',
                    'bg-emerald-500 text-[#1a1b26] hover:bg-emerald-500/90',
                    'transition-colors',
                    'flex items-center justify-center gap-2',
                  )}
                >
                  Revive
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
                onViewConversation={() => {
                  progress.setViewCountdown(null)
                  handleViewConversation()
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
