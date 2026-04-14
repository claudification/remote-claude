/**
 * ReviveMonitor - Launch monitor for session revive flow.
 * Uses the launch job channel for request-scoped progress events.
 * Falls back to legacy CustomEvent flow for backwards compatibility.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLaunchChannel } from '@/hooks/use-launch-channel'
import { reviveSession, useSessionsStore } from '@/hooks/use-sessions'
import { haptic } from '@/lib/utils'
import { LaunchMonitor, type LaunchStep } from './launch-monitor'

interface ReviveMonitorProps {
  sessionId: string
  sessionTitle?: string
  cwd: string
  headless?: boolean
  onClose: () => void
}

export function ReviveMonitor({ sessionId, sessionTitle, cwd, headless, onClose }: ReviveMonitorProps) {
  const [steps, setSteps] = useState<LaunchStep[]>([])
  const [wrapperId, setWrapperId] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorLog, setErrorLog] = useState<string | null>(null)
  const startedRef = useRef(false)

  // Launch channel - request-scoped events from agent
  const launch = useLaunchChannel(jobId)

  // Track the spawned session by wrapperId
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

  // Convert launch channel events to steps
  useEffect(() => {
    if (launch.events.length === 0) return

    setSteps(prev => {
      const updated = [...prev]
      // Mark "Agent processing..." as done when we get agent events
      const agentStep = updated.find(s => s.label === 'Agent processing...')
      if (agentStep && agentStep.status === 'active' && launch.events.length > 0) {
        agentStep.status = 'done'
        agentStep.detail = 'received'
      }
      // Add agent events as steps (avoid duplicates)
      const existingLabels = new Set(updated.map(s => s.label))
      for (const evt of launch.events) {
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
  }, [launch.events])

  // Handle job completion
  useEffect(() => {
    if (launch.completed) {
      haptic('success')
      setSteps(prev => {
        const updated = prev.map(s => (s.status === 'active' ? { ...s, status: 'done' as const } : s))
        updated.push({
          label: 'Session connected',
          status: 'done',
          ts: Date.now(),
          detail: launch.sessionId?.slice(0, 8),
        })
        return updated
      })
    }
  }, [launch.completed, launch.sessionId])

  // Handle job failure
  useEffect(() => {
    if (launch.failed) {
      haptic('error')
      setError(launch.error || 'Launch failed')
      setSteps(prev =>
        prev.map(s =>
          s.status === 'active' ? { ...s, status: 'error' as const, detail: launch.error || 'failed' } : s,
        ),
      )
    }
  }, [launch.failed, launch.error])

  // Auto-select the new session when it connects (via Zustand fallback)
  useEffect(() => {
    if (spawnedSession && spawnedSession.status !== 'ended' && !launch.completed) {
      setSteps(prev => {
        const updated = [...prev]
        const connecting = updated.find(s => s.label === 'Session connecting...')
        if (connecting && connecting.status === 'active') {
          connecting.status = 'done'
          connecting.detail = spawnedSession.id.slice(0, 8)
          updated.push({ label: 'Session active', status: 'done', ts: Date.now() })
        }
        return updated
      })
    }
  }, [spawnedSession, launch.completed])

  // Trigger revive on mount (once)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    // Generate jobId and subscribe before sending the revive
    const newJobId = crypto.randomUUID()
    setJobId(newJobId)

    // Small delay to ensure subscription is registered before the revive fires
    requestAnimationFrame(() => {
      setSteps([{ label: 'Sending revive request...', status: 'active', ts: Date.now() }])
      haptic('tap')

      const sent = reviveSession(sessionId, headless, newJobId)
      if (!sent) {
        setError('WebSocket not connected')
        setSteps(prev =>
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
        setError(detail.error || 'Revive rejected')
        setSteps(prev =>
          prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: detail.error } : s)),
        )
        return
      }

      const wid = detail.wrapperId as string
      setWrapperId(wid)
      setSteps(prev => [
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
      if (launch.events.length > 0) return

      if (detail.success) {
        haptic('success')
        setSteps(prev => [
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
        setError(errMsg)
        setSteps(prev =>
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
            ...launch.events.map(e => `  [${e.status}] ${e.step}${e.detail ? ` -- ${e.detail}` : ''}`),
            '',
            'Agent result:',
            JSON.stringify(detail, null, 2),
          ].join('\n'),
        )
      }
    }

    window.addEventListener('revive-agent-result', handleAgentResult)
    return () => window.removeEventListener('revive-agent-result', handleAgentResult)
  }, [wrapperId, sessionId, sessionTitle, cwd, headless, jobId, launch.events])

  function handleTimeout() {
    setError('Session failed to connect within 30s')
    setSteps(prev =>
      prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: 'Timed out (30s)' } : s)),
    )
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
        ...launch.events.map(e => `  [${e.status}] ${e.step}${e.detail ? ` -- ${e.detail}` : ''}`),
        '',
        'Diagnostic hints:',
        `  - Check: docker compose logs concentrator | grep ${wrapperId?.slice(0, 8) || sessionId.slice(0, 8)}`,
        '  - Check: .rclaude/settings/headless-*.ndjsonl for crash logs',
        '  - Check: /tmp/concentrator-launch-log.log for shell script output',
      ].join('\n'),
    )
  }

  function handleClose() {
    // If session connected, auto-select it
    const sid = launch.sessionId || (spawnedSession && spawnedSession.status !== 'ended' ? spawnedSession.id : null)
    if (sid) {
      useSessionsStore.getState().selectSession(sid)
    }
    onClose()
  }

  return (
    <LaunchMonitor
      title="Reviving Session"
      subtitle={sessionTitle || cwd.split('/').pop()}
      wrapperId={launch.wrapperId || wrapperId}
      steps={steps}
      error={error}
      errorLog={errorLog}
      timeoutMs={30000}
      onTimeout={handleTimeout}
      onClose={handleClose}
      accentColor="teal"
    />
  )
}
