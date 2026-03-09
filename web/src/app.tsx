import { Command, Menu } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthGate } from '@/components/auth-gate'
import { Header } from '@/components/header'
import { JsonInspectorDialog } from '@/components/json-inspector'
import { SessionDetail } from '@/components/session-detail'
import { SessionList } from '@/components/session-list'
import { SessionSwitcher } from '@/components/session-switcher'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { WebTerminal } from '@/components/web-terminal'
import { fetchProjectSettings, fetchSessionEvents, fetchTranscript, useSessionsStore } from '@/hooks/use-sessions'
import { useWebSocket } from '@/hooks/use-websocket'
import { canTerminal } from '@/lib/types'

// Swipe-right from left edge to open session list (mobile)
function useSwipeToOpen(onOpen: () => void) {
  const touchRef = useRef<{ startX: number; startY: number; startTime: number } | null>(null)

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    // Only track swipes starting from the left 40px edge
    if (touch.clientX > 40) return
    touchRef.current = { startX: touch.clientX, startY: touch.clientY, startTime: Date.now() }
  }, [])

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!touchRef.current) return
      const touch = e.changedTouches[0]
      const { startX, startY, startTime } = touchRef.current
      touchRef.current = null

      const dx = touch.clientX - startX
      const dy = Math.abs(touch.clientY - startY)
      const elapsed = Date.now() - startTime

      // Must be: rightward, mostly horizontal, fast enough, long enough
      if (dx > 60 && dy < dx * 0.5 && elapsed < 500) {
        onOpen()
      }
    },
    [onOpen],
  )

  return { onTouchStart, onTouchEnd }
}

function Dashboard() {
  const [sheetOpen, setSheetOpen] = useState(false)
  const [errorExpanded, setErrorExpanded] = useState(false)
  const { selectedSessionId, setEvents, setTranscript, error, showSwitcher } = useSessionsStore()
  const swipeHandlers = useSwipeToOpen(() => setSheetOpen(true))

  // Auto-expand on new error, auto-collapse after 4s
  useEffect(() => {
    if (!error) {
      setErrorExpanded(false)
      return
    }
    setErrorExpanded(true)
    const t = setTimeout(() => setErrorExpanded(false), 4000)
    return () => clearTimeout(t)
  }, [error])

  // Connect to WebSocket for real-time session updates
  useWebSocket()

  // Fetch project settings on mount
  useEffect(() => {
    fetchProjectSettings().then(s => useSessionsStore.getState().setProjectSettings(s))
  }, [])

  // Fetch initial events when session is selected (updates come via WebSocket)
  useEffect(() => {
    if (!selectedSessionId) return
    fetchSessionEvents(selectedSessionId).then(events => setEvents(selectedSessionId, events))
  }, [selectedSessionId, setEvents])

  // Poll transcript (reads from JSONL file, not pushed via WS)
  useEffect(() => {
    if (!selectedSessionId) return

    const loadTranscript = () => {
      fetchTranscript(selectedSessionId).then(transcript => setTranscript(selectedSessionId, transcript))
    }

    loadTranscript()
    const interval = setInterval(loadTranscript, 3000)
    return () => clearInterval(interval)
  }, [selectedSessionId, setTranscript])

  // Close sheet when a session is selected (mobile UX)
  useEffect(() => {
    if (selectedSessionId) {
      setSheetOpen(false)
    }
  }, [selectedSessionId])

  // Global keyboard shortcuts - work EVERYWHERE (dashboard + terminal)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl+K - session switcher
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault()
        useSessionsStore.getState().toggleSwitcher()
      }
      // Ctrl+Shift+T - open TTY for current session
      if (e.ctrlKey && e.shiftKey && e.key === 'T') {
        e.preventDefault()
        const store = useSessionsStore.getState()
        const session = store.sessions.find(s => s.id === store.selectedSessionId)
        if (session && canTerminal(session) && !store.showTerminal) {
          store.openTerminal(session.id)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  function handleSwitcherSelect(id: string) {
    const store = useSessionsStore.getState()
    const session = store.sessions.find(s => s.id === id)
    if (session && canTerminal(session)) {
      store.openTerminal(id)
    } else {
      store.selectSession(id)
      store.setShowSwitcher(false)
    }
  }

  return (
    <div className="h-full flex flex-col p-2 sm:p-4 max-w-[1400px] mx-auto overflow-hidden" {...swipeHandlers}>
      {/* Error indicator */}
      {error &&
        (errorExpanded ? (
          <div
            className="mb-2 px-3 py-2 border border-red-500/50 bg-red-500/10 text-red-400 font-mono text-xs shrink-0 cursor-pointer"
            onClick={() => setErrorExpanded(false)}
          >
            [ERROR] {error}
          </div>
        ) : (
          <div
            className="mb-1 flex items-center gap-1.5 cursor-pointer shrink-0"
            onClick={() => setErrorExpanded(true)}
          >
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-red-400 font-mono text-[10px]">ERR</span>
          </div>
        ))}

      {/* Header with mobile menu */}
      <div className="flex items-center gap-2 mb-4 shrink-0">
        {/* Mobile menu button */}
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" className="lg:hidden shrink-0">
              <Menu className="h-5 w-5" />
              <span className="sr-only">Toggle sessions</span>
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[320px] sm:w-[380px] p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>Sessions</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto p-2 h-full">
              <SessionList />
            </div>
          </SheetContent>
        </Sheet>

        <div className="flex-1">
          <Header />
        </div>

        {/* Command palette button - visible on touch/mobile screens without keyboards */}
        <Button
          variant="outline"
          size="icon"
          className="shrink-0 sm:hidden"
          onClick={() => useSessionsStore.getState().toggleSwitcher()}
          title="Command palette"
        >
          <Command className="h-4 w-4" />
        </Button>
      </div>

      {/* Main content */}
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Desktop sidebar */}
        <div className="hidden lg:flex w-[350px] shrink-0 border border-border overflow-hidden flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto p-2">
            <SessionList />
          </div>
        </div>

        {/* Detail panel */}
        <div className="flex-1 border border-border overflow-hidden flex flex-col min-w-0">
          <SessionDetail />
        </div>
      </div>

      {/* Global session switcher (Ctrl+K from anywhere) */}
      {showSwitcher && (
        <SessionSwitcher
          onSelect={handleSwitcherSelect}
          onClose={() => useSessionsStore.getState().setShowSwitcher(false)}
        />
      )}

      {/* Global JSON inspector dialog (survives virtualizer remounts) */}
      <JsonInspectorDialog />
    </div>
  )
}

// Popout terminal - rendered when URL is #popout-terminal/{sessionId}
function PopoutTerminal({ sessionId }: { sessionId: string }) {
  useWebSocket()

  return (
    <div className="h-full w-full">
      <WebTerminal sessionId={sessionId} onClose={() => window.close()} onSwitchSession={() => {}} popout />
    </div>
  )
}

export function App() {
  // Check for popout terminal route
  const hash = window.location.hash.slice(1)
  const popoutMatch = hash.match(/^popout-terminal\/(.+)$/)

  if (popoutMatch) {
    return (
      <AuthGate>
        <PopoutTerminal sessionId={popoutMatch[1]} />
      </AuthGate>
    )
  }

  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  )
}
