/**
 * Voice FAB - Floating walkie-talkie button for mobile voice input
 *
 * Hold to record, release to submit, drag left to cancel.
 * Mobile-only, gated by showVoiceFab dashboard pref.
 */

import { Mic, MicOff, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { sendInput, useSessionsStore } from '@/hooks/use-sessions'
import { cn, haptic } from '@/lib/utils'

const CANCEL_THRESHOLD = 80 // px drag left to cancel

type FabState = 'idle' | 'connecting' | 'recording' | 'refining' | 'submitting' | 'error'
type MicPermission = 'unknown' | 'prompt' | 'granted' | 'denied'

export function VoiceFab() {
  const [state, setState] = useState<FabState>('idle')
  const [micPermission, setMicPermission] = useState<MicPermission>('unknown')
  const [interimText, setInterimText] = useState('')
  const [finalText, setFinalText] = useState('')
  const [refinedText, setRefinedText] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [dragOffset, setDragOffset] = useState(0)
  const [cancelled, setCancelled] = useState(false)

  const startXRef = useRef(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const wsListenerRef = useRef<((event: MessageEvent) => void) | null>(null)
  const stateRef = useRef<FabState>('idle')
  const cancelledRef = useRef(false)
  const dragOffsetRef = useRef(0)
  const pendingStopRef = useRef(false) // Set when pointerup fires before getUserMedia resolves
  const utteranceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  stateRef.current = state
  cancelledRef.current = cancelled
  dragOffsetRef.current = dragOffset

  const sendWs = useCallback((msg: Record<string, unknown>) => {
    useSessionsStore.getState().sendWsMessage(msg)
  }, [])

  // Query mic permission on mount + listen for changes
  useEffect(() => {
    let permStatus: PermissionStatus | null = null
    navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then(status => {
        permStatus = status
        setMicPermission(status.state as MicPermission)
        status.onchange = () => setMicPermission(status.state as MicPermission)
      })
      .catch(() => {
        // Permissions API not supported (older Safari) - assume prompt
        setMicPermission('prompt')
      })
    return () => {
      if (permStatus) permStatus.onchange = null
    }
  }, [])

  // Clean up WS listener on unmount
  useEffect(() => {
    return () => {
      const ws = useSessionsStore.getState().ws
      if (ws && wsListenerRef.current) {
        ws.removeEventListener('message', wsListenerRef.current)
        wsListenerRef.current = null
      }
      if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current)
    }
  }, [])

  function attachWsListener() {
    const ws = useSessionsStore.getState().ws
    if (!ws) {
      console.error('[voice-fab] WebSocket not connected')
      setErrorMsg('WS not connected')
      setState('error')
      return
    }

    // Remove old listener if any
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
            haptic('double')
            break
          case 'voice_transcript':
            if (msg.isFinal) {
              setFinalText(msg.accumulated || '')
              setInterimText('')
            } else {
              setInterimText(msg.transcript || '')
            }
            if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current)
            break
          case 'voice_utterance_end':
            // Don't auto-stop in FAB mode - user controls via finger
            break
          case 'voice_refining':
            setState('refining')
            haptic('tick') // subtle - refinement starting
            break
          case 'voice_done': {
            const text = msg.refined || msg.raw || ''
            setRefinedText(text)
            haptic('tick') // subtle - refinement complete
            if (text && !cancelledRef.current) {
              submitText(text)
            } else {
              resetState()
            }
            break
          }
          case 'voice_error':
            console.error('[voice-fab] Server voice error:', msg.error)
            setErrorMsg(msg.error || 'Voice error')
            setState('error')
            haptic('error')
            setTimeout(resetState, 2000)
            break
        }
      } catch {}
    }

    ws.addEventListener('message', handleMessage)
    wsListenerRef.current = handleMessage
  }

  async function submitText(text: string) {
    setState('submitting')
    haptic('double') // hard haptic - text submitted
    const sessionId = useSessionsStore.getState().selectedSessionId
    if (sessionId) {
      await sendInput(sessionId, text)
    }
    // Brief flash of success before resetting
    setTimeout(resetState, 300)
  }

  function resetState() {
    setState('idle')
    setInterimText('')
    setFinalText('')
    setRefinedText('')
    setErrorMsg('')
    setDragOffset(0)
    setCancelled(false)
    pendingStopRef.current = false
  }

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

  function cancelRecording() {
    setCancelled(true)
    haptic('error')
    sendWs({ type: 'voice_stop' })
    cleanup()
    resetState()
  }

  async function requestMicPermission() {
    haptic('tap')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // Got permission - immediately release the stream
      for (const t of stream.getTracks()) t.stop()
      setMicPermission('granted')
      haptic('success')
    } catch (err) {
      console.error('[voice-fab] Mic permission denied:', err)
      setMicPermission('denied')
      haptic('error')
    }
  }

  async function handlePointerDown(e: React.PointerEvent) {
    if (stateRef.current !== 'idle') return

    // First-click unlock: request permission without starting recording
    if (micPermission === 'prompt' || micPermission === 'unknown') {
      e.preventDefault()
      requestMicPermission()
      return
    }

    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)

    startXRef.current = e.clientX
    setCancelled(false)
    pendingStopRef.current = false
    setDragOffset(0)
    setState('connecting')
    haptic('tap')

    attachWsListener()

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

      // User released finger (or cancelled) while we were waiting for mic permission
      if (cancelledRef.current || pendingStopRef.current) {
        for (const t of stream.getTracks()) t.stop()
        if (pendingStopRef.current) {
          pendingStopRef.current = false
          cleanup()
          resetState()
        }
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
    } catch (err) {
      console.error('[voice-fab] Recording failed:', err)
      const msg = err instanceof Error ? err.message : 'Mic access denied'
      if (msg.includes('Permission') || msg.includes('denied') || msg.includes('NotAllowedError')) {
        setMicPermission('denied')
      }
      setErrorMsg(msg)
      setState('error')
      haptic('error')
      setTimeout(resetState, 2000)
    }
  }

  function handlePointerMove(e: React.PointerEvent) {
    const s = stateRef.current
    if (s !== 'recording' && s !== 'connecting') return

    const dx = e.clientX - startXRef.current
    const offset = Math.min(0, dx) // only track leftward movement
    setDragOffset(offset)

    // Haptic tick when crossing cancel threshold
    if (Math.abs(offset) >= CANCEL_THRESHOLD && !cancelledRef.current) {
      haptic('tick')
    }
  }

  function handlePointerUp() {
    const s = stateRef.current
    if (s === 'idle') return

    if (Math.abs(dragOffsetRef.current) >= CANCEL_THRESHOLD) {
      cancelRecording()
      return
    }

    if (s === 'connecting') {
      // getUserMedia hasn't resolved yet - signal the async callback to bail out
      pendingStopRef.current = true
      haptic('tick')
      return
    }

    if (s === 'recording') {
      // Stop recording, send for refinement
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      mediaRecorderRef.current = null
      if (streamRef.current) {
        for (const t of streamRef.current.getTracks()) t.stop()
        streamRef.current = null
      }
      sendWs({ type: 'voice_stop' })

      // Transition to refining - let the server flush final transcript
      setState('refining')
      haptic('tick')
    }
  }

  const needsUnlock = micPermission === 'prompt' || micPermission === 'unknown'
  const isRecording = state === 'recording'
  const isActive = state !== 'idle'
  const isCancelling = Math.abs(dragOffset) >= CANCEL_THRESHOLD
  const displayText = refinedText || finalText
  const displayInterim = state === 'recording' ? interimText : ''
  const hasText = !!(displayText || displayInterim)

  // Hide FAB entirely when mic permission is denied
  if (micPermission === 'denied') return null

  return (
    <>
      {/* Live transcript banner at top of screen */}
      {isActive && (
        <div className="fixed top-0 left-0 right-0 z-[60] pointer-events-none">
          <div className={cn('mx-auto max-w-[600px] px-4 pt-safe', 'animate-in slide-in-from-top duration-200')}>
            <div
              className={cn(
                'mt-2 px-4 py-3 rounded-xl backdrop-blur-xl border shadow-lg',
                isCancelling ? 'bg-red-950/80 border-red-500/30' : 'bg-background/90 border-border/50',
              )}
            >
              {/* Status line */}
              <div className="flex items-center gap-2 mb-1">
                {state === 'connecting' && (
                  <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
                    Connecting...
                  </span>
                )}
                {state === 'recording' && !isCancelling && (
                  <>
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                    </span>
                    <span className="text-[10px] text-red-400 font-mono uppercase tracking-wider">
                      Recording - release to send
                    </span>
                  </>
                )}
                {state === 'recording' && isCancelling && (
                  <span className="text-[10px] text-red-400 font-mono uppercase tracking-wider">Release to cancel</span>
                )}
                {state === 'refining' && (
                  <span className="text-[10px] text-accent font-mono uppercase tracking-wider">Refining...</span>
                )}
                {state === 'submitting' && (
                  <span className="text-[10px] text-green-400 font-mono uppercase tracking-wider">Sent!</span>
                )}
                {state === 'error' && (
                  <span className="text-[10px] text-red-400 font-mono uppercase tracking-wider">
                    {errorMsg || 'Error'}
                  </span>
                )}
              </div>

              {/* Transcript text */}
              {hasText && (
                <div
                  className={cn(
                    'text-sm font-mono leading-relaxed max-h-[30vh] overflow-y-auto',
                    isCancelling ? 'line-through text-red-400/60' : 'text-foreground',
                  )}
                >
                  {displayText && <span>{displayText}</span>}
                  {displayInterim && (
                    <span className="text-accent/50 italic">
                      {displayText ? ' ' : ''}
                      {displayInterim}
                    </span>
                  )}
                </div>
              )}

              {!hasText && state === 'recording' && (
                <span className="text-sm text-muted-foreground/40 italic font-mono">Speak now...</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Floating button */}
      <button
        type="button"
        className={cn(
          'fixed z-[55] right-3 top-1/2 -translate-y-1/2',
          'w-12 h-12 rounded-full flex items-center justify-center',
          'shadow-lg border transition-all duration-150',
          'touch-none select-none',
          needsUnlock && 'bg-background/60 border-border/30 text-muted-foreground/50 active:scale-95',
          !needsUnlock && state === 'idle' && 'bg-background/80 border-border/50 text-muted-foreground active:scale-95',
          isRecording && !isCancelling && 'bg-red-500/20 border-red-500/50 text-red-400 scale-110',
          isRecording && isCancelling && 'bg-red-950/80 border-red-500/50 text-red-400',
          state === 'connecting' && 'bg-accent/10 border-accent/30 text-accent animate-pulse',
          state === 'refining' && 'bg-accent/10 border-accent/30 text-accent animate-pulse',
          state === 'submitting' && 'bg-green-500/20 border-green-500/50 text-green-400',
          state === 'error' && 'bg-red-950/50 border-red-500/30 text-red-400',
        )}
        style={{
          transform: `translate(${dragOffset}px, -50%)`,
          touchAction: 'none',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {needsUnlock ? (
          <MicOff className="w-5 h-5" />
        ) : isCancelling ? (
          <X className="w-5 h-5" />
        ) : isRecording ? (
          <span className="relative flex h-4 w-4">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-4 w-4 bg-red-500" />
          </span>
        ) : (
          <Mic className="w-5 h-5" />
        )}
      </button>
    </>
  )
}
