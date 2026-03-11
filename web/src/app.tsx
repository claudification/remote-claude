import { ChevronLeft, ChevronRight, Command, FileText, Menu } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthGate } from '@/components/auth-gate'
import { CommandPalette } from '@/components/command-palette'
import { DebugConsole } from '@/components/debug-console'
import { Header } from '@/components/header'
import { JsonInspectorDialog } from '@/components/json-inspector'
import { QuickNoteModal } from '@/components/quick-note-modal'
import { SessionDetail } from '@/components/session-detail'
import { SessionList } from '@/components/session-list'
import { ShortcutHelp } from '@/components/shortcut-help'
import { ToastContainer } from '@/components/toast'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { WebTerminal } from '@/components/web-terminal'
import {
  fetchProjectSettings,
  fetchServerCapabilities,
  fetchSessionEvents,
  fetchTranscript,
  useSessionsStore,
} from '@/hooks/use-sessions'
import { useWebSocket } from '@/hooks/use-websocket'
import { canTerminal } from '@/lib/types'
import { isMobileViewport } from '@/lib/utils'

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
  const [sheetOpen, setSheetOpen] = useState(() => isMobileViewport() && !useSessionsStore.getState().selectedSessionId)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === 'true')
  const { selectedSessionId, setEvents, setTranscript, showSwitcher, showDebugConsole } = useSessionsStore()
  const swipeHandlers = useSwipeToOpen(() => setSheetOpen(true))

  function toggleSidebar() {
    setSidebarCollapsed(prev => {
      const next = !prev
      localStorage.setItem('sidebar-collapsed', String(next))
      return next
    })
  }

  // Connect to WebSocket for real-time session updates
  useWebSocket()

  // Fetch project settings and server capabilities on mount
  useEffect(() => {
    fetchProjectSettings().then(s => useSessionsStore.getState().setProjectSettings(s))
    fetchServerCapabilities().then(c => useSessionsStore.getState().setServerCapabilities(c))
  }, [])

  // Fetch events when session selected or WS reconnects (fills gaps from disconnection)
  const isConnected = useSessionsStore(state => state.isConnected)
  useEffect(() => {
    if (!selectedSessionId || !isConnected) return
    fetchSessionEvents(selectedSessionId).then(events => setEvents(selectedSessionId, events))
  }, [selectedSessionId, isConnected, setEvents])

  // Fetch transcript when session selected or WS reconnects (fills gaps from disconnection)
  useEffect(() => {
    if (!selectedSessionId || !isConnected) return
    fetchTranscript(selectedSessionId).then(transcript => setTranscript(selectedSessionId, transcript))
  }, [selectedSessionId, isConnected, setTranscript])

  // Close sheet when a session is selected (mobile UX)
  useEffect(() => {
    if (selectedSessionId) {
      setSheetOpen(false)
    }
  }, [selectedSessionId])

  // Global keyboard shortcuts - work EVERYWHERE (dashboard + terminal)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ctrl+K / Cmd+K - session switcher (closes terminal if open)
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        const store = useSessionsStore.getState()
        if (store.showTerminal) store.setShowTerminal(false)
        store.toggleSwitcher()
      }
      // Ctrl+O / Cmd+O - toggle expand all / verbose mode
      if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
        // Don't trigger in terminal or inputs
        const el = e.target as HTMLElement
        if (el?.closest('.xterm') || el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA') return
        e.preventDefault()
        useSessionsStore.getState().toggleExpandAll()
      }
      // Ctrl+B / Cmd+B - toggle sidebar
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        const el = e.target as HTMLElement
        if (el?.closest('.xterm') || el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA') return
        e.preventDefault()
        toggleSidebar()
      }
      // Ctrl+Shift+D - toggle debug console
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault()
        useSessionsStore.getState().toggleDebugConsole()
      }
      // Ctrl+Shift+T - open TTY for current session
      if (e.ctrlKey && e.shiftKey && e.key === 'T') {
        e.preventDefault()
        const store = useSessionsStore.getState()
        const session = store.sessions.find(s => s.id === store.selectedSessionId)
        if (session && canTerminal(session) && !store.showTerminal && session.wrapperIds?.[0]) {
          store.openTerminal(session.wrapperIds[0])
        }
      }
      // Escape - go home to transcript + focus input (desktop only)
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !isMobileViewport()) {
        const el = e.target as HTMLElement
        // Don't capture when terminal, modal, palette, or input has focus
        if (el?.closest('.xterm')) return
        const store = useSessionsStore.getState()
        if (store.showSwitcher || store.showDebugConsole || store.showTerminal) return
        if (!store.selectedSessionId) return
        e.preventDefault()
        store.selectSubagent(null)
        store.openTab(store.selectedSessionId, 'transcript')
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus())
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  function handleSwitcherSelect(id: string) {
    const store = useSessionsStore.getState()
    store.selectSession(id)
    store.setShowSwitcher(false)
    // Auto-focus input on desktop after session switch
    if (!isMobileViewport()) {
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus())
    }
  }

  return (
    <div className="h-full flex flex-col p-2 sm:p-4 max-w-[1400px] mx-auto overflow-hidden" {...swipeHandlers}>
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

        {/* Mobile-only buttons for touch screens without keyboards */}
        <Button
          variant="outline"
          size="icon"
          className="shrink-0 sm:hidden"
          onClick={() => window.dispatchEvent(new Event('open-quick-note'))}
          title="Quick note"
        >
          <FileText className="h-4 w-4" />
        </Button>
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
      <div className="flex gap-4 flex-1 min-h-0 relative">
        {/* Desktop sidebar */}
        {sidebarCollapsed ? (
          <button
            type="button"
            onClick={toggleSidebar}
            className="hidden lg:flex absolute left-2 top-1/2 -translate-y-1/2 z-10 items-center justify-center w-5 h-10 rounded-r-md bg-muted/80 hover:bg-muted border border-l-0 border-border text-muted-foreground hover:text-foreground transition-colors"
            title="Expand sidebar (Ctrl+B)"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
        ) : (
          <div className="hidden lg:flex w-[350px] shrink-0 border border-border overflow-hidden flex-col">
            <div className="flex items-center justify-end px-1 pt-1 shrink-0">
              <button
                type="button"
                onClick={toggleSidebar}
                className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
                title="Collapse sidebar (Ctrl+B)"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-2 pt-0">
              <SessionList />
            </div>
          </div>
        )}

        {/* Detail panel */}
        <div className="flex-1 border border-border overflow-hidden flex flex-col min-w-0">
          <SessionDetail />
        </div>
      </div>

      {/* Global session switcher (Ctrl+K from anywhere) */}
      {showSwitcher && (
        <CommandPalette
          onSelect={handleSwitcherSelect}
          onFileSelect={(sessionId, path) => {
            const store = useSessionsStore.getState()
            store.selectSession(sessionId)
            store.setShowSwitcher(false)
            store.openTab(sessionId, 'files')
            store.setPendingFilePath(path)
          }}
          onClose={() => useSessionsStore.getState().setShowSwitcher(false)}
        />
      )}

      {/* Global JSON inspector dialog (survives virtualizer remounts) */}
      <JsonInspectorDialog />
      {/* Ctrl+Shift+N quick note modal */}
      <QuickNoteModal />
      {/* Shift+? shortcut help */}
      <ShortcutHelp />
      {/* Debug console (Ctrl+Shift+D) */}
      {showDebugConsole && <DebugConsole onClose={() => useSessionsStore.getState().toggleDebugConsole()} />}
      {/* Toast notifications */}
      <ToastContainer />
    </div>
  )
}

// Popout terminal - rendered when URL is #popout-terminal/{wrapperId}
function PopoutTerminal({ wrapperId }: { wrapperId: string }) {
  useWebSocket()

  return (
    <div className="h-full w-full">
      <WebTerminal wrapperId={wrapperId} onClose={() => window.close()} onSwitchWrapper={() => {}} popout />
    </div>
  )
}

export function App() {
  // Check for popout terminal route: #popout-terminal/{wrapperId}
  const hash = window.location.hash.slice(1)
  const popoutMatch = hash.match(/^popout-terminal\/(.+)$/)

  if (popoutMatch) {
    return (
      <AuthGate>
        <PopoutTerminal wrapperId={popoutMatch[1]} />
      </AuthGate>
    )
  }

  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  )
}
