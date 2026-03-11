/**
 * Voice Overlay - Overlay for voice input with live streaming transcript
 *
 * States: connecting -> recording -> refining -> done
 * Covers full screen, transcript at top, controls at bottom (thumb-friendly).
 * Auto-submits after utterance end (silence detection) + refinement.
 */

import { Loader2, Check, X, Square } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { cn } from '@/lib/utils'

type VoiceState = 'idle' | 'connecting' | 'recording' | 'refining' | 'done' | 'error'

interface VoiceOverlayProps {
  onResult: (text: string) => void
  onClose: () => void
}

export function VoiceOverlay({ onResult, onClose }: VoiceOverlayProps) {
  const [state, setState] = useState<VoiceState>('connecting')
  const [interimText, setInterimText] = useState('')
  const [finalText, setFinalText] = useState('')
  const [refinedText, setRefinedText] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const wsListenerRef = useRef<((event: MessageEvent) => void) | null>(null)
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const utteranceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stateRef = useRef<VoiceState>('connecting')

  // Keep stateRef in sync so timers can read current state
  stateRef.current = state

  const sendWs = useCallback((msg: Record<string, unknown>) => {
    useSessionsStore.getState().sendWsMessage(msg)
  }, [])

  // Set up WS message listener for voice events
  useEffect(() => {
    const ws = useSessionsStore.getState().ws
    if (!ws) {
      setErrorMsg('WebSocket not connected')
      setState('error')
      return
    }

    function handleMessage(event: MessageEvent) {
      try {
        const msg = JSON.parse(event.data)
        switch (msg.type) {
          case 'voice_ready':
            setState('recording')
            break
          case 'voice_transcript':
            if (msg.isFinal) {
              setFinalText(msg.accumulated || '')
              setInterimText('')
            } else {
              setInterimText(msg.transcript || '')
            }
            // Reset utterance end timer on any transcript activity
            if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current)
            break
          case 'voice_utterance_end':
            // Silence detected - auto-stop after 2s of no new speech
            if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current)
            utteranceTimerRef.current = setTimeout(() => {
              if (stateRef.current === 'recording') {
                stopRecording(true)
              }
            }, 2000)
            break
          case 'voice_refining':
            setState('refining')
            break
          case 'voice_done':
            setRefinedText(msg.refined || msg.raw || '')
            setState('done')
            break
          case 'voice_error':
            setErrorMsg(msg.error || 'Voice error')
            setState('error')
            break
        }
      } catch {}
    }

    ws.addEventListener('message', handleMessage)
    wsListenerRef.current = handleMessage

    return () => {
      ws.removeEventListener('message', handleMessage)
      wsListenerRef.current = null
    }
  }, [])

  // Start recording on mount
  useEffect(() => {
    startRecording()
    return () => {
      stopRecording(false)
      if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current)
      const ws = useSessionsStore.getState().ws
      if (ws && wsListenerRef.current) {
        ws.removeEventListener('message', wsListenerRef.current)
      }
    }
  }, [])

  // Auto-submit after done
  useEffect(() => {
    if (state === 'done' && refinedText) {
      autoCloseTimerRef.current = setTimeout(() => {
        onResult(refinedText)
        onClose()
      }, 1000)
      return () => {
        if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current)
      }
    }
  }, [state, refinedText, onResult, onClose])

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const sessionId = useSessionsStore.getState().selectedSessionId
      sendWs({ type: 'voice_start', sessionId })

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/mp4'
      const recorder = new MediaRecorder(stream, { mimeType })

      recorder.ondataavailable = async (e) => {
        if (e.data.size > 0) {
          const buffer = await e.data.arrayBuffer()
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)))
          sendWs({ type: 'voice_data', audio: base64 })
        }
      }

      recorder.start(250)
      mediaRecorderRef.current = recorder
    } catch (err) {
      console.error('[voice-overlay] Recording failed:', err)
      setErrorMsg('Microphone access denied')
      setState('error')
    }
  }

  function stopRecording(sendStop = true) {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
    mediaRecorderRef.current = null
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (utteranceTimerRef.current) {
      clearTimeout(utteranceTimerRef.current)
      utteranceTimerRef.current = null
    }
    if (sendStop) {
      sendWs({ type: 'voice_stop' })
      // Show refining state if we have text
      if (finalText || interimText) {
        setState('refining')
      }
    }
  }

  function handleStopClick() {
    stopRecording(true)
  }

  function handleAccept() {
    if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current)
    const text = refinedText || finalText
    if (text) onResult(text)
    onClose()
  }

  function handleDiscard() {
    if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current)
    stopRecording(true)
    onClose()
  }

  const displayText = refinedText || finalText
  const displayInterim = state === 'recording' ? interimText : ''

  return (
    <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col animate-in fade-in duration-150">
      {/* Status indicator - top */}
      <div className="shrink-0 flex items-center justify-center gap-2 pt-4 pb-2">
        {state === 'connecting' && (
          <>
            <Loader2 className="w-4 h-4 animate-spin text-accent" />
            <span className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Connecting...</span>
          </>
        )}
        {state === 'recording' && (
          <>
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
            </span>
            <span className="text-xs text-red-400 font-mono uppercase tracking-wider">Listening...</span>
          </>
        )}
        {state === 'refining' && (
          <>
            <Loader2 className="w-4 h-4 animate-spin text-accent" />
            <span className="text-xs text-accent font-mono uppercase tracking-wider">Refining...</span>
          </>
        )}
        {state === 'done' && (
          <>
            <Check className="w-4 h-4 text-green-400" />
            <span className="text-xs text-green-400 font-mono uppercase tracking-wider">Done</span>
          </>
        )}
        {state === 'error' && (
          <>
            <X className="w-4 h-4 text-red-400" />
            <span className="text-xs text-red-400 font-mono uppercase tracking-wider">{errorMsg}</span>
          </>
        )}
      </div>

      {/* Transcript area - fills middle */}
      <div className="flex-1 overflow-y-auto px-4">
        <div className={cn(
          'max-w-[700px] mx-auto font-mono text-base leading-relaxed p-4 min-h-[4rem]',
          state === 'error' ? 'text-red-400' : '',
        )}>
          {!displayText && !displayInterim && state !== 'error' && (
            <span className="text-muted-foreground/40 italic text-lg">
              {state === 'connecting' ? 'Connecting...' : 'Speak now...'}
            </span>
          )}
          {displayText && (
            <span className={cn(
              'transition-colors duration-300',
              state === 'done' ? 'text-foreground' : 'text-foreground/80',
            )}>
              {displayText}
            </span>
          )}
          {displayInterim && (
            <span className="text-accent/50 italic">
              {displayText ? ' ' : ''}{displayInterim}
            </span>
          )}
        </div>
      </div>

      {/* Action buttons - BOTTOM (thumb zone) */}
      <div className="shrink-0 pb-safe">
        <div className="max-w-[700px] mx-auto px-4 pb-6 pt-3 flex items-center justify-center gap-3">
          {state === 'recording' && (
            <button
              type="button"
              onClick={handleStopClick}
              className="flex items-center justify-center gap-3 px-8 py-4 bg-red-500/20 border-2 border-red-500/50 text-red-400 text-base font-bold uppercase tracking-wider hover:bg-red-500/30 active:bg-red-500/40 transition-colors rounded-xl min-w-[180px]"
              style={{ touchAction: 'manipulation' }}
            >
              <Square className="w-5 h-5 fill-current" />
              Stop
            </button>
          )}
          {(state === 'refining' || state === 'connecting') && (
            <button
              type="button"
              onClick={handleDiscard}
              className="flex items-center justify-center gap-2 px-6 py-3 border-2 border-border text-muted-foreground text-sm font-bold uppercase tracking-wider hover:text-foreground hover:border-foreground/30 active:bg-muted/20 transition-colors rounded-lg min-w-[140px]"
              style={{ touchAction: 'manipulation' }}
            >
              <X className="w-4 h-4" />
              Cancel
            </button>
          )}
          {state === 'done' && (
            <>
              <button
                type="button"
                onClick={handleDiscard}
                className="flex items-center justify-center gap-2 px-5 py-3 border-2 border-border text-muted-foreground text-sm font-bold uppercase tracking-wider hover:text-foreground hover:border-foreground/30 active:bg-muted/20 transition-colors rounded-lg"
                style={{ touchAction: 'manipulation' }}
              >
                <X className="w-4 h-4" />
                Discard
              </button>
              <button
                type="button"
                onClick={handleAccept}
                className="flex items-center justify-center gap-2 px-6 py-3 bg-accent/20 border-2 border-accent/50 text-accent text-sm font-bold uppercase tracking-wider hover:bg-accent/30 active:bg-accent/40 transition-colors rounded-lg min-w-[140px]"
                style={{ touchAction: 'manipulation' }}
              >
                <Check className="w-4 h-4" />
                Use
              </button>
            </>
          )}
          {state === 'error' && (
            <button
              type="button"
              onClick={handleDiscard}
              className="flex items-center justify-center gap-2 px-6 py-3 border-2 border-border text-muted-foreground text-sm font-bold uppercase tracking-wider hover:text-foreground hover:border-foreground/30 active:bg-muted/20 transition-colors rounded-lg min-w-[140px]"
              style={{ touchAction: 'manipulation' }}
            >
              <X className="w-4 h-4" />
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
