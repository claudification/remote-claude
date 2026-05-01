import { ChevronLeft, ChevronRight, Command, FileText, Menu } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { ActionFab } from '@/components/action-fab'
import { AuthGate } from '@/components/auth-gate'
import { ChordOverlay } from '@/components/chord-overlay'
import { CommandPalette } from '@/components/command-palette'
import { SessionDetail } from '@/components/conversation-detail'
import { DebugConsole } from '@/components/debug-console'
import { Header } from '@/components/header'
import { JsonInspectorDialog } from '@/components/json-inspector'
import { MediaLightbox } from '@/components/media-lightbox'
import { ProjectList } from '@/components/project-list'
import { QuickTaskModal } from '@/components/quick-task-modal'
import { ReviveDialog } from '@/components/revive-dialog'
import { SharedSessionView } from '@/components/shared-conversation-view'
import { ShortcutHelp } from '@/components/shortcut-help'
import { openSpawnDialog, SpawnDialog } from '@/components/spawn-dialog'
import { TaskBatchSelector } from '@/components/task-batch-selector'
import { openTerminateConfirm, TerminateConfirmDialog } from '@/components/terminate-confirm'
import { ToastContainer } from '@/components/toast'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { VoiceFab } from '@/components/voice-fab'
import { VoiceKey } from '@/components/voice-key'
import { fetchModelDb } from '@/lib/model-db'
import { clearShareMode, detectShareMode } from '@/lib/share-mode'

const WebTerminal = lazy(() => import('@/components/web-terminal').then(m => ({ default: m.WebTerminal })))
const UserAdminDialog = lazy(() => import('@/components/user-admin').then(m => ({ default: m.UserAdminDialog })))
const SentinelManagerDialog = lazy(() =>
  import('@/components/sentinel-manager').then(m => ({ default: m.SentinelManagerDialog })),
)

