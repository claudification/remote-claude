import { ChevronLeft, ChevronRight, Command, FileText, Menu } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ActionFab } from '@/components/action-fab'
import { AuthGate } from '@/components/auth-gate'
import { CommandPalette } from '@/components/command-palette'
import { DebugConsole } from '@/components/debug-console'
import { Header } from '@/components/header'
import { JsonInspectorDialog } from '@/components/json-inspector'
import { QuickTaskModal } from '@/components/quick-task-modal'
import { SessionDetail } from '@/components/session-detail'
import { SessionList } from '@/components/session-list'
import { SharedSessionView } from '@/components/shared-session-view'
import { ShortcutHelp } from '@/components/shortcut-help'
import { SpawnDialog } from '@/components/spawn-dialog'
import { ToastContainer } from '@/components/toast'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { VoiceFab } from '@/components/voice-fab'
import { VoiceKey } from '@/components/voice-key'
import { fetchModelDb } from '@/lib/model-db'
import { detectShareMode } from '@/lib/share-mode'

const WebTerminal = lazy(() => import('@/components/web-terminal').then(m => ({ default: m.WebTerminal })))
const UserAdminDialog = lazy(() => import('@/components/user-admin').then(m => ({ default: m.UserAdminDialog })))

import {
  fetchGlobalSettings,
  fetchProjectSettings,
  fetchServerCapabilities,
  fetchSessionEvents,
  fetchSessionOrder,
  fetchTranscript,
  sendInput,
  useSessionsStore,
  wsSend,
} from '@/hooks/use-sessions'
import { useWebSocket } from '@/hooks/use-websocket'
import { executeCommand, useCommand } from '@/lib/commands'
import { canTerminal } from '@/lib/types'
import { clearCacheAndReload, isMobileViewport, isTouchDevice } from '@/lib/utils'

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
  const [showUserAdmin, setShowUserAdmin] = useState(false)
  const [swUpdateAvailable, setSwUpdateAvailable] = useState(false)

  // Listen for service worker update notifications (belt-and-suspenders)
  useEffect(() => {
    function handleSwMessage(event: MessageEvent) {
      if (event.data?.type === 'sw-updated') setSwUpdateAvailable(true)
    }
    navigator.serviceWorker?.addEventListener('message', handleSwMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', handleSwMessage)
  }, [])

  // Poll asset-manifest.json to detect new builds (primary update detection)
  useEffect(() => {
    let knownHash: string | null = null

    async function checkManifest() {
      try {
        const res = await fetch(`/asset-manifest.json?_=${Date.now()}`)
        if (!res.ok) return
        const manifest = await res.json()
        const hash = manifest.buildHash as string
        if (!hash) return
        if (knownHash === null) {
          knownHash = hash // first load, just remember it
        } else if (hash !== knownHash) {
          setSwUpdateAvailable(true)
        }
      } catch {}
    }

    checkManifest()
    const timer = setInterval(checkManifest, 5 * 60 * 1000) // every 5 minutes
    return () => clearInterval(timer)
  }, [])
  const selectedSessionId = useSessionsStore(s => s.selectedSessionId)
  const setEvents = useSessionsStore(s => s.setEvents)
  const setTranscript = useSessionsStore(s => s.setTranscript)
  const showSwitcher = useSessionsStore(s => s.showSwitcher)
  const showDebugConsole = useSessionsStore(s => s.showDebugConsole)
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

  // Fetch sidebar metadata (project settings, capabilities, global settings, session order).
  // Called on mount AND on reconnect/visibility-restore to catch renames, reorders, etc.
  // Uses Promise.all + single batched setState to avoid useSyncExternalStore tearing (#310).
  const fetchSidebarMetadata = useCallback(async () => {
    const [settings, capabilities, globalSettings, order] = await Promise.all([
      fetchProjectSettings(),
      fetchServerCapabilities(),
      fetchGlobalSettings(),
      fetchSessionOrder(),
      fetchModelDb(), // LiteLLM pricing + context windows (fire-and-forget)
    ])
    useSessionsStore.setState({
      projectSettings: settings,
      serverCapabilities: capabilities,
      globalSettings,
      sessionOrder: order,
    })
  }, [])

  useEffect(() => {
    fetchSidebarMetadata()
  }, [fetchSidebarMetadata])

  // Listen for user admin open event (from command palette)
  useEffect(() => {
    function handleOpen() {
      setShowUserAdmin(true)
    }
    window.addEventListener('open-user-admin', handleOpen)
    return () => window.removeEventListener('open-user-admin', handleOpen)
  }, [])

  // Periodic auth status check - renews cookie silently (server extends if past halfway)
  // Also catches expired sessions early before WS disconnect
  useEffect(() => {
    const AUTH_CHECK_INTERVAL = 4 * 60 * 60 * 1000 // 4 hours
    const check = async () => {
      try {
        const res = await fetch('/auth/status')
        if (res.ok) {
          const data = await res.json()
          if (!data.authenticated) {
            useSessionsStore.getState().setAuthExpired(true)
          }
        }
      } catch {}
    }
    const timer = setInterval(check, AUTH_CHECK_INTERVAL)
    return () => clearInterval(timer)
  }, [])

  // Sync protocol: on visibility restore, send sync_check with our last known epoch+seq.
  // Server responds with sync_ok (caught up), sync_catchup (missed messages pushed),
  // or sync_stale (full resync needed). Works on both mobile and desktop without
  // unnecessary re-fetches on alt-tab.
  useEffect(() => {
    let hiddenAt = 0
    function handleVisibility() {
      if (document.hidden) {
        hiddenAt = Date.now()
        console.log('[sync] hidden')
      } else if (hiddenAt) {
        const elapsed = Date.now() - hiddenAt
        hiddenAt = 0
        const { syncEpoch, syncSeq, transcripts } = useSessionsStore.getState()
        // Include transcript entry counts for cached sessions so server can detect gaps
        const transcriptCounts: Record<string, number> = {}
        for (const [sid, entries] of Object.entries(transcripts)) {
          if (entries && entries.length > 0) transcriptCounts[sid] = entries.length
        }
        console.log(
          `[sync] restored after ${(elapsed / 1000).toFixed(1)}s - sending sync_check (epoch=${syncEpoch.slice(0, 8)} seq=${syncSeq} transcripts=${Object.keys(transcriptCounts).length})`,
        )
        wsSend('sync_check', { epoch: syncEpoch, lastSeq: syncSeq, transcripts: transcriptCounts })
        // No force-refetch here. The sync_check response handles it:
        // - sync_ok: nothing to do (WS kept up)
        // - sync_catchup: server pushes missed messages
        // - sync_stale: bumps connectSeq which triggers proper refetch
        // Only refetch sidebar metadata if away > 30s (settings/labels may have changed)
        if (elapsed > 30_000) {
          console.log(`[sync] refetch sidebar metadata after ${(elapsed / 1000).toFixed(0)}s background`)
          fetchSidebarMetadata()
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  // Fetch events/transcript/sessions when session selected or WS reconnects.
  // Uses a per-session fetch generation tracker to avoid the iOS resume storm:
  // when sync_stale bumps connectSeq, only the CURRENTLY SELECTED session is
  // re-fetched immediately. Other sessions lazy-load when the user switches to them.
  const isConnected = useSessionsStore(state => state.isConnected)
  const connectSeq = useSessionsStore(state => state.connectSeq)

  // Track which connectSeq each session was last fetched at.
  // When connectSeq bumps, sessions with fetchedAt < connectSeq are stale.
  const fetchedAtRef = useRef<Record<string, number>>({})

  // Helper: fetch events + transcript for a session.
  // Deduplicates within a short window to prevent storm on rapid switches.
  const fetchSessionData = useCallback(
    (sessionId: string, reason?: string) => {
      const now = Date.now()
      const lastFetch = fetchedAtRef.current[sessionId] || 0
      const elapsed = now - lastFetch
      if (elapsed < 2000) {
        console.log(`[sync] SKIP fetch ${sessionId.slice(0, 8)} (${reason || '?'}) - fetched ${elapsed}ms ago`)
        return
      }
      const cachedCount = useSessionsStore.getState().transcripts[sessionId]?.length ?? 0
      console.log(
        `[sync] FETCH ${sessionId.slice(0, 8)} (${reason || '?'}) cached=${cachedCount} lastFetch=${lastFetch ? `${elapsed}ms ago` : 'never'}`,
      )
      fetchedAtRef.current[sessionId] = now
      // Batch both fetches into a single state update to avoid useSyncExternalStore tearing (#310)
      Promise.all([fetchSessionEvents(sessionId), fetchTranscript(sessionId)]).then(([events, transcript]) => {
        console.log(
          `[sync] GOT ${sessionId.slice(0, 8)}: events=${events.length} transcript=${transcript?.length ?? 'null'} (was ${cachedCount})`,
        )
        setEvents(sessionId, events)
        if (transcript) setTranscript(sessionId, transcript)
      })
    },
    [setEvents, setTranscript],
  )

  // On connectSeq bump (WS reconnect or sync_stale): refresh session list
  // and re-fetch current session. Non-current sessions were evicted from LIFO
  // cache in onopen - they'll be fetched fresh when the user navigates to them.
  useEffect(() => {
    if (!isConnected) return
    const sid = useSessionsStore.getState().selectedSessionId
    console.log(
      `[sync] connectSeq=${connectSeq} - refresh sessions + sidebar metadata, re-fetch ${sid?.slice(0, 8) || 'none'}`,
    )
    wsSend('refresh_sessions')
    fetchSidebarMetadata()
    fetchedAtRef.current = {}
    if (sid) fetchSessionData(sid, 'reconnect')
  }, [connectSeq, fetchSessionData, fetchSidebarMetadata]) // eslint-disable-line react-hooks/exhaustive-deps

  // On session switch: fetch only if transcript not in LIFO cache.
  // Cached sessions have active WS subscriptions pushing entries in real-time.
  // The subscription diff subscriber ensures all cached sessions stay subscribed
  // even across WS reconnects (clearSubscribedSessions in onopen).
  useEffect(() => {
    if (!selectedSessionId || !isConnected) return
    const cached = (useSessionsStore.getState().transcripts[selectedSessionId]?.length ?? 0) > 0
    if (!cached) {
      fetchSessionData(selectedSessionId, 'session-switch-empty')
    }
  }, [selectedSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // LIFO cache timeout: evict non-selected sessions older than sessionCacheTimeout
  const cacheTimestamps = useRef<Record<string, number>>({})
  useEffect(() => {
    if (selectedSessionId) cacheTimestamps.current[selectedSessionId] = Date.now()
  }, [selectedSessionId])

  useEffect(() => {
    const interval = setInterval(() => {
      const { sessionCacheTimeout } = useSessionsStore.getState().dashboardPrefs
      if (sessionCacheTimeout <= 0) return // 0 = never timeout
      const now = Date.now()
      const timeoutMs = sessionCacheTimeout * 60_000
      const selected = useSessionsStore.getState().selectedSessionId
      const transcripts = useSessionsStore.getState().transcripts
      let evicted = false
      for (const sid of Object.keys(transcripts)) {
        if (sid === selected) continue // never evict selected
        const lastViewed = cacheTimestamps.current[sid] || 0
        if (now - lastViewed > timeoutMs) {
          delete cacheTimestamps.current[sid]
          evicted = true
        }
      }
      if (evicted) {
        // Trigger a store update to clear evicted transcripts
        useSessionsStore.setState(state => {
          const kept = new Set(state.sessionMru.slice(0, state.dashboardPrefs.sessionCacheSize))
          if (state.selectedSessionId) kept.add(state.selectedSessionId)
          // Remove timed-out entries
          const events = { ...state.events }
          const transcripts = { ...state.transcripts }
          for (const sid of Object.keys(transcripts)) {
            if (!kept.has(sid)) {
              delete events[sid]
              delete transcripts[sid]
            }
          }
          return { events, transcripts }
        })
      }
    }, 60_000) // check every minute
    return () => clearInterval(interval)
  }, [])

  // Close sheet when a session is selected (mobile UX)
  useEffect(() => {
    if (selectedSessionId) {
      setSheetOpen(false)
    }
  }, [selectedSessionId])

  // ── Global commands (registered via key-layers, show in palette + help) ──

  useCommand(
    'open-switcher',
    () => {
      const store = useSessionsStore.getState()
      if (store.showTerminal) store.setShowTerminal(false)
      store.toggleSwitcher()
    },
    { label: 'Session switcher', shortcut: 'mod+k', group: 'Navigation' },
  )

  useCommand(
    'toggle-verbose',
    () => {
      useSessionsStore.getState().toggleExpandAll()
    },
    { label: 'Toggle verbose / expand all', shortcut: 'mod+o', group: 'View' },
  )

  useCommand(
    'toggle-sidebar',
    () => {
      toggleSidebar()
    },
    { label: 'Toggle sidebar', shortcut: 'mod+b', group: 'View' },
  )

  useCommand(
    'toggle-debug',
    () => {
      useSessionsStore.getState().toggleDebugConsole()
    },
    { label: 'Toggle debug console', shortcut: 'mod+shift+d', group: 'View' },
  )

  useCommand(
    'toggle-tty',
    () => {
      const store = useSessionsStore.getState()
      if (store.showTerminal) {
        store.setShowTerminal(false)
        if (store.selectedSessionId) store.openTab(store.selectedSessionId, 'transcript')
      } else if (store.selectedSessionId) {
        const currentTab = store.requestedTab
        store.openTab(store.selectedSessionId, currentTab === 'tty' ? 'transcript' : 'tty')
      }
    },
    { label: 'Toggle terminal tab', shortcut: 'mod+shift+t', group: 'Navigation' },
  )

  useCommand(
    'fullscreen-terminal',
    () => {
      const store = useSessionsStore.getState()
      if (store.showTerminal) {
        store.setShowTerminal(false)
        if (store.selectedSessionId) store.openTab(store.selectedSessionId, 'transcript')
      } else {
        const session = store.sessions.find(s => s.id === store.selectedSessionId)
        if (session && canTerminal(session) && session.wrapperIds?.[0]) {
          store.openTerminal(session.wrapperIds[0])
        }
      }
    },
    { label: 'Toggle fullscreen terminal', shortcut: 'mod+shift+alt+t', group: 'Navigation' },
  )

  useCommand(
    'spawn-session',
    () => {
      useSessionsStore.getState().openSwitcherWithFilter('S:./')
    },
    { label: 'Spawn new session', shortcut: 'mod+shift+s', group: 'Session' },
  )

  useCommand(
    'open-notes',
    () => {
      const store = useSessionsStore.getState()
      if (store.selectedSessionId) {
        store.openTab(store.selectedSessionId, 'files')
        store.setPendingFilePath('NOTES.md')
      }
    },
    { label: 'Open NOTES.md', shortcut: 'mod+shift+alt+n', group: 'Navigation' },
  )

  useCommand(
    'go-home',
    () => {
      if (isMobileViewport()) return
      const store = useSessionsStore.getState()
      if (store.showSwitcher || store.showDebugConsole || store.showTerminal) return
      if (!store.selectedSessionId) return
      store.selectSubagent(null)
      store.openTab(store.selectedSessionId, 'transcript')
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus())
    },
    { label: 'Go to transcript + focus input', shortcut: 'Escape', group: 'Navigation' },
  )

  useCommand(
    'interrupt',
    () => {
      const store = useSessionsStore.getState()
      const sid = store.selectedSessionId
      if (!sid) return
      const session = store.sessions.find(s => s.id === sid)
      if (session && session.status !== 'ended') {
        wsSend('send_interrupt', { sessionId: sid })
      }
    },
    { label: 'Interrupt current turn', shortcut: 'Escape Escape', group: 'Session' },
  )

  useCommand(
    'clear-reload',
    async () => {
      const { clearCacheAndReload } = await import('@/lib/utils')
      clearCacheAndReload()
    },
    { label: 'Clear cache & reload', group: 'System' },
  )

  useCommand('settings', () => window.dispatchEvent(new Event('open-settings')), { label: 'Settings', group: 'System' })

  useCommand('manage-users', () => window.dispatchEvent(new Event('open-user-admin')), {
    label: 'Manage users',
    group: 'System',
    when: () => useSessionsStore.getState().permissions.canEditUsers,
  })

  useCommand(
    'effort',
    (level = 'medium') => {
      const sid = useSessionsStore.getState().selectedSessionId
      if (sid) sendInput(sid, `/effort ${level}`)
    },
    { label: 'Set effort level', group: 'Session' },
  )

  function handleSwitcherSelect(id: string) {
    const store = useSessionsStore.getState()
    store.selectSession(id)
    store.setShowSwitcher(false)
    // Auto-focus input on desktop after session switch
    if (!isMobileViewport()) {
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus())
    }
  }

  const canAdmin = useSessionsStore(s => s.permissions.canAdmin)
  const showSessionList = true // sidebar always visible for authenticated users

  return (
    <div className="h-full flex flex-col p-2 sm:p-4 max-w-[1400px] mx-auto overflow-hidden" {...swipeHandlers}>
      {/* SW update banner */}
      {swUpdateAvailable && (
        <div className="mb-2 px-3 py-2 bg-cyan-500/10 border border-cyan-500/30 rounded font-mono text-xs text-cyan-400 flex items-center gap-2 shrink-0">
          <span className="font-bold">UPDATE</span>
          <span className="flex-1">New version available</span>
          <button
            type="button"
            onClick={() => clearCacheAndReload()}
            className="px-2 py-0.5 text-[10px] font-bold bg-cyan-500/20 border border-cyan-500/40 hover:bg-cyan-500/30 transition-colors"
          >
            RELOAD
          </button>
          <button
            type="button"
            onClick={() => setSwUpdateAvailable(false)}
            className="px-2 py-0.5 text-[10px] font-bold text-muted-foreground hover:text-foreground transition-colors"
          >
            LATER
          </button>
        </div>
      )}
      {/* Header with mobile menu */}
      <div className="flex items-center gap-2 mb-4 shrink-0">
        {/* Mobile menu button - only if session list is visible */}
        {showSessionList && (
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
        )}

        <div className="flex-1">
          <Header />
        </div>

        {/* Mobile-only buttons for touch screens without keyboards */}
        {canAdmin && (
          <Button
            variant="outline"
            size="icon"
            className="shrink-0 sm:hidden"
            onClick={() => executeCommand('quick-task')}
            title="Quick task"
          >
            <FileText className="h-4 w-4" />
          </Button>
        )}
        {canAdmin && (
          <Button
            variant="outline"
            size="icon"
            className="shrink-0 sm:hidden"
            onClick={() => useSessionsStore.getState().toggleSwitcher()}
            title="Command palette"
          >
            <Command className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Main content */}
      <div className="flex gap-4 flex-1 min-h-0 relative">
        {/* Desktop sidebar - only if session list is visible */}
        {showSessionList &&
          (sidebarCollapsed ? (
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
          ))}

        {/* Detail panel */}
        <div className="flex-1 border border-border overflow-hidden flex flex-col min-w-0">
          <SessionDetail />
        </div>
      </div>

      {/* Debug console (Ctrl+Shift+D) - admin only */}
      {canAdmin && showDebugConsole && (
        <DebugConsole onClose={() => useSessionsStore.getState().toggleDebugConsole()} />
      )}

      {/* Global session switcher (Ctrl+K from anywhere) - admin only */}
      {canAdmin && showSwitcher && (
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
      {/* Ctrl+Shift+N quick note modal - admin only */}
      {canAdmin && <QuickTaskModal />}
      {/* Shift+? shortcut help - admin only */}
      {canAdmin && <ShortcutHelp />}

      {/* User admin modal (lazy loaded, user-editor gated) */}
      {showUserAdmin && (
        <Suspense fallback={null}>
          <UserAdminDialog open={showUserAdmin} onOpenChange={setShowUserAdmin} />
        </Suspense>
      )}

      {/* Voice FAB (touch) + Voice Key (keyboard push-to-talk) + Action FAB (mobile) */}
      <VoiceFabGate />
      <ActionFabGate />
      <VoiceKey />

      {/* Auth expired modal */}
      <AuthExpiredModal />

      {/* Spawn dialog */}
      <SpawnDialog />

      {/* Toast notifications */}
      <ToastContainer />
    </div>
  )
}

function AuthExpiredModal() {
  const authExpired = useSessionsStore(s => s.authExpired)
  if (!authExpired) return null

  function handleSignOut() {
    fetch('/auth/logout', { method: 'POST' }).finally(() => {
      window.location.reload()
    })
  }

  return (
    <div className="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center p-4">
      <div className="w-full max-w-sm border border-destructive/50 bg-background p-6 font-mono text-center space-y-4">
        <div className="text-destructive text-lg font-bold tracking-wider">SESSION EXPIRED</div>
        <div className="text-sm text-muted-foreground">
          Your authentication session has expired or was revoked. Sign in again to continue.
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          className="w-full px-4 py-3 bg-destructive text-destructive-foreground font-bold text-sm hover:bg-destructive/80 transition-colors"
        >
          SIGN IN AGAIN
        </button>
      </div>
    </div>
  )
}

// Voice FAB gate - show on touch devices with pref enabled and active session
function VoiceFabGate() {
  const showVoiceFab = useSessionsStore(state => state.dashboardPrefs.showVoiceFab)
  const selectedSessionId = useSessionsStore(state => state.selectedSessionId)

  if (!isTouchDevice() || !showVoiceFab || !selectedSessionId) return null
  return <VoiceFab />
}

// Action FAB gate - show on touch devices with active session
function ActionFabGate() {
  const selectedSessionId = useSessionsStore(state => state.selectedSessionId)
  if (!isTouchDevice() || !selectedSessionId) return null
  return <ActionFab />
}

// Popout terminal - rendered when URL is #popout-terminal/{wrapperId}
function PopoutTerminal({ wrapperId }: { wrapperId: string }) {
  useWebSocket()

  return (
    <div className="h-full w-full">
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full text-muted-foreground">Loading terminal...</div>
        }
      >
        <WebTerminal wrapperId={wrapperId} onClose={() => window.close()} popout />
      </Suspense>
    </div>
  )
}

export function App() {
  const hash = window.location.hash.slice(1)

  // Share mode: /#/share/TOKEN - bypasses auth gate, limited UI
  const shareMatch = hash.match(/^\/?share\/(.+)$/)
  if (shareMatch) {
    // Detect share mode before any WS connections (sets the share token for WS URL)
    detectShareMode()
    return <SharedSessionView token={shareMatch[1]} />
  }

  // Popout terminal: #popout-terminal/{wrapperId}
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
