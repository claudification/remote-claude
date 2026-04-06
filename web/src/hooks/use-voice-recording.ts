/**
 * useVoiceRecording - Shared voice recording hook.
 *
 * Handles mic access, MediaRecorder, WS streaming to Deepgram via concentrator,
 * transcript parsing, and refinement flow. Used by voice-fab (mobile),
 * voice-key (desktop push-to-talk), and voice-overlay (input bar mic button).
 *
 * Based on the voice-fab implementation (gold standard with yellow uncertain words).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'

export type VoiceState = 'idle' | 'connecting' | 'recording' | 'refining' | 'submitting' | 'error'

export interface UseVoiceRecordingResult {
  state: VoiceState
  interimText: string
  finalText: string
  refinedText: string
  errorMsg: string
  /** Request mic + start recording + start streaming to Deepgram */
  start: () => Promise<void>
  /** Stop recording, trigger refinement, return final text */
  stop: () => void
  /** Cancel recording, discard everything */
  cancel: () => void
  /** Reset to idle (call after consuming the result) */
  reset: () => void
}

export function useVoiceRecording(): UseVoiceRecordingResult {
  const [state, setState] = useState<VoiceState>('idle')
  const [interimText, setInterimText] = useState('')
  const [finalText, setFinalText] = useState('')
  const [refinedText, setRefinedText] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  const stateRef = useRef<VoiceState>('idle')
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const wsListenerRef = useRef<((event: MessageEvent) => void) | null>(null)
  const cancelledRef = useRef(false)
  const pendingStopRef = useRef(false) // user released key while still connecting
  const utteranceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  stateRef.current = state

  const sendWs = useCallback((msg: Record<string, unknown>) => {
    useSessionsStore.getState().sendWsMessage(msg)
  }, [])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      cleanup()
    }
  }, [])

  function cleanup() {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
    mediaRecorderRef.current = null
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop()
      streamRef.current = null
    }
    if (utteranceTimerRef.current) {
      clearTimeout(utteranceTimerRef.current)
      utteranceTimerRef.current = null
    }
    const ws = useSessionsStore.getState().ws
    if (ws && wsListenerRef.current) {
      ws.removeEventListener('message', wsListenerRef.current)
      wsListenerRef.current = null
    }
  }

  function attachWsListener(onDone?: (text: string) => void) {
    const ws = useSessionsStore.getState().ws
    if (!ws) {
      setErrorMsg('WebSocket not connected')
      setState('error')
      return
    }

    if (wsListenerRef.current) {
      ws.removeEventListener('message', wsListenerRef.current)
    }

    function handleMessage(event: MessageEvent) {
      try {
        const msg = JSON.parse(event.data)
        if (cancelledRef.current) return

        switch (msg.type) {
          case 'voice_ready':
            setState('recording')
            break
          case 'voice_transcript':
            if (msg.isFinal) {
              setFinalText(msg.accumulated || msg.transcript || '')
              setInterimText('')
            } else {
              setInterimText(msg.transcript || '')
            }
            if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current)
            break
          case 'voice_utterance_end':
            // Caller decides whether to auto-stop on utterance end
            break
          case 'voice_refining':
            setState('refining')
            break
          case 'voice_done': {
            const text = msg.refined || msg.raw || ''
            setRefinedText(text)
            setState('submitting')
            onDone?.(text)
            break
          }
          case 'voice_error':
            console.error('[voice] Server error:', msg.error)
            setErrorMsg(msg.error || 'Voice error')
            setState('error')
            break
        }
      } catch {}
    }

    ws.addEventListener('message', handleMessage)
    wsListenerRef.current = handleMessage
  }

  const reset = useCallback(() => {
    cleanup()
    setState('idle')
    setInterimText('')
    setFinalText('')
    setRefinedText('')
    setErrorMsg('')
    cancelledRef.current = false
    pendingStopRef.current = false
  }, [])

  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return

    cancelledRef.current = false
    pendingStopRef.current = false
    setInterimText('')
    setFinalText('')
    setRefinedText('')
    setErrorMsg('')
    setState('connecting')

    attachWsListener()

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

      if (cancelledRef.current) {
        for (const t of stream.getTracks()) t.stop()
        return
      }

      streamRef.current = stream

      const sessionId = useSessionsStore.getState().selectedSessionId
      sendWs({ type: 'voice_start', sessionId })

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4'
      const recorder = new MediaRecorder(stream, { mimeType })

      recorder.ondataavailable = async ev => {
        if (ev.data.size > 0) {
          const buffer = await ev.data.arrayBuffer()
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
          sendWs({ type: 'voice_data', audio: base64 })
        }
      }

      recorder.start(250)
      mediaRecorderRef.current = recorder
      setState('recording')

      // User released key during getUserMedia -- capture a brief moment then stop
      if (pendingStopRef.current) {
        pendingStopRef.current = false
        // Give recorder 300ms to capture at least one chunk before stopping
        setTimeout(() => stop(), 300)
      }
    } catch (err) {
      console.error('[voice] Recording failed:', err)
      setErrorMsg(err instanceof Error ? err.message : 'Mic access denied')
      setState('error')
    }
  }, [sendWs])

  const stop = useCallback(() => {
    if (stateRef.current === 'connecting') {
      // getUserMedia hasn't resolved yet. Set a flag so start() will
      // auto-stop after capturing whatever audio it can.
      pendingStopRef.current = true
      return
    }

    if (stateRef.current !== 'recording') return

    const recorder = mediaRecorderRef.current
    if (recorder?.state === 'recording') {
      // MediaRecorder.stop() fires one final ondataavailable with remaining buffer.
      // Wait for that last chunk before sending voice_stop so the server gets all audio.
      recorder.onstop = () => {
        mediaRecorderRef.current = null
        if (streamRef.current) {
          for (const t of streamRef.current.getTracks()) t.stop()
          streamRef.current = null
        }
        sendWs({ type: 'voice_stop' })
      }
      recorder.stop()
    } else {
      if (streamRef.current) {
        for (const t of streamRef.current.getTracks()) t.stop()
        streamRef.current = null
      }
      sendWs({ type: 'voice_stop' })
    }
    setState('refining')

    // Safety timeout: if stuck in refining for >10s, reset to idle
    // (handles cases where voice_done is lost, WS disconnects, etc.)
    setTimeout(() => {
      if (stateRef.current === 'refining') {
        console.warn('[voice] Stuck in refining for 10s, resetting')
        reset()
      }
    }, 10_000)
  }, [sendWs, reset])

  const cancel = useCallback(() => {
    cancelledRef.current = true
    sendWs({ type: 'voice_stop' })
    reset()
  }, [sendWs, reset])

  return {
    state,
    interimText,
    finalText,
    refinedText,
    errorMsg,
    start,
    stop,
    cancel,
    reset,
  }
}
