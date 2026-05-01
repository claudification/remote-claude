/**
 * VoiceKey - Keyboard push-to-talk: hold configured key to record, release to submit.
 * Shows a recording indicator banner with live transcript.
 * Uses shared useVoiceRecording hook (same engine as mobile FAB).
 */

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { sendInput, useConversationsStore } from '@/hooks/use-conversations'
import {
  dismissMicExpired,
  getMicExpired,
  prewarmMicStream,
  subscribeMicExpired,
  useVoiceRecording,
} from '@/hooks/use-voice-recording'
import { haptic } from '@/lib/utils'
import { formatKeyCode } from './settings/key-capture'

function useMicExpired() {
  return useSyncExternalStore(subscribeMicExpired, getMicExpired)
}

export function VoiceKey() {
  const voiceHoldKey = useConversationsStore(s => s.controlPanelPrefs.voiceHoldKey)
  const keepMicOpen = useConversationsStore(s => s.controlPanelPrefs.keepMicOpen)
  const voice = useVoiceRecording()
  const activeRef = useRef(false)
  const micExpired = useMicExpired()

  useEffect(() => {
    if (keepMicOpen && voiceHoldKey) prewarmMicStream()
  }, [keepMicOpen, voiceHoldKey])

  useEffect(() => {
    if (!voiceHoldKey) return

    function handleKeyDown(e: KeyboardEvent) {
      if (e.code !== voiceHoldKey) return
      if (e.repeat || activeRef.current) return

      e.preventDefault()
      activeRef.current = true
      haptic('tap')
      voice.start()
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (e.code !== voiceHoldKey) return
      if (!activeRef.current) return

      e.preventDefault()
      activeRef.current = false
      haptic('tick')
      voice.stop()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      if (activeRef.current) voice.cancel()
    }
  }, [voiceHoldKey, voice.start, voice.stop, voice.cancel])

  // Auto-submit when voice_done arrives
  useEffect(() => {
    if (voice.state === 'submitting') {
      const text = voice.refinedText || voice.finalText
      if (text.trim()) {
        const conversationId = useConversationsStore.getState().selectedConversationId
        if (conversationId) sendInput(conversationId, text)
        haptic('success')
      }
      setTimeout(() => voice.reset(), 300)
    }
  }, [voice.state, voice.refinedText, voice.finalText, voice.reset])

  if (voice.state === 'idle' && !micExpired) return null

  const displayText = voice.finalText || ''
  const displayInterim = voice.state === 'recording' ? voice.interimText : ''
  const keyLabel = voiceHoldKey ? formatKeyCode(voiceHoldKey) : ''

  if (micExpired && voice.state === 'idle') {
    return <MicExpiredBanner keyLabel={keyLabel} />
  }

  return (
    <div className="fixed top-0 left-0 right-0 z-[60] pointer-events-none">
      <div className="mx-auto max-w-[600px] px-4 pt-2 animate-in slide-in-from-top duration-200">
        <div className="px-4 py-2.5 rounded-xl backdrop-blur-xl bg-background/90 border border-border/50 shadow-lg">
          {/* Status line */}
          <div className="flex items-center gap-2 mb-1">
            {voice.state === 'connecting' && (
              <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
                Connecting...
              </span>
            )}
            {voice.state === 'recording' && (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                </span>
                <span className="text-[10px] text-red-400 font-mono uppercase tracking-wider">
                  Recording - release{' '}
                  <kbd className="px-1 py-0.5 bg-muted border border-border rounded text-[9px]">{keyLabel}</kbd> to send
                </span>
              </>
            )}
            {voice.state === 'refining' && (
              <span className="text-[10px] text-accent font-mono uppercase tracking-wider">Refining...</span>
            )}
            {voice.state === 'submitting' && (
              <span className="text-[10px] text-green-400 font-mono uppercase tracking-wider">Sent!</span>
            )}
            {voice.state === 'error' && (
              <span className="text-[10px] text-red-400 font-mono uppercase tracking-wider">
                {voice.errorMsg || 'Error'}
              </span>
            )}
          </div>

          {/* Transcript text - matching FAB style with yellow interim */}
          {(displayText || displayInterim) && (
            <div className="text-sm font-mono leading-relaxed max-h-[30vh] overflow-y-auto text-foreground">
              {displayText && <span>{displayText}</span>}
              {displayInterim && (
                <span className="text-accent/50 italic">
                  {displayText ? ' ' : ''}
                  {displayInterim}
                </span>
              )}
            </div>
          )}

          {!displayText && !displayInterim && voice.state === 'recording' && (
            <span className="text-sm text-muted-foreground/40 italic font-mono">Speak now...</span>
          )}
        </div>
      </div>
    </div>
  )
}

function MicExpiredBanner({ keyLabel }: { keyLabel: string }) {
  return (
    <div className="fixed top-0 left-0 right-0 z-[60] pointer-events-none">
      <div className="mx-auto max-w-[600px] px-4 pt-2 animate-in slide-in-from-top duration-200">
        <div className="px-4 py-2 rounded-xl backdrop-blur-xl bg-amber-950/80 border border-amber-500/30 shadow-lg flex items-center gap-2 pointer-events-auto">
          <span className="text-[10px] text-amber-400 font-mono uppercase tracking-wider flex-1">
            Mic released after 30min idle - next{' '}
            <kbd className="px-1 py-0.5 bg-muted border border-border rounded text-[9px]">{keyLabel}</kbd> will
            cold-start
          </span>
          <button
            type="button"
            onClick={() => prewarmMicStream()}
            className="px-2 py-0.5 text-[10px] font-bold font-mono text-amber-400 bg-amber-500/20 border border-amber-500/40 rounded hover:bg-amber-500/30 transition-colors uppercase"
          >
            Re-warm
          </button>
          <button
            type="button"
            onClick={() => dismissMicExpired()}
            className="px-2 py-0.5 text-[10px] font-bold font-mono text-muted-foreground hover:text-foreground transition-colors uppercase"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}
