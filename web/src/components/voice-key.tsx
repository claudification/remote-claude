/**
 * VoiceKey - Keyboard push-to-talk: hold configured key to record, release to submit.
 * Shows a recording indicator banner with live transcript.
 * Reuses the same voice WS protocol as voice-fab.tsx.
 */

import { Mic } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { sendInput, useSessionsStore } from '@/hooks/use-sessions'
import { cn } from '@/lib/utils'
import { formatKeyCode } from './settings-page'

type VoiceKeyState = 'idle' | 'recording' | 'refining' | 'submitting'

export function VoiceKey() {
  const voiceHoldKey = useSessionsStore(s => s.dashboardPrefs.voiceHoldKey)
  const [state, setState] = useState<VoiceKeyState>('idle')
  const [interimText, setInterimText] = useState('')
  const [finalText, setFinalText] = useState('')

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
            if (msg.isFinal) {
              finalTextRef.current = msg.accumulated || msg.transcript || ''
              setFinalText(msg.accumulated || msg.transcript || '')
              setInterimText('')
            } else {
              setInterimText(msg.transcript || '')
            }
          } else if (msg.type === 'voice_refining') {
            setState('refining')
          } else if (msg.type === 'voice_done') {
            const text = msg.refined || msg.raw || finalTextRef.current
            if (text.trim()) {
              setFinalText(text)
              setState('submitting')
              const sessionId = useSessionsStore.getState().selectedSessionId
              if (sessionId) sendInput(sessionId, text)
            }
            // Brief flash of submitting state, then cleanup
            setTimeout(() => {
              cleanup()
              setState('idle')
              setInterimText('')
              setFinalText('')
            }, 300)
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
        recordingRef.current = false
        return
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (!recordingRef.current) {
          for (const t of stream.getTracks()) t.stop()
          return
        }

        streamRef.current = stream
        attachWsListener()
        sendWs({ type: 'voice_start', sessionId })
        setState('recording')

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
        setState('idle')
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.code !== voiceHoldKey) return
      if (e.repeat) return
      if (recordingRef.current) return

      e.preventDefault()
      recordingRef.current = true
      setInterimText('')
      setFinalText('')
      startRecording()
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (e.code !== voiceHoldKey) return
      if (!recordingRef.current) return

      e.preventDefault()
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
      recorderRef.current = null
      if (streamRef.current) {
        for (const t of streamRef.current.getTracks()) t.stop()
        streamRef.current = null
      }
      sendWs({ type: 'voice_stop' })
      recordingRef.current = false
      setState('refining')
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      cleanup()
    }
  }, [voiceHoldKey])

  if (state === 'idle') return null

  const displayText = finalText || interimText
  const keyLabel = voiceHoldKey ? formatKeyCode(voiceHoldKey) : ''

  return (
    <div className="fixed top-0 left-0 right-0 z-[60] pointer-events-none">
      <div className="mx-auto max-w-[600px] px-4 pt-2 animate-in slide-in-from-top duration-200">
        <div className="px-4 py-2.5 rounded-xl backdrop-blur-xl bg-background/90 border border-border/50 shadow-lg">
          <div className="flex items-center gap-2">
            <span className={cn('relative flex h-3 w-3 shrink-0', state === 'recording' && 'animate-pulse')}>
              {state === 'recording' && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
              )}
              <span
                className={cn(
                  'relative inline-flex rounded-full h-3 w-3',
                  state === 'recording' && 'bg-red-500',
                  state === 'refining' && 'bg-amber-500',
                  state === 'submitting' && 'bg-green-500',
                )}
              />
            </span>

            {state === 'recording' && !displayText && (
              <span className="text-xs text-muted-foreground font-mono">
                <Mic className="w-3 h-3 inline mr-1" />
                Hold <kbd className="px-1 py-0.5 bg-muted border border-border rounded text-[10px]">{keyLabel}</kbd> to
                record
              </span>
            )}
            {state === 'recording' && displayText && <span className="text-sm text-foreground">{displayText}</span>}
            {state === 'refining' && <span className="text-xs text-amber-400 font-mono">refining...</span>}
            {state === 'submitting' && <span className="text-sm text-green-400">{displayText}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
