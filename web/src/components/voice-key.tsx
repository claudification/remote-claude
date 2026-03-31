/**
 * VoiceKey - Keyboard push-to-talk: hold configured key to record, release to submit.
 * Headless component (no UI) - just a global keydown/keyup listener.
 * Reuses the same voice WS protocol as voice-fab.tsx.
 */

import { useEffect, useRef } from 'react'
import { sendInput, useSessionsStore } from '@/hooks/use-sessions'

export function VoiceKey() {
  const voiceHoldKey = useSessionsStore(s => s.dashboardPrefs.voiceHoldKey)
  const recordingRef = useRef(false)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const wsListenerRef = useRef<((event: MessageEvent) => void) | null>(null)
  const finalTextRef = useRef('')
  const refinedTextRef = useRef('')

  useEffect(() => {
    if (!voiceHoldKey) return

    function sendWs(msg: Record<string, unknown>) {
      useSessionsStore.getState().sendWsMessage(msg)
    }

    function attachWsListener() {
      const ws = useSessionsStore.getState().ws
      if (!ws) return

      if (wsListenerRef.current) ws.removeEventListener('message', wsListenerRef.current)

      function handleMessage(event: MessageEvent) {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'voice_transcript') {
            if (msg.isFinal) finalTextRef.current = msg.text || ''
          } else if (msg.type === 'voice_refined') {
            refinedTextRef.current = msg.text || ''
          } else if (msg.type === 'voice_done') {
            const text = refinedTextRef.current || finalTextRef.current
            if (text.trim()) {
              const sessionId = useSessionsStore.getState().selectedSessionId
              if (sessionId) sendInput(sessionId, text)
            }
            cleanup()
          }
        } catch {
          /* ignore */
        }
      }

      wsListenerRef.current = handleMessage
      ws.addEventListener('message', handleMessage)
    }

    function cleanup() {
      recordingRef.current = false
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
      recorderRef.current = null
      if (streamRef.current) {
        for (const t of streamRef.current.getTracks()) t.stop()
        streamRef.current = null
      }
      const ws = useSessionsStore.getState().ws
      if (ws && wsListenerRef.current) {
        ws.removeEventListener('message', wsListenerRef.current)
        wsListenerRef.current = null
      }
      finalTextRef.current = ''
      refinedTextRef.current = ''
    }

    async function startRecording() {
      const sessionId = useSessionsStore.getState().selectedSessionId
      if (!sessionId) {
        console.log('[voice-key] No session selected, aborting')
        recordingRef.current = false
        return
      }
      console.log(`[voice-key] Starting recording for ${sessionId.slice(0, 8)}`)

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        // Check if key was released while we waited for mic
        if (!recordingRef.current) {
          for (const t of stream.getTracks()) t.stop()
          return
        }

        streamRef.current = stream
        attachWsListener()
        sendWs({ type: 'voice_start', sessionId })

        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/mp4'
        const recorder = new MediaRecorder(stream, { mimeType })

        recorder.ondataavailable = async ev => {
          if (ev.data.size > 0) {
            const buffer = await ev.data.arrayBuffer()
            const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
            sendWs({ type: 'voice_data', audio: base64 })
          }
        }

        recorder.start(250)
        recorderRef.current = recorder
      } catch (err) {
        console.error('[voice-key] Recording failed:', err)
        cleanup()
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.code !== voiceHoldKey) return
      if (e.repeat) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return

      e.preventDefault()
      console.log(
        `[voice-key] DOWN: ${e.code} (selected=${useSessionsStore.getState().selectedSessionId?.slice(0, 8)})`,
      )
      recordingRef.current = true
      startRecording()
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (e.code !== voiceHoldKey) return
      if (!recordingRef.current) {
        console.log(`[voice-key] UP: ${e.code} (not recording, ignoring)`)
        return
      }

      e.preventDefault()
      console.log(`[voice-key] UP: ${e.code} - stopping, recorder=${recorderRef.current?.state}`)
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
      recorderRef.current = null
      if (streamRef.current) {
        for (const t of streamRef.current.getTracks()) t.stop()
        streamRef.current = null
      }
      sendWs({ type: 'voice_stop' })
      recordingRef.current = false
      // voice_done WS message will trigger submit via the listener
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      cleanup()
    }
  }, [voiceHoldKey])

  return null // headless component
}
