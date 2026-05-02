/**
 * useVoiceRecording - Shared voice recording hook.
 *
 * Handles mic access, MediaRecorder, WS streaming to Deepgram via broker,
 * transcript parsing, and refinement flow. Used by voice-fab (mobile),
 * voice-key (desktop push-to-talk), and voice-overlay (input bar mic button).
 *
 * Mic stream is pre-warmed and cached between recordings (30s TTL) to
 * eliminate getUserMedia() latency on macOS (~2-3s cold, 0ms warm).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'

type VoiceState = 'idle' | 'connecting' | 'recording' | 'refining' | 'submitting' | 'error'

interface UseVoiceRecordingResult {
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

// ── Warm mic stream cache ────────────────────────────────────────────
// Survives across recording cycles. First start() acquires it (cold);
// subsequent starts reuse it instantly.
// - Normal mode: released after 30s of inactivity
// - keepMicOpen mode: released after 30min of inactivity + banner shown

const KEEP_MIC_IDLE_TTL = 30 * 60_000
let warmStream: MediaStream | null = null
let warmStreamTimer: ReturnType<typeof setTimeout> | null = null
let micExpiredFlag = false
const micExpiredListeners = new Set<() => void>()

function isStreamLive(stream: MediaStream | null): stream is MediaStream {
  if (!stream) return false
  const track = stream.getAudioTracks()[0]
  return !!track && track.readyState === 'live'
}

function setMicExpired(expired: boolean) {
  if (micExpiredFlag === expired) return
  micExpiredFlag = expired
  for (const fn of micExpiredListeners) fn()
}

export function subscribeMicExpired(fn: () => void): () => void {
  micExpiredListeners.add(fn)
  return () => micExpiredListeners.delete(fn)
}

export function getMicExpired() {
  return micExpiredFlag
}

export function dismissMicExpired() {
  setMicExpired(false)
}

function releaseWarmStream() {
  const wasKeepOpen = useConversationsStore.getState().controlPanelPrefs.keepMicOpen
  if (warmStream) {
    for (const t of warmStream.getTracks()) t.stop()
    warmStream = null
    console.log(`[voice] warm stream released (${wasKeepOpen ? '30min' : '30s'} idle timeout)`)
  }
  warmStreamTimer = null
  if (wasKeepOpen) setMicExpired(true)
}

function scheduleStreamRelease() {
  if (warmStreamTimer) clearTimeout(warmStreamTimer)
  const prefs = useConversationsStore.getState().controlPanelPrefs
  const ttl = prefs.keepMicOpen ? KEEP_MIC_IDLE_TTL : (prefs.voiceWarmStreamMs ?? 30_000)
  warmStreamTimer = setTimeout(releaseWarmStream, ttl)
  if (prefs.keepMicOpen) console.log('[voice] keepMicOpen: mic idle timer set (30min)')
}

function preferredDeviceId(): string {
  return useConversationsStore.getState().controlPanelPrefs.voiceDeviceId || ''
}

function micConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: {
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      ...(deviceId ? { deviceId } : {}),
    },
  }
}

/** Release the warm stream so the next recording picks up a new device. */
export function invalidateWarmStream() {
  if (warmStream) {
    for (const t of warmStream.getTracks()) t.stop()
    warmStream = null
  }
  if (warmStreamTimer) {
    clearTimeout(warmStreamTimer)
    warmStreamTimer = null
  }
}

/** Pre-warm the mic stream (fire-and-forget). Call on mount when keepMicOpen is enabled. */
export function prewarmMicStream() {
  setMicExpired(false)
  if (isStreamLive(warmStream)) return
  acquireMicStream().catch(err => console.warn('[voice] prewarm failed:', err))
}

