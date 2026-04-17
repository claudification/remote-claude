/**
 * useLaunchChannel - Request-scoped event channel for spawn/revive progress.
 *
 * Usage:
 *   const { events, completed, failed, error, sessionId } = useLaunchChannel(jobId)
 *
 * The hook subscribes to the job on mount (when jobId is set) and unsubscribes on
 * unmount or jobId change. Events arrive via CustomEvent dispatch from use-websocket.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { wsSend } from './use-sessions'

export interface LaunchEvent {
  step: string
  status: 'info' | 'ok' | 'error'
  detail?: string
  t: number
}

interface LaunchChannelState {
  events: LaunchEvent[]
  completed: boolean
  failed: boolean
  error: string | null
  sessionId: string | null
  wrapperId: string | null
}

const INITIAL_STATE: LaunchChannelState = {
  events: [],
  completed: false,
  failed: false,
  error: null,
  sessionId: null,
  wrapperId: null,
}

export function useLaunchChannel(jobId: string | null): LaunchChannelState {
  const [state, setState] = useState<LaunchChannelState>(INITIAL_STATE)
  const subscribedRef = useRef<string | null>(null)

  // Subscribe/unsubscribe to job
  useEffect(() => {
    if (!jobId) {
      setState(INITIAL_STATE)
      return
    }

    // Subscribe to this job
    wsSend('subscribe_job', { jobId })
    subscribedRef.current = jobId

    // Reset state for new job
    setState({ ...INITIAL_STATE })

    return () => {
      // Unsubscribe on cleanup
      if (subscribedRef.current) {
        wsSend('unsubscribe_job', { jobId: subscribedRef.current })
        subscribedRef.current = null
      }
    }
  }, [jobId])

  // Listen for events
  const handleEvent = useCallback(
    (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!detail || !jobId) return
      if (detail.jobId !== jobId) return

      switch (detail.type) {
        case 'launch_log':
          setState(prev => ({
            ...prev,
            events: [
              ...prev.events,
              {
                step: detail.step,
                status: detail.status,
                detail: detail.detail,
                t: detail.t || Date.now(),
              },
            ],
          }))
          break

        case 'launch_progress': {
          const uiStatus: LaunchEvent['status'] =
            detail.status === 'done' ? 'ok' : detail.status === 'error' ? 'error' : 'info'
          setState(prev => ({
            ...prev,
            events: [
              ...prev.events,
              {
                step: detail.step,
                status: uiStatus,
                detail: detail.detail,
                t: detail.t || Date.now(),
              },
            ],
            wrapperId: detail.wrapperId || prev.wrapperId,
            sessionId: detail.sessionId || prev.sessionId,
          }))
          break
        }

        case 'job_complete':
          setState(prev => ({
            ...prev,
            completed: true,
            sessionId: detail.sessionId,
            wrapperId: detail.wrapperId,
          }))
          break

        case 'job_failed':
          setState(prev => ({
            ...prev,
            failed: true,
            error: detail.error || 'Launch failed',
          }))
          break
      }
    },
    [jobId],
  )

  useEffect(() => {
    window.addEventListener('launch-job-event', handleEvent)
    return () => window.removeEventListener('launch-job-event', handleEvent)
  }, [handleEvent])

  return state
}
