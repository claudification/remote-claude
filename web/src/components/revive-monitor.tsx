/**
 * ReviveMonitor - Launch monitor for session revive flow.
 * Uses useLaunchProgress for core monitoring + shared LaunchMonitor for rendering.
 * Keeps legacy CustomEvent listeners for backwards compatibility with older agents.
 */

import { useEffect, useRef, useState } from 'react'
import { useLaunchProgress } from '@/hooks/use-launch-progress'
import { reviveSession, useSessionsStore } from '@/hooks/use-sessions'
import { useKeyLayer } from '@/lib/key-layers'
import { haptic } from '@/lib/utils'
import { LaunchMonitor } from './launch-monitor'

interface ReviveMonitorProps {
  sessionId: string
  sessionTitle?: string
  cwd: string
  headless?: boolean
  onClose: () => void
}

export function ReviveMonitor({ sessionId, sessionTitle, cwd, headless, onClose }: ReviveMonitorProps) {
  const [jobId, setJobId] = useState<string | null>(null)
  const [wrapperId, setWrapperId] = useState<string | null>(null)
  const [errorLog, setErrorLog] = useState<string | null>(null)
  const startedRef = useRef(false)

  // Shared launch progress hook (manual event insertion for revive-specific flow)
  const progress = useLaunchProgress({
    jobId,
    wrapperId,
    timeoutMs: 30_000,
    autoInsertEvents: false,
    onTimeout: () => {
      setErrorLog(
        [
          '=== rclaude revive timeout log ===',
          `Time: ${new Date().toISOString()}`,
          `Session: ${sessionId}${sessionTitle ? ` (${sessionTitle})` : ''}`,
          `CWD: ${cwd}`,
          `Wrapper: ${wrapperId || 'n/a'}`,
          `Job: ${jobId || 'n/a'}`,
          `Headless: ${headless ?? 'default'}`,
          '',
          'Error: Timed out after 30s -- session never connected to concentrator.',
          '',
          'Agent events:',
          ...progress.launch.events.map(e => `  [${e.status}] ${e.step}${e.detail ? ` -- ${e.detail}` : ''}`),
          '',
          'Diagnostic hints:',
          `  - Check: docker compose logs concentrator | grep ${wrapperId?.slice(0, 8) || sessionId.slice(0, 8)}`,
          '  - Check: .rclaude/settings/headless-*.ndjsonl for crash logs',
          '  - Check: /tmp/concentrator-launch-log.log for shell script output',
        ].join('\n'),
      )
    },
  })

  useKeyLayer({ Escape: handleClose }, { id: 'revive-monitor' })

  // Convert launch channel events to steps (custom for revive flow)
  useEffect(() => {
    if (progress.launch.events.length === 0) return
    progress.setSteps(prev => {
      const updated = [...prev]
      // Mark "Agent processing..." as done when agent events arrive
      const agentStep = updated.find(s => s.label === 'Agent processing...')
      if (agentStep && agentStep.status === 'active' && progress.launch.events.length > 0) {
        agentStep.status = 'done'
        agentStep.detail = 'received'
      }
      // Add new agent events (dedup by label)
      const existingLabels = new Set(updated.map(s => s.label))
      for (const evt of progress.launch.events) {
        if (!existingLabels.has(evt.step)) {
          updated.push({
            label: evt.step,
            status: evt.status === 'ok' ? 'done' : evt.status === 'error' ? 'error' : 'active',
            detail: evt.detail,
            ts: evt.t,
          })
          existingLabels.add(evt.step)
        }
      }
      return updated
    })
  }, [progress.launch.events])

  // Handle job completion from launch channel
  useEffect(() => {
    if (!progress.launch.completed) return
    haptic('success')
    progress.setSteps(prev => {
      const updated = prev.map(s => (s.status === 'active' ? { ...s, status: 'done' as const } : s))
      updated.push({
        label: 'Session connected',
        status: 'done',
        ts: Date.now(),
        detail: progress.launch.sessionId?.slice(0, 8),
      })
      return updated
    })
  }, [progress.launch.completed, progress.launch.sessionId])

  // Auto-select session on connect (via Zustand fallback)
  useEffect(() => {
    if (progress.spawnedSession && progress.spawnedSession.status !== 'ended' && !progress.launch.completed) {
      progress.setSteps(prev => {
        const updated = [...prev]
        const connecting = updated.find(s => s.label === 'Session connecting...')
        if (connecting && connecting.status === 'active') {
          connecting.status = 'done'
          connecting.detail = progress.spawnedSession!.id.slice(0, 8)
          updated.push({ label: 'Session active', status: 'done', ts: Date.now() })
        }
        return updated
      })
    }
  }, [progress.spawnedSession, progress.launch.completed])

  // Trigger revive on mount (once)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const newJobId = crypto.randomUUID()
    setJobId(newJobId)

    // Small delay to ensure WS subscription is registered before the revive fires
    requestAnimationFrame(() => {
      progress.start([{ label: 'Sending revive request...', status: 'active', ts: Date.now() }])
      haptic('tap')

      const sent = reviveSession(sessionId, headless, newJobId)
      if (!sent) {
        progress.setError('WebSocket not connected')
        progress.setSteps(prev =>
          prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: 'WS disconnected' } : s)),
        )
      }
    })
  }, [sessionId, headless])

  // Listen for revive_session_result (concentrator ack with wrapperId) - legacy path
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

      const wid = detail.wrapperId as string
      setWrapperId(wid)
      progress.setSteps(prev => [
        ...prev.map(s =>
          s.status === 'active'
            ? { ...s, status: 'done' as const, detail: detail.name ? `${detail.name}` : `wrapper=${wid?.slice(0, 8)}` }
            : s,
        ),
        { label: 'Agent processing...', status: 'active', ts: Date.now() },
      ])
    }

    window.addEventListener('revive-session-result', handleAck)
    return () => window.removeEventListener('revive-session-result', handleAck)
  }, [])

  // Listen for revive_result (agent's actual result) - legacy fallback
  // Only used if launch channel doesn't provide the events
  useEffect(() => {
    function handleAgentResult(e: Event) {
      const detail = (e as CustomEvent).detail
      if (!detail) return
      if (wrapperId && detail.wrapperId !== wrapperId) return
      if (!wrapperId && detail.sessionId !== sessionId) return
      // Skip if we already have job channel events (they're more granular)
      if (progress.launch.events.length > 0) return

      if (detail.success) {
        haptic('success')
        progress.setSteps(prev => [
          ...prev.map(s =>
            s.label === 'Agent processing...'
              ? { ...s, status: 'done' as const, detail: detail.continued ? 'resumed' : 'fresh session' }
              : s,
          ),
          {
            label: 'Session connecting...',
            status: 'active' as const,
            ts: Date.now(),
            detail: detail.tmuxSession ? `tmux=${detail.tmuxSession}` : undefined,
          },
        ])
      } else {
        haptic('error')
        const errMsg = detail.error || 'Revive failed'
        progress.setError(errMsg)
        progress.setSteps(prev =>
          prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: errMsg } : s)),
        )
        setErrorLog(
          [
            '=== rclaude revive error log ===',
            `Time: ${new Date().toISOString()}`,
            `Session: ${sessionId}${sessionTitle ? ` (${sessionTitle})` : ''}`,
            `CWD: ${cwd}`,
            `Wrapper: ${wrapperId || 'n/a'}`,
            `Job: ${jobId || 'n/a'}`,
            `Headless: ${headless ?? 'default'}`,
            '',
            `Error: ${errMsg}`,
            '',
            'Agent events:',
            ...progress.launch.events.map(e => `  [${e.status}] ${e.step}${e.detail ? ` -- ${e.detail}` : ''}`),
            '',
            'Agent result:',
            JSON.stringify(detail, null, 2),
          ].join('\n'),
        )
      }
    }

    window.addEventListener('revive-agent-result', handleAgentResult)
    return () => window.removeEventListener('revive-agent-result', handleAgentResult)
  }, [wrapperId, sessionId, sessionTitle, cwd, headless, jobId, progress.launch.events])

  // Auto-redirect when countdown reaches 0
  useEffect(() => {
    if (progress.viewCountdown !== 0) return
    handleClose()
  }, [progress.viewCountdown]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleClose() {
    // If session connected, auto-select it (revive = user explicitly chose this session)
    const sid =
      progress.launch.sessionId ||
      (progress.spawnedSession && progress.spawnedSession.status !== 'ended' ? progress.spawnedSession.id : null)
    if (sid) {
      useSessionsStore.getState().selectSession(sid, 'revive-monitor-close')
    }
    onClose()
  }

  function handleViewSession() {
    const sid = progress.spawnedSession?.id
    if (sid) useSessionsStore.getState().selectSession(sid, 'revive-monitor-view')
    onClose()
  }

  function handleCopyLog() {
    if (errorLog) {
      progress.copyToClipboard(errorLog)
      return
    }
    const log = [
      '=== rclaude revive log ===',
      `Time: ${new Date().toISOString()}`,
      `Session: ${sessionId}${sessionTitle ? ` (${sessionTitle})` : ''}`,
      `CWD: ${cwd}`,
      `Wrapper: ${wrapperId || 'n/a'}`,
      `Job: ${jobId || 'n/a'}`,
      '',
      'Steps:',
      ...progress.steps.map(s => {
        const icon =
          s.status === 'done' ? '[OK]' : s.status === 'error' ? '[FAIL]' : s.status === 'active' ? '[...]' : '[ ]'
        return `  ${icon} ${s.label}${s.detail ? ` -- ${s.detail}` : ''}`
      }),
      '',
      `Error: ${progress.error || 'none'}`,
      `Elapsed: ${progress.elapsed}s`,
    ].join('\n')
    progress.copyToClipboard(log)
  }

  return (
    <LaunchMonitor
      title="Reviving Session"
      subtitle={sessionTitle || cwd.split('/').pop()}
      steps={progress.steps}
      error={progress.error}
      elapsed={progress.elapsed}
      isConnected={progress.isConnected}
      isComplete={progress.isComplete}
      hasError={progress.hasError}
      viewCountdown={progress.viewCountdown}
      copied={progress.copied}
      onCopyLog={handleCopyLog}
      onViewSession={handleViewSession}
      onClose={handleClose}
      accentColor="teal"
    />
  )
}
