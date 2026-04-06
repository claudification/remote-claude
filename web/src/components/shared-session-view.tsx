/**
 * SharedSessionView - Limited dashboard for share link viewers.
 *
 * No sidebar, no switcher, no settings. Just the session transcript,
 * input bar (if chat permission), and a countdown timer.
 */

import { Clock, Link2Off } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { SessionDetail } from '@/components/session-detail'
import { fetchSessionEvents, fetchTranscript, useSessionsStore } from '@/hooks/use-sessions'
import { useWebSocket } from '@/hooks/use-websocket'

export function SharedSessionView({ token: _token }: { token: string }) {
  const sessions = useSessionsStore(s => s.sessions)
  const selectedSessionId = useSessionsStore(s => s.selectedSessionId)
  const isConnected = useSessionsStore(s => s.isConnected)
  const [expired, setExpired] = useState(false)
  const [timeLeft, setTimeLeft] = useState('')

  // Connect WebSocket (share token is baked into the URL)
  useWebSocket()

  // Auto-select the first (and only) session when it arrives
  useEffect(() => {
    if (sessions.length > 0 && !selectedSessionId) {
      useSessionsStore.getState().selectSession(sessions[0].id)
    }
  }, [sessions, selectedSessionId])

  // Fetch transcript for selected session
  const fetchedRef = useRef(false)
  useEffect(() => {
    if (!selectedSessionId || !isConnected || fetchedRef.current) return
    fetchedRef.current = true
    fetchSessionEvents(selectedSessionId).then(events => {
      useSessionsStore.getState().setEvents(selectedSessionId, events)
    })
    fetchTranscript(selectedSessionId).then(transcript => {
      if (transcript) useSessionsStore.getState().setTranscript(selectedSessionId, transcript)
    })
  }, [selectedSessionId, isConnected])

  // Listen for share_expired from server
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'share_expired') {
          setExpired(true)
        }
      } catch {}
    }
    const ws = useSessionsStore.getState().ws
    if (ws) ws.addEventListener('message', handleMessage)
    return () => {
      if (ws) ws.removeEventListener('message', handleMessage)
    }
  }, [isConnected])

  // Countdown timer - estimate from session share expiry
  // We don't have the exact expiry on the client, so we'll get it from the server
  // via a permissions message or just show "Shared session" without countdown
  // TODO: Server could send share metadata on subscribe

  if (expired) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-4 max-w-md px-6">
          <Link2Off className="w-12 h-12 text-muted-foreground mx-auto" />
          <h1 className="text-lg font-bold text-foreground">Session share has expired</h1>
          <p className="text-sm text-muted-foreground">
            The person who shared this session has either revoked the link or it has reached its time limit.
          </p>
          <p className="text-xs text-muted-foreground/60 font-mono">"The only winning move is not to play." - WOPR</p>
        </div>
      </div>
    )
  }

  if (!isConnected) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-2">
          <div className="text-sm text-muted-foreground animate-pulse">Connecting to shared session...</div>
        </div>
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-2">
          <div className="text-sm text-muted-foreground">Waiting for session data...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Minimal header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border shrink-0">
        <span className="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-teal-500/20 text-teal-400 border border-teal-500/30 rounded">
          Shared
        </span>
        <span className="text-sm text-foreground font-mono truncate flex-1">
          {sessions[0]?.cwd?.split('/').pop() || 'Session'}
        </span>
        {timeLeft && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground font-mono">
            <Clock className="w-3 h-3" />
            {timeLeft}
          </span>
        )}
      </div>

      {/* Session detail (transcript + input) */}
      <div className="flex-1 min-h-0">{selectedSessionId && <SessionDetail />}</div>
    </div>
  )
}