import {
  fetchGlobalSettings,
  fetchProjectOrder,
  fetchProjectSettings,
  fetchServerCapabilities,
  fetchSessionEvents,
  fetchTranscript,
  saveProjectOrder,
  sendInput,
  useConversationsStore,
  wsSend,
} from '@/hooks/use-conversations'
import { useWebSocket } from '@/hooks/use-websocket'
import { executeCommand, formatShortcut, useChordCommand, useCommand, validateChordBindings } from '@/lib/commands'
import { focusInputEditor } from '@/lib/focus-input'
import { setChordTimeout } from '@/lib/key-layers'
import { canTerminal, flattenProjectOrderTree, projectOrderTreesEqual, projectPath } from '@/lib/types'
import { clearCacheAndReload, isMobileViewport, isTouchDevice, PRE_RELOAD_KEY } from '@/lib/utils'
import { BUILD_VERSION } from '../../src/shared/version'

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
  const [sheetOpen, setSheetOpen] = useState(
    () => isMobileViewport() && !useConversationsStore.getState().selectedConversationId,
  )
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === 'true')
  const [showUserAdmin, setShowUserAdmin] = useState(false)
  const [showSentinelManager, setShowSentinelManager] = useState(false)
  const [swUpdate, setSwUpdate] = useState<{ from: string | null; to: string | null } | null>(null)

  // Listen for service worker update notifications
  useEffect(() => {
    function handleSwMessage(event: MessageEvent) {
      if (event.data?.type === 'sw-updated') {
        setSwUpdate({ from: event.data.from ?? null, to: event.data.to ?? null })
      }
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
          setSwUpdate({ from: knownHash, to: hash })
        }
      } catch {}
    }

    checkManifest()
    const timer = setInterval(checkManifest, 5 * 60 * 1000) // every 5 minutes
    return () => clearInterval(timer)
  }, [])

  // Post-reload feedback: detect whether clearCacheAndReload actually moved us
  // to a new build, and surface a toast either way.
  useEffect(() => {
    let stashed: string | null
    try {
      stashed = localStorage.getItem(PRE_RELOAD_KEY)
    } catch {
      return
    }
    if (!stashed) return
    try {
      localStorage.removeItem(PRE_RELOAD_KEY)
    } catch {}
    try {
      const { hash, ts } = JSON.parse(stashed) as { hash: string; ts: number }
      // Stale stashes (>5 min) are ignored - user probably navigated, not reloaded.
      if (!hash || typeof ts !== 'number' || Date.now() - ts > 5 * 60 * 1000) return
      const current = BUILD_VERSION.gitHashShort
      if (current && current !== hash) {
        window.dispatchEvent(
          new CustomEvent('rclaude-toast', {
            detail: { title: 'UPDATED', body: `Web build ${hash} -> ${current}` },
          }),
        )
      } else {
        window.dispatchEvent(
          new CustomEvent('rclaude-toast', {
            detail: { title: 'NO UPDATE', body: `Already on latest build (${hash})` },
          }),
        )
        // Suppress any false-positive banner from the fresh SW install.
        setSwUpdate(null)
      }
    } catch {}
  }, [])
  const selectedConversationId = useConversationsStore(s => s.selectedConversationId)
  const setEvents = useConversationsStore(s => s.setEvents)
  const setTranscript = useConversationsStore(s => s.setTranscript)
  const showSwitcher = useConversationsStore(s => s.showSwitcher)
  const showDebugConsole = useConversationsStore(s => s.showDebugConsole)
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
      fetchProjectOrder(),
      fetchModelDb(), // LiteLLM pricing + context windows (fire-and-forget)
    ])
    const flatTree = flattenProjectOrderTree(order.tree)
    const flatOrder = { ...order, tree: flatTree }
    useConversationsStore.setState({
      projectSettings: settings,
      serverCapabilities: capabilities,
      globalSettings,
      projectOrder: flatOrder,
    })
    // Repair legacy nested-group data by persisting the flattened version back.
    if (!projectOrderTreesEqual(order.tree, flatTree)) saveProjectOrder(flatOrder)
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

  // Listen for sentinel manager open event (from command palette)
  useEffect(() => {
    function handleOpen() {
      setShowSentinelManager(true)
    }
    window.addEventListener('open-sentinel-manager', handleOpen)
    return () => window.removeEventListener('open-sentinel-manager', handleOpen)
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
            useConversationsStore.getState().setAuthExpired(true)
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - reads store state inline, fetchSidebarMetadata is stable
  useEffect(() => {
    let hiddenAt = 0
    function handleVisibility() {
      if (document.hidden) {
        hiddenAt = Date.now()
        console.log('[sync] hidden')
      } else if (hiddenAt) {
        const elapsed = Date.now() - hiddenAt
        hiddenAt = 0
        const { syncEpoch, syncSeq, transcripts } = useConversationsStore.getState()
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
  const isConnected = useConversationsStore(state => state.isConnected)
  const connectSeq = useConversationsStore(state => state.connectSeq)

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
      const cachedCount = useConversationsStore.getState().transcripts[sessionId]?.length ?? 0
      console.log(
        `[sync] FETCH ${sessionId.slice(0, 8)} (${reason || '?'}) cached=${cachedCount} lastFetch=${lastFetch ? `${elapsed}ms ago` : 'never'}`,
      )
      fetchedAtRef.current[sessionId] = now
      // Batch both fetches into a single state update to avoid useSyncExternalStore tearing (#310)
      Promise.all([fetchSessionEvents(sessionId), fetchTranscript(sessionId)]).then(([events, transcript]) => {
        console.log(
          `[sync] GOT ${sessionId.slice(0, 8)}: events=${events.length} transcript=${transcript?.entries.length ?? 'null'} lastSeq=${transcript?.lastSeq ?? '-'} (was ${cachedCount})`,
        )
        setEvents(sessionId, events)
        if (transcript) setTranscript(sessionId, transcript.entries)
      })
    },
    [setEvents, setTranscript],
  )

  // On connectSeq bump (WS reconnect or sync_stale): refresh session list
  // and re-fetch current session. Non-current sessions were evicted from LIFO
  // cache in onopen - they'll be fetched fresh when the user navigates to them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: isConnected intentionally omitted - connectSeq only bumps while connected
  useEffect(() => {
    if (!isConnected) return
    const sid = useConversationsStore.getState().selectedConversationId
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: isConnected and fetchSessionData intentionally omitted - only re-run on session switch
  useEffect(() => {
    if (!selectedConversationId || !isConnected) return
    const { transcripts, events } = useConversationsStore.getState()
    const cachedTranscript = transcripts[selectedConversationId]?.length ?? 0
    const cachedEvents = events[selectedConversationId]?.length ?? 0
    if (cachedTranscript > 0) {
      console.log(
        `[sync] HIT ${selectedConversationId.slice(0, 8)}: transcript=${cachedTranscript} events=${cachedEvents} (no fetch, WS sub alive)`,
      )
    } else {
      console.log(`[sync] MISS ${selectedConversationId.slice(0, 8)}: no cached transcript, fetching full`)
      fetchSessionData(selectedConversationId, 'session-switch-empty')
    }
  }, [selectedConversationId]) // eslint-disable-line react-hooks/exhaustive-deps

  // LIFO cache timeout: evict non-selected sessions older than sessionCacheTimeout
  const cacheTimestamps = useRef<Record<string, number>>({})
  useEffect(() => {
    if (selectedConversationId) cacheTimestamps.current[selectedConversationId] = Date.now()
  }, [selectedConversationId])

  useEffect(() => {
    const interval = setInterval(() => {
      const { sessionCacheTimeout } = useConversationsStore.getState().controlPanelPrefs
      if (sessionCacheTimeout <= 0) return // 0 = never timeout
      const now = Date.now()
      const timeoutMs = sessionCacheTimeout * 60_000
      const selected = useConversationsStore.getState().selectedConversationId
      const transcripts = useConversationsStore.getState().transcripts
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
        useConversationsStore.setState(state => {
          const kept = new Set(state.sessionMru.slice(0, state.controlPanelPrefs.sessionCacheSize))
          if (state.selectedConversationId) kept.add(state.selectedConversationId)
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
    if (selectedConversationId) {
      setSheetOpen(false)
    }
  }, [selectedConversationId])

  // ── Sync chord timeout from prefs ────────────────────────────────────────
  const chordTimeoutMs = useConversationsStore(s => s.controlPanelPrefs.chordTimeoutMs)
  useEffect(() => {
    setChordTimeout(chordTimeoutMs)
  }, [chordTimeoutMs])

  // ── Global commands (registered via key-layers, show in palette + help) ──

  const openSwitcher = useCallback(() => {
    const store = useConversationsStore.getState()
    if (store.showTerminal) store.setShowTerminal(false)
    store.toggleSwitcher()
  }, [])

  const openCommandMode = useCallback(() => {
    const store = useConversationsStore.getState()
    if (store.showTerminal) store.setShowTerminal(false)
    store.openSwitcherWithFilter('>')
  }, [])

  // ⌘P -- VSCode-parity quick open (sessions + commands fuzzy-merged)
  useCommand('open-switcher', openSwitcher, {
    label: 'Command palette',
    shortcut: 'mod+p',
    group: 'Navigation',
  })

  // ⌘⇧P -- VSCode-parity command mode (opens palette pre-filled with ">")
  useCommand('open-command-mode', openCommandMode, {
    label: 'Command palette (commands)',
    shortcut: 'mod+shift+p',
    group: 'Navigation',
  })

  // Chord aliases so ⌘K K and ⌘G K both surface it in the chord overlay.
  // Chord key = "K" for palette because "P" already belongs to the project board chord.
  useChordCommand('palette-via-chord', openSwitcher, {
    label: 'Command palette',
    key: 'k',
    group: 'Navigation',
  })

  useCommand(
    'toggle-verbose',
    () => {
      useConversationsStore.getState().toggleExpandAll()
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

  useChordCommand(
    'toggle-debug',
    () => {
      useConversationsStore.getState().toggleDebugConsole()
    },
    { label: 'Toggle debug console', key: 'd', group: 'View' },
  )

  useCommand(
    'toggle-debug-direct',
    () => {
      useConversationsStore.getState().toggleDebugConsole()
    },
    { label: 'Toggle debug console', shortcut: 'ctrl+shift+d', group: 'View' },
  )

  useChordCommand(
    'toggle-tty',
    () => {
      const store = useConversationsStore.getState()
      if (store.showTerminal) {
        store.setShowTerminal(false)
        if (store.selectedConversationId) store.openTab(store.selectedConversationId, 'transcript')
      } else if (store.selectedConversationId) {
        const currentTab = store.requestedTab
        store.openTab(store.selectedConversationId, currentTab === 'tty' ? 'transcript' : 'tty')
      }
    },
    { label: 'Toggle terminal tab', key: 't', group: 'Navigation' },
  )

  useChordCommand(
    'fullscreen-terminal',
    () => {
      const store = useConversationsStore.getState()
      if (store.showTerminal) {
        store.setShowTerminal(false)
        if (store.selectedConversationId) store.openTab(store.selectedConversationId, 'transcript')
      } else {
        const session = store.selectedConversationId ? store.sessionsById[store.selectedConversationId] : undefined
        if (session && canTerminal(session) && session.conversationIds?.[0]) {
          store.openTerminal(session.conversationIds[0])
        }
      }
    },
    { label: 'Toggle fullscreen terminal', key: 'f', group: 'Navigation' },
  )

  useChordCommand(
    'spawn-session',
    () => {
      useConversationsStore.getState().openSwitcherWithFilter('S:~/')
    },
    { label: 'Spawn new session', key: 's', group: 'Session' },
  )

  useChordCommand(
    'launch-session',
    () => {
      const store = useConversationsStore.getState()
      const session = store.selectedConversationId ? store.sessionsById[store.selectedConversationId] : undefined
      const spawnPath = session
        ? projectPath(session.project) || store.controlPanelPrefs.defaultSessionCwd
        : store.controlPanelPrefs.defaultSessionCwd
      openSpawnDialog({ cwd: spawnPath || '~' })
    },
    { label: 'Launch session', key: 'l', group: 'Session' },
  )

  useChordCommand(
    'terminate-session',
    () => {
      const store = useConversationsStore.getState()
      const sid = store.selectedConversationId
      if (!sid) return
      const session = store.sessionsById[sid]
      if (!session || session.status === 'ended') return
      const name = session.title || session.agentName || null
      openTerminateConfirm(sid, name)
    },
    { label: 'Terminate session', key: 'x', group: 'Session' },
  )

  useChordCommand(
    'search-tasks',
    () => {
      useConversationsStore.getState().openSwitcherWithFilter('@')
    },
    { label: 'Search tasks', key: '/', group: 'Navigation' },
  )

  useChordCommand(
    'open-notes',
    () => {
      const store = useConversationsStore.getState()
      if (store.selectedConversationId) {
        store.openTab(store.selectedConversationId, 'files')
        store.setPendingFilePath('NOTES.md')
      }
    },
    { label: 'Open NOTES.md', key: 'o', group: 'Navigation' },
  )

  useChordCommand(
    'open-project',
    () => {
      const store = useConversationsStore.getState()
      const sid = store.selectedConversationId
      if (!sid) return
      const session = store.sessionsById[sid]
      if (session && session.status !== 'ended') {
        store.openTab(sid, 'project')
      }
    },
    { label: 'Open project board', key: 'p', group: 'Navigation' },
  )

  const goHome = useCallback(() => {
    if (isMobileViewport()) return
    const store = useConversationsStore.getState()
    if (store.showSwitcher || store.showDebugConsole || store.showTerminal) return
    if (!store.selectedConversationId) return
    store.selectSubagent(null)
    store.openTab(store.selectedConversationId, 'transcript')
    requestAnimationFrame(() => focusInputEditor())
  }, [])

  useCommand('go-home', goHome, {
    label: 'Go to transcript + focus input',
    shortcut: 'Escape',
    group: 'Navigation',
  })

  useChordCommand('go-home-chord', goHome, {
    label: 'Go to transcript',
    key: 'Space',
    group: 'Navigation',
  })

  useChordCommand(
    'toggle-ended-sessions',
    () => {
      const store = useConversationsStore.getState()
      store.updateControlPanelPrefs({ showEndedSessions: !store.controlPanelPrefs.showEndedSessions })
    },
    { label: 'Toggle show ended sessions', key: 'e', group: 'View' },
  )

  useCommand(
    'interrupt',
    () => {
      const store = useConversationsStore.getState()
      const sid = store.selectedConversationId
      if (!sid) return
      const session = store.sessionsById[sid]
      if (session && session.status !== 'ended') {
        wsSend('send_interrupt', { sessionId: sid })
      }
    },
    { label: 'Interrupt current turn', shortcut: 'Escape Escape', group: 'Session' },
  )

  useCommand(
    'switch-session',
    () => {
      const { sessionMru, sessions, selectConversation } = useConversationsStore.getState()
      const prev = sessionMru.slice(1).find(id => sessions.some(s => s.id === id))
      if (prev) selectConversation(prev, 'ctrl-tab')
    },
    { label: 'Switch to previous session', shortcut: 'ctrl+Tab', group: 'Navigation' },
  )

  const keepMicOpen = useConversationsStore(s => s.controlPanelPrefs.keepMicOpen)
  useCommand(
    'toggle-keep-mic-open',
    () => {
      const store = useConversationsStore.getState()
      const next = !store.controlPanelPrefs.keepMicOpen
      store.updateControlPanelPrefs({ keepMicOpen: next })
      if (next) {
        import('@/hooks/use-voice-recording').then(m => m.prewarmMicStream())
      }
    },
    { label: keepMicOpen ? 'Keep mic open: ON (disable)' : 'Keep mic open: OFF (enable)', group: 'Voice' },
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
    when: () => useConversationsStore.getState().permissions.canEditUsers,
  })

  useCommand('manage-sentinels', () => window.dispatchEvent(new Event('open-sentinel-manager')), {
    label: 'Manage sentinels',
    group: 'System',
    when: () => useConversationsStore.getState().permissions.canAdmin,
  })

  useCommand(
    'effort',
    (level = 'medium') => {
      const sid = useConversationsStore.getState().selectedConversationId
      if (sid) sendInput(sid, `/effort ${level}`)
    },
    { label: 'Set effort level', group: 'Session' },
  )

  // Validate chord bindings after all commands have mounted -- toast conflicts
  useEffect(() => {
    const timer = setTimeout(() => {
      const conflicts = validateChordBindings()
      for (const c of conflicts) {
        const longer = c.longerChords.map(l => formatShortcut(l.shortcut)).join(', ')
        window.dispatchEvent(
          new CustomEvent('rclaude-toast', {
            detail: {
              title: 'CHORD CONFLICT',
              body: `"${c.bindingLabel}" (${formatShortcut(c.binding)}) is also a prefix of: ${longer} -- it will only fire on timeout`,
              variant: 'warning',
            },
          }),
        )
      }
    }, 500) // short delay to let all useCommand hooks register
    return () => clearTimeout(timer)
  }, [])

  function handleSwitcherSelect(id: string) {
    const store = useConversationsStore.getState()
    store.selectConversation(id)
    store.setShowSwitcher(false)
    // Auto-focus input on desktop after session switch
    if (!isMobileViewport()) {
      requestAnimationFrame(() => focusInputEditor())
    }
  }

  const canAdmin = useConversationsStore(s => s.permissions.canAdmin)
  const showProjectList = true // sidebar always visible for authenticated users

  return (
    <div className="h-full flex flex-col p-2 sm:p-4 max-w-[1400px] mx-auto overflow-hidden" {...swipeHandlers}>
      {/* SW update banner - frontend bundle only, not wrapper/backend */}
      {swUpdate && (
        <div className="mb-2 px-3 py-2 bg-cyan-500/10 border border-cyan-500/30 rounded font-mono text-xs text-cyan-400 flex items-center gap-2 shrink-0">
          <span className="font-bold" title="New web app build available">
            WEB UPDATE
          </span>
          <span className="flex-1 truncate">
            {swUpdate.from && swUpdate.to ? `${swUpdate.from} -> ${swUpdate.to}` : 'New web build available'}
          </span>
          <button
            type="button"
            onClick={() => clearCacheAndReload()}
            className="px-2 py-0.5 text-[10px] font-bold bg-cyan-500/20 border border-cyan-500/40 hover:bg-cyan-500/30 transition-colors"
          >
            RELOAD
          </button>
          <button
            type="button"
            onClick={() => setSwUpdate(null)}
            className="px-2 py-0.5 text-[10px] font-bold text-muted-foreground hover:text-foreground transition-colors"
          >
            LATER
          </button>
        </div>
      )}
      {/* Header with mobile menu */}
      <div className="flex items-center gap-2 mb-4 shrink-0">
        {/* Mobile menu button - only if session list is visible */}
        {showProjectList && (
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
                <ProjectList />
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
            onClick={() => useConversationsStore.getState().toggleSwitcher()}
            title="Command palette"
          >
            <Command className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Main content */}
      <div className="flex gap-4 flex-1 min-h-0 relative">
        {/* Desktop sidebar - only if session list is visible */}
        {showProjectList &&
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
                <ProjectList />
              </div>
            </div>
          ))}

        {/* Detail panel */}
        <div className="flex-1 border border-border overflow-hidden flex flex-col min-w-0">
          <SessionDetail />
        </div>
      </div>

      {/* Debug console (Ctrl+Shift+D) */}
      {showDebugConsole && <DebugConsole onClose={() => useConversationsStore.getState().toggleDebugConsole()} />}

      {/* Global session switcher (Ctrl+K from anywhere) - admin only */}
      {canAdmin && showSwitcher && (
        <CommandPalette
          onSelect={handleSwitcherSelect}
          onFileSelect={(sessionId, path) => {
            const store = useConversationsStore.getState()
            store.selectConversation(sessionId)
            store.setShowSwitcher(false)
            store.openTab(sessionId, 'files')
            store.setPendingFilePath(path)
          }}
          onClose={() => useConversationsStore.getState().setShowSwitcher(false)}
        />
      )}

      {/* Global JSON inspector dialog (survives virtualizer remounts) */}
      <JsonInspectorDialog />
      {/* Global media lightbox (images / videos from markdown) */}
      <MediaLightbox />
      {/* Ctrl+Shift+N quick note modal - admin only */}
      {canAdmin && <QuickTaskModal />}
      {canAdmin && <TaskBatchSelector />}
      {/* Shift+? shortcut help - admin only */}
      {canAdmin && <ShortcutHelp />}

      {/* User admin modal (lazy loaded, user-editor gated) */}
      {showUserAdmin && (
        <Suspense fallback={null}>
          <UserAdminDialog open={showUserAdmin} onOpenChange={setShowUserAdmin} />
        </Suspense>
      )}

      {/* Sentinel manager modal (lazy loaded) */}
      {showSentinelManager && (
        <Suspense fallback={null}>
          <SentinelManagerDialog open={showSentinelManager} onOpenChange={setShowSentinelManager} />
        </Suspense>
      )}

      {/* Voice FAB (touch) + Voice Key (keyboard push-to-talk) + Action FAB (mobile) */}
      <VoiceFabGate />
      <ActionFabGate />
      <VoiceKey />

      {/* Auth expired modal */}
      <AuthExpiredModal />

      {/* Chord mode overlay (⌘K prefix; ⌘G alias) */}
      <ChordOverlay />

      {/* Spawn dialog */}
      <SpawnDialog />

      {/* Revive dialog */}
      <ReviveDialog />

      {/* Terminate confirmation (⌘K X / ⌘G X) */}
      <TerminateConfirmDialog />

      {/* Toast notifications */}
      <ToastContainer />
    </div>
  )
}

function AuthExpiredModal() {
  const authExpired = useConversationsStore(s => s.authExpired)
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
  const showVoiceFab = useConversationsStore(state => state.controlPanelPrefs.showVoiceFab)
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)

  if (!isTouchDevice() || !showVoiceFab || !selectedConversationId) return null
  return <VoiceFab />
}

// Action FAB gate - show on touch devices with active session
function ActionFabGate() {
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  if (!isTouchDevice() || !selectedConversationId) return null
  return <ActionFab />
}

// Popout terminal - rendered when URL is #popout-terminal/{conversationId}
function PopoutTerminal({ conversationId }: { conversationId: string }) {
  useWebSocket()

  return (
    <div className="h-full w-full">
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full text-muted-foreground">Loading terminal...</div>
        }
      >
        <WebTerminal conversationId={conversationId} onClose={() => window.close()} popout />
      </Suspense>
    </div>
  )
}

function ShareGate({ token }: { token: string }) {
  const [mode, setMode] = useState<'checking' | 'guest' | 'redirect'>('checking')

  useEffect(() => {
    fetch('/auth/status')
      .then(r => r.json())
      .then(data => {
        if (data.authenticated) {
          clearShareMode()
          fetch(`/api/share-resolve/${encodeURIComponent(token)}`)
            .then(r => (r.ok ? r.json() : null))
            .then(resolved => {
              const sessionId = resolved?.sessionId
              window.location.hash = sessionId ? `session/${sessionId}` : ''
              setMode('redirect')
            })
        } else {
          setMode('guest')
        }
      })
      .catch(() => setMode('guest'))
  }, [token])

  if (mode === 'checking') return null
  if (mode === 'redirect') {
    return (
      <AuthGate>
        <Dashboard />
      </AuthGate>
    )
  }
  detectShareMode()
  return <SharedSessionView token={token} />
}

export function App() {
  const hash = window.location.hash.slice(1)

  // Share mode: /#/share/TOKEN - check auth first, redirect if logged in
  const shareMatch = hash.match(/^\/?share\/(.+)$/)
  if (shareMatch) {
    return <ShareGate token={shareMatch[1]} />
  }

  // Popout terminal: #popout-terminal/{conversationId}
  const popoutMatch = hash.match(/^popout-terminal\/(.+)$/)
  if (popoutMatch) {
    return (
      <AuthGate>
        <PopoutTerminal conversationId={popoutMatch[1]} />
      </AuthGate>
    )
  }

  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  )
}