async function acquireMicStream(): Promise<MediaStream> {
  if (warmStreamTimer) {
    clearTimeout(warmStreamTimer)
    warmStreamTimer = null
  }
  const wantDevice = preferredDeviceId()
  if (isStreamLive(warmStream)) {
    const activeDevice = warmStream.getAudioTracks()[0]?.getSettings().deviceId ?? ''
    if (!wantDevice || activeDevice === wantDevice) {
      console.log(`[voice] reusing warm stream (0ms, device=${activeDevice.slice(0, 8) || 'default'})`)
      return warmStream
    }
    console.log(
      `[voice] device mismatch (have=${activeDevice.slice(0, 8)}, want=${wantDevice.slice(0, 8)}), re-acquiring`,
    )
    for (const t of warmStream.getTracks()) t.stop()
    warmStream = null
  }
  const t0 = performance.now()
  const stream = await navigator.mediaDevices.getUserMedia(micConstraints(wantDevice))
  const ms = performance.now() - t0
  const gotDevice = stream.getAudioTracks()[0]?.getSettings().deviceId ?? 'unknown'
  console.log(`[voice] mic acquired in ${ms.toFixed(0)}ms (device=${gotDevice.slice(0, 8)})`)
  warmStream = stream
  return stream
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
  const pendingStopRef = useRef(false)
  const utteranceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingDataRef = useRef<Promise<void>>(Promise.resolve())
  const startTsRef = useRef(0)

  stateRef.current = state

  function elapsed() {
    return `+${(performance.now() - startTsRef.current).toFixed(0)}ms`
  }

  const sendWs = useCallback((msg: Record<string, unknown>) => {
    useConversationsStore.getState().sendWsMessage(msg)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup is a stable function defined in this scope, runs once on unmount
  useEffect(() => {
    return () => {
      cleanup()
      releaseWarmStream()
    }
  }, [])

  function cleanup() {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
    mediaRecorderRef.current = null
    streamRef.current = null
    scheduleStreamRelease()
    if (utteranceTimerRef.current) {
      clearTimeout(utteranceTimerRef.current)
      utteranceTimerRef.current = null
    }
    const ws = useConversationsStore.getState().ws
    if (ws && wsListenerRef.current) {
      ws.removeEventListener('message', wsListenerRef.current)
      wsListenerRef.current = null
    }
  }

  function attachWsListener(onDone?: (text: string) => void) {
    const ws = useConversationsStore.getState().ws
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
            console.log(
              `[voice] ${elapsed()} voice_ready (Deepgram connected, flushed ${msg.flushedChunks ?? '?'} chunks / ${msg.flushedBytes ?? '?'}B)`,
            )
            setState('recording')
            break
          case 'voice_transcript':
            if (msg.isFinal) {
              setFinalText(msg.accumulated || msg.transcript || '')
              setInterimText('')
            } else {
              setInterimText(msg.transcript || '')
            }
            break
          case 'voice_utterance_end':
            break
          case 'voice_refining':
            console.log(`[voice] ${elapsed()} refining...`)
            setState('refining')
            break
          case 'voice_done': {
            console.log(`[voice] ${elapsed()} done`)
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup is a stable function defined in this scope
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: attachWsListener and stop are stable functions defined in this scope
  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return

    startTsRef.current = performance.now()
    setMicExpired(false)
    console.log('[voice] start()')

    cancelledRef.current = false
    pendingStopRef.current = false
    setInterimText('')
    setFinalText('')
    setRefinedText('')
    setErrorMsg('')
    setState('connecting')

    attachWsListener()

    try {
      const stream = await acquireMicStream()
      console.log(`[voice] ${elapsed()} stream ready`)

      if (cancelledRef.current) {
        console.log(`[voice] ${elapsed()} cancelled during mic acquire`)
        scheduleStreamRelease()
        return
      }

      streamRef.current = stream

      const conversationId = useConversationsStore.getState().selectedConversationId
      sendWs({ type: 'voice_start', conversationId: conversationId })
      console.log(`[voice] ${elapsed()} voice_start sent`)

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4'
      const recorder = new MediaRecorder(stream, { mimeType })

      recorder.ondataavailable = ev => {
        if (ev.data.size > 0) {
          pendingDataRef.current = (async () => {
            const buffer = await ev.data.arrayBuffer()
            const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
            sendWs({ type: 'voice_data', audio: base64 })
          })()
        }
      }

      recorder.start(100)
      mediaRecorderRef.current = recorder
      console.log(`[voice] ${elapsed()} recorder started (${mimeType})`)
      setState('recording')

      if (pendingStopRef.current) {
        pendingStopRef.current = false
        setTimeout(() => stop(), 300)
      }
    } catch (err) {
      console.error(`[voice] ${elapsed()} recording failed:`, err)
      setErrorMsg(err instanceof Error ? err.message : 'Mic access denied')
      setState('error')
    }
  }, [sendWs])

  function doStop() {
    const recorder = mediaRecorderRef.current
    if (recorder?.state === 'recording') {
      recorder.onstop = async () => {
        await pendingDataRef.current
        mediaRecorderRef.current = null
        streamRef.current = null
        scheduleStreamRelease()
        sendWs({ type: 'voice_stop' })
        console.log(`[voice] ${elapsed()} voice_stop sent`)
      }
      recorder.stop()
    } else {
      streamRef.current = null
      scheduleStreamRelease()
      sendWs({ type: 'voice_stop' })
    }
    setState('refining')

    setTimeout(() => {
      if (stateRef.current === 'refining') {
        console.warn('[voice] Stuck in refining for 10s, resetting')
        reset()
      }
    }, 10_000)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: doStop is a stable function defined in this scope
  const stop = useCallback(() => {
    console.log(`[voice] ${elapsed()} stop() (state=${stateRef.current})`)

    if (stateRef.current === 'connecting') {
      pendingStopRef.current = true
      return
    }

    if (stateRef.current !== 'recording') return

    // Already lingering from a previous stop() call
    if (utteranceTimerRef.current) return

    const lingerMs = useSessionsStore.getState().controlPanelPrefs.voiceLingerMs ?? 0
    if (lingerMs > 0) {
      console.log(`[voice] ${elapsed()} lingering ${lingerMs}ms before stop`)
      utteranceTimerRef.current = setTimeout(() => {
        utteranceTimerRef.current = null
        doStop()
      }, lingerMs)
    } else {
      doStop()
    }
  }, [sendWs, reset])

  const cancel = useCallback(() => {
    console.log(`[voice] ${elapsed()} cancel()`)
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
