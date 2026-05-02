/**
 * useLaunchProgress - Shared hook for spawn/revive/task launch progress tracking.
 *
 * Encapsulates: launch channel subscription, session detection, elapsed timer,
 * timeout watchdog, auto-redirect countdown, amber-stuck step fix,
 * and optional auto-insertion of launch channel events as steps.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@/lib/types'
import { haptic } from '@/lib/utils'
import { useConversationsStore } from './use-conversations'
import { useLaunchChannel } from './use-launch-channel'

export type LaunchStep = {
  label: string
  status: 'pending' | 'active' | 'done' | 'error'
  detail?: string
  ts?: number
}

interface UseLaunchProgressOptions {
  /** Job ID for launch channel subscription */
  jobId: string | null
  /** Wrapper ID for session detection in store */
  conversationId: string | null
  /** Timeout in ms (default 30000) */
  timeoutMs?: number
  /** Auto-redirect countdown seconds after connection (default 3, null to disable) */
  autoRedirectSec?: number | null
  /** Auto-insert launch channel events as steps (default true) */
  autoInsertEvents?: boolean
  /** Whether monitoring is active (default true) */
  enabled?: boolean
  /** Called when timeout fires (after setting error state) */
  onTimeout?: () => void
}

export function useLaunchProgress({
  jobId,
  conversationId: externalWrapperId,
  timeoutMs = 30_000,
  autoRedirectSec = 3,
  autoInsertEvents = true,
  enabled = true,
  onTimeout,
}: UseLaunchProgressOptions) {
  const [steps, setSteps] = useState<LaunchStep[]>([])
  const [error, setError] = useState<string | null>(null)
  const [startTime, setStartTime] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [copied, setCopied] = useState(false)
  const [viewCountdown, setViewCountdown] = useState<number | null>(null)
  const connectedRef = useRef(false)
  const onTimeoutRef = useRef(onTimeout)
  onTimeoutRef.current = onTimeout

  const launch = useLaunchChannel(jobId)
  const effectiveWrapperId = launch.conversationId || externalWrapperId

  /** Initialize monitoring. Call when launching begins. */
  function start(initialSteps?: LaunchStep[]) {
    setStartTime(Date.now())
    setSteps(initialSteps || [])
    setError(null)
    setElapsed(0)
    setCopied(false)
    setViewCountdown(null)
    connectedRef.current = false
  }

  /** Clear all progress state without starting a new run. Call when re-entering
   *  a host UI (e.g. reopening a dialog) to drop stale error/steps from a
   *  previous launch. */
  function reset() {
    setSteps([])
    setError(null)
    setStartTime(0)
    setElapsed(0)
    setCopied(false)
    setViewCountdown(null)
    connectedRef.current = false
  }

  // Track spawned session by conversationId
  const spawnedConversation: Session | null = useConversationsStore(
    useCallback(
      state => {
        if (!effectiveWrapperId) return null
        return state.sessions.find(s => s.ccSessionIds?.includes(effectiveWrapperId)) || null
      },
      [effectiveWrapperId],
    ),
  )

  const isConnected = launch.completed || (spawnedConversation != null && spawnedConversation.status !== 'ended')
  const isRunning = spawnedConversation != null && spawnedConversation.status !== 'ended'
  const isComplete = spawnedConversation?.status === 'ended'
  const hasError = !!error || launch.failed

  // Elapsed timer - only runs when startTime is set
  useEffect(() => {
    if (!enabled || !startTime) return
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [enabled, startTime])

  // Amber-stuck fix: when session connects, resolve all prior active steps to done.
  // Uses connectedRef to fire exactly once.
  useEffect(() => {
    if (!isConnected || connectedRef.current) return
    connectedRef.current = true
    setSteps(prev => prev.map(s => (s.status === 'active' ? { ...s, status: 'done' } : s)))
  }, [isConnected])

  // Auto-insert launch channel events as steps (insert before "Waiting for session..." if present)
  useEffect(() => {
    if (!autoInsertEvents || launch.events.length === 0 || !enabled) return
    setSteps(prev => {
      const existingLabels = new Set(prev.map(s => s.label))
      const newSteps: LaunchStep[] = []
      for (const evt of launch.events) {
        if (existingLabels.has(evt.step)) continue
        newSteps.push({
          label: evt.step,
          status:
            evt.status === 'ok' ? 'done' : evt.status === 'error' ? 'error' : connectedRef.current ? 'done' : 'active',
          detail: evt.detail,
          ts: evt.t,
        })
      }
      if (newSteps.length === 0) return prev
      const updated = [...prev]
      const waitIdx = updated.findIndex(s => s.label.startsWith('Waiting for session'))
      const insertAt = waitIdx >= 0 ? waitIdx : updated.length
      updated.splice(insertAt, 0, ...newSteps)
      return updated
    })
  }, [launch.events, enabled, autoInsertEvents])

  // Launch channel failure -> set error + mark active steps
  useEffect(() => {
    if (!launch.failed) return
    setError(launch.error || 'Launch failed')
    setSteps(prev =>
      prev.map(s => (s.status === 'active' ? { ...s, status: 'error' as const, detail: launch.error || 'failed' } : s)),
    )
  }, [launch.failed, launch.error])

  // Timeout watchdog
  useEffect(() => {
    if (!enabled || !effectiveWrapperId || isConnected || hasError || !startTime) return
    const timer = setInterval(() => {
      if (Date.now() - startTime > timeoutMs && !spawnedConversation) {
        const sec = Math.round(timeoutMs / 1000)
        setSteps(prev =>
          prev.map(s =>
            s.status === 'active' ? { ...s, status: 'error' as const, detail: `Timed out (${sec}s)` } : s,
          ),
        )
        setError(`Session failed to connect within ${sec}s`)
        clearInterval(timer)
        onTimeoutRef.current?.()
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [enabled, effectiveWrapperId, isConnected, hasError, timeoutMs, spawnedConversation, startTime])

  // Auto-redirect countdown - starts when session connects
  useEffect(() => {
    if (!isConnected || viewCountdown !== null || autoRedirectSec == null) return
    setViewCountdown(autoRedirectSec)
  }, [isConnected, viewCountdown, autoRedirectSec])

  useEffect(() => {
    if (viewCountdown === null || viewCountdown <= 0) return
    const timer = globalThis.setTimeout(() => setViewCountdown(prev => (prev !== null ? prev - 1 : null)), 1000)
    return () => globalThis.clearTimeout(timer)
  }, [viewCountdown])

  // Copy to clipboard with fallback
  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    haptic('success')
    globalThis.setTimeout(() => setCopied(false), 2000)
  }

  return {
    // State
    steps,
    error,
    elapsed,
    spawnedConversation,
    isConnected,
    isRunning,
    isComplete,
    hasError,
    viewCountdown,
    launch,
    copied,
    startTime,
    // Mutations
    start,
    reset,
    setSteps,
    setError,
    setViewCountdown,
    copyToClipboard,
  }
}
