import { create } from 'zustand'
import {
  type DashboardPrefs,
  loadPrefs,
  resolveToolDisplay,
  type ToolDisplayKey,
  type ToolDisplayPrefs,
} from '@/lib/dashboard-prefs'
import { clearExpandedState } from '@/lib/expanded-state'
import { DEFAULT_PERMISSIONS, type ResolvedPermissions } from '@/lib/permissions'
import { appendShareParam } from '@/lib/share-mode'
import type {
  HookEvent,
  ProjectSettings,
  ProjectSettingsMap,
  Session,
  SessionOrderV2,
  SubagentInfo,
  TaskInfo,
  TranscriptEntry,
} from '@/lib/types'
import { recordOut } from './ws-stats'

export type { ProjectSettingsMap }

// Background task output streaming - module-level to avoid Zustand re-renders on every chunk
const bgTaskOutputMap = new Map<string, string>()
const bgTaskOutputListeners = new Set<(taskId: string) => void>()

export function getBgTaskOutput(taskId: string): string {
  return bgTaskOutputMap.get(taskId) || ''
}

export function onBgTaskOutput(listener: (taskId: string) => void): () => void {
  bgTaskOutputListeners.add(listener)
  return () => bgTaskOutputListeners.delete(listener)
}

const BG_TASK_OUTPUT_MAX = 100 * 1024 // 100KB per task

export function handleBgTaskOutputMessage(msg: { taskId: string; data: string; done: boolean }) {
  if (msg.data) {
    let existing = bgTaskOutputMap.get(msg.taskId) || ''
    existing += msg.data
    // Cap at 100KB - keep the tail (most recent output)
    if (existing.length > BG_TASK_OUTPUT_MAX) {
      existing = existing.slice(-BG_TASK_OUTPUT_MAX)
    }
    bgTaskOutputMap.set(msg.taskId, existing)
  }
  if (msg.done) {
    // Clean up after a delay to let UI read final output
    setTimeout(() => bgTaskOutputMap.delete(msg.taskId), 60_000)
  }
  for (const listener of bgTaskOutputListeners) {
    listener(msg.taskId)
  }
}

export interface TerminalMessage {
  type: 'terminal_data' | 'terminal_error'
  wrapperId: string
  data?: string
  error?: string
}

interface SessionsState {
  sessions: Session[]
  selectedSessionId: string | null
  selectedSubagentId: string | null
  sessionMru: string[]
  events: Record<string, HookEvent[]>
  transcripts: Record<string, TranscriptEntry[]>
  subagentTranscripts: Record<string, TranscriptEntry[]> // key: `${sessionId}:${agentId}`
  tasks: Record<string, TaskInfo[]>
  projectSettings: ProjectSettingsMap
  globalSettings: Record<string, unknown>
  permissions: ResolvedPermissions
  /** Per-session resolved permissions (keyed by sessionId) */
  sessionPermissions: Record<string, ResolvedPermissions>
  sessionOrder: SessionOrderV2
  serverCapabilities: { voice: boolean }
  setServerCapabilities: (caps: { voice: boolean }) => void
  isConnected: boolean
  connectSeq: number // increments on each WS connect, used to trigger re-fetches
  syncEpoch: string // server epoch (changes on server restart)
  syncSeq: number // last received sequence number
  agentConnected: boolean
  error: string | null
  authExpired: boolean
  ws: WebSocket | null
  terminalHandler: ((msg: TerminalMessage) => void) | null
  showTerminal: boolean
  terminalWrapperId: string | null
  showSwitcher: boolean
  switcherInitialFilter: string
  showDebugConsole: boolean
  pendingLinkRequests: Array<{ fromSession: string; fromProject: string; toSession: string; toProject: string }>
  respondToLinkRequest: (fromSession: string, toSession: string, action: 'approve' | 'block') => void
  pendingPermissions: Array<{
    sessionId: string
    requestId: string
    toolName: string
    description: string
    inputPreview: string
    timestamp: number
  }>
  respondToPermission: (sessionId: string, requestId: string, behavior: 'allow' | 'deny') => void
  sendPermissionRule: (sessionId: string, toolName: string, behavior: 'allow' | 'deny') => void
  pendingAskQuestions: Array<{
    sessionId: string
    toolUseId: string
    questions: Array<{
      question: string
      header: string
      options: Array<{ label: string; description: string; preview?: string }>
      multiSelect?: boolean
    }>
    timestamp: number
  }>
  respondToAskQuestion: (
    sessionId: string,
    toolUseId: string,
    answers?: Record<string, string>,
    annotations?: Record<string, { preview?: string; notes?: string }>,
    skip?: boolean,
  ) => void
  // Explorer dialog state (pending per session)
  pendingExplorers: Record<
    string,
    {
      explorerId: string
      layout: import('@shared/explorer-schema').ExplorerLayout
      timestamp: number
    }
  >
  submitExplorer: (
    sessionId: string,
    explorerId: string,
    result: import('@shared/explorer-schema').ExplorerResult,
  ) => void
  dismissExplorer: (sessionId: string, explorerId: string) => void
  keepaliveExplorer: (sessionId: string, explorerId: string) => void

  clipboardCaptures: Array<{
    id: string
    sessionId: string
    contentType: 'text' | 'image'
    text?: string
    base64?: string
    mimeType?: string
    timestamp: number
  }>
  dismissClipboard: (id: string) => void
  requestedTab: string | null
  requestedTabSeq: number
  pendingFilePath: string | null
  newDataSeq: number
  expandAll: boolean
  versionMismatch: boolean
  toggleExpandAll: () => void

  // Dashboard prefs (per-device, persisted to localStorage)
  dashboardPrefs: DashboardPrefs
  updateDashboardPrefs: (patch: Partial<DashboardPrefs>) => void
  resolveToolDisplay: (tool: ToolDisplayKey) => ToolDisplayPrefs

  setSessions: (sessions: Session[]) => void
  selectSession: (id: string | null) => void
  selectSubagent: (agentId: string | null) => void
  openTab: (sessionId: string, tab: string) => void
  setShowTerminal: (show: boolean) => void
  setShowSwitcher: (show: boolean) => void
  toggleSwitcher: () => void
  openSwitcherWithFilter: (filter: string) => void
  toggleDebugConsole: () => void
  openTerminal: (wrapperId: string) => void
  setEvents: (sessionId: string, events: HookEvent[]) => void
  setTranscript: (sessionId: string, entries: TranscriptEntry[]) => void
  setTasks: (sessionId: string, tasks: TaskInfo[]) => void
  setProjectSettings: (settings: ProjectSettingsMap) => void
  setSessionOrder: (order: SessionOrderV2) => void
  setConnected: (connected: boolean) => void
  setAgentConnected: (connected: boolean) => void
  setError: (error: string | null) => void
  setAuthExpired: (expired: boolean) => void
  setWs: (ws: WebSocket | null) => void
  setTerminalHandler: (handler: ((msg: TerminalMessage) => void) | null) => void
  fileHandler: ((msg: Record<string, unknown>) => void) | null
  setFileHandler: (handler: ((msg: Record<string, unknown>) => void) | null) => void
  taskNotesHandler: ((msg: Record<string, unknown>) => void) | null
  sendWsMessage: (msg: Record<string, unknown>) => void
  dismissSession: (sessionId: string) => void
  setPendingFilePath: (path: string | null) => void
  inputDrafts: Record<string, string>
  setInputDraft: (sessionId: string, text: string) => void

  shares: Array<{
    token: string
    sessionCwd: string
    createdAt: number
    expiresAt: number
    createdBy: string
    label?: string
    permissions: string[]
    viewerCount: number
  }>
  setShares: (
    shares: Array<{
      token: string
      sessionCwd: string
      createdAt: number
      expiresAt: number
      createdBy: string
      label?: string
      permissions: string[]
      viewerCount: number
    }>,
  ) => void

  getSelectedSession: () => Session | undefined
  getSelectedEvents: () => HookEvent[]
  getSelectedTranscript: () => TranscriptEntry[]
}

function updateHash(fragment: string) {
  const next = fragment ? `#${fragment}` : ''
  if (window.location.hash !== next) {
    history.replaceState(null, '', next || window.location.pathname)
  }
}

let hashApplied = false

export function applyHashRoute() {
  if (hashApplied) return
  hashApplied = true

  processHash()

  // Auto-select default session if no hash route matched
  applyDefaultSession()

  // Listen for hash changes from service worker navigation (push notification deep links)
  window.addEventListener('hashchange', () => processHash())

  // Listen for postMessage from service worker (notification click deep links)
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'navigate-session' && event.data.sessionId) {
      useSessionsStore.getState().selectSession(event.data.sessionId)
    }
  })
}

let defaultApplied = false

const STATUS_PRIORITY: Record<string, number> = { active: 0, idle: 1, starting: 2, ended: 3 }

function findBestSessionForCwd(sessions: Session[], cwd: string): Session | undefined {
  return sessions
    .filter(s => s.cwd === cwd)
    .sort(
      (a, b) => (STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9) || b.lastActivity - a.lastActivity,
    )[0]
}

function applyDefaultSession() {
  if (defaultApplied) return
  defaultApplied = true
  const store = useSessionsStore.getState()
  // Don't override if a session was already selected (hash route, deep link, etc.)
  if (store.selectedSessionId) return

  // Try configured default session CWD
  const cwd = store.dashboardPrefs.defaultSessionCwd
  if (cwd) {
    const best = findBestSessionForCwd(store.sessions, cwd)
    if (best) {
      store.selectSession(best.id)
      return
    }
  }

  // Auto-select if only one non-ended session visible (common for restricted users)
  const activeSessions = store.sessions.filter(s => s.status !== 'ended')
  if (activeSessions.length === 1) {
    store.selectSession(activeSessions[0].id)
  }
}

function processHash() {
  const hash = window.location.hash.slice(1)
  if (!hash) return

  const [mode, id] = hash.split('/')
  if (!id) return

  const store = useSessionsStore.getState()
  if (mode === 'terminal') {
    store.openTerminal(id) // id is wrapperId
  } else if (mode === 'session') {
    store.selectSession(id)
  }
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  selectedSessionId: null,
  selectedSubagentId: null,
  sessionMru: [],
  events: {},
  transcripts: {},
  subagentTranscripts: {},
  tasks: {},
  projectSettings: {},
  globalSettings: {},
  permissions: DEFAULT_PERMISSIONS,
  sessionPermissions: {},
  sessionOrder: { version: 2, tree: [] },
  serverCapabilities: { voice: false },
  setServerCapabilities: caps => set({ serverCapabilities: caps }),
  isConnected: false,
  connectSeq: 0,
  syncEpoch: '',
  syncSeq: 0,
  agentConnected: false,
  error: null,
  authExpired: false,
  ws: null,
  terminalHandler: null,
  fileHandler: null,
  taskNotesHandler: null,
  showTerminal: false,
  terminalWrapperId: null,
  showSwitcher: false,
  switcherInitialFilter: '',
  showDebugConsole: false,
  pendingLinkRequests: [],
  respondToLinkRequest: (fromSession, toSession, action) => {
    wsSend('channel_link_response', { fromSession, toSession, action })
    useSessionsStore.setState(state => ({
      pendingLinkRequests: state.pendingLinkRequests.filter(
        r => !(r.fromSession === fromSession && r.toSession === toSession),
      ),
    }))
  },
  pendingPermissions: [],
  respondToPermission: (sessionId, requestId, behavior) => {
    wsSend('permission_response', { sessionId, requestId, behavior })
    useSessionsStore.setState(state => ({
      pendingPermissions: state.pendingPermissions.filter(p => p.requestId !== requestId),
    }))
  },
  sendPermissionRule: (sessionId, toolName, behavior) => {
    wsSend('permission_rule', { sessionId, toolName, behavior })
  },
  pendingAskQuestions: [],
  respondToAskQuestion: (sessionId, toolUseId, answers, annotations, skip) => {
    wsSend('ask_answer', { sessionId, toolUseId, answers, annotations, skip })
    useSessionsStore.setState(state => ({
      pendingAskQuestions: state.pendingAskQuestions.filter(q => q.toolUseId !== toolUseId),
    }))
  },
  pendingExplorers: {},
  submitExplorer: (sessionId, explorerId, result) => {
    const { ws } = get()
    if (ws?.readyState === WebSocket.OPEN) {
      const msg = JSON.stringify({
        type: 'explorer_result',
        sessionId,
        explorerId,
        result,
      })
      ws.send(msg)
      recordOut(msg.length)
    }
    set(state => {
      const updated = { ...state.pendingExplorers }
      delete updated[sessionId]
      return { pendingExplorers: updated }
    })
  },
  dismissExplorer: (sessionId, explorerId) => {
    const { ws } = get()
    if (ws?.readyState === WebSocket.OPEN) {
      const msg = JSON.stringify({
        type: 'explorer_result',
        sessionId,
        explorerId,
        result: { _action: 'submit', _timeout: false, _cancelled: true },
      })
      ws.send(msg)
      recordOut(msg.length)
    }
    set(state => {
      const updated = { ...state.pendingExplorers }
      delete updated[sessionId]
      return { pendingExplorers: updated }
    })
  },
  keepaliveExplorer: (sessionId, explorerId) => {
    const { ws } = get()
    if (ws?.readyState === WebSocket.OPEN) {
      const msg = JSON.stringify({ type: 'explorer_keepalive', sessionId, explorerId })
      ws.send(msg)
      recordOut(msg.length)
    }
  },
  clipboardCaptures: [],
  dismissClipboard: id =>
    useSessionsStore.setState(state => ({
      clipboardCaptures: state.clipboardCaptures.filter(c => c.id !== id),
    })),
  requestedTab: null,
  requestedTabSeq: 0,
  pendingFilePath: null,
  inputDrafts: {},
  setInputDraft: (sessionId, text) => set(state => ({ inputDrafts: { ...state.inputDrafts, [sessionId]: text } })),
  newDataSeq: 0,
  shares: [],
  setShares: shares => set({ shares }),
  expandAll: localStorage.getItem('expandAll') === 'true',
  versionMismatch: false,
  toggleExpandAll: () =>
    set(state => {
      const next = !state.expandAll
      localStorage.setItem('expandAll', String(next))
      return { expandAll: next }
    }),

  dashboardPrefs: loadPrefs(),
  updateDashboardPrefs: patch =>
    set(state => {
      const next = { ...state.dashboardPrefs, ...patch }
      localStorage.setItem('dashboard-prefs', JSON.stringify(next))
      window.dispatchEvent(new Event('prefs-changed'))
      return { dashboardPrefs: next }
    }),
  resolveToolDisplay: (tool: ToolDisplayKey) => resolveToolDisplay(get().dashboardPrefs, tool),

  setSessions: sessions => set({ sessions }),
  selectSession: id => {
    clearExpandedState()
    const defaultView = get().dashboardPrefs.defaultView
    set(state => {
      const mru = id ? [id, ...state.sessionMru.filter(s => s !== id)] : state.sessionMru
      const { sessionCacheSize } = state.dashboardPrefs

      // LIFO cache: keep data for the N most recently viewed sessions
      // Sessions beyond the cache limit get their data evicted
      const cachedIds = new Set(mru.slice(0, Math.max(1, sessionCacheSize)))
      if (id) cachedIds.add(id)

      const events: Record<string, HookEvent[]> = {}
      const transcripts: Record<string, TranscriptEntry[]> = {}
      const subagentTranscripts: Record<string, TranscriptEntry[]> = {}
      for (const sid of cachedIds) {
        if (state.events[sid]) events[sid] = state.events[sid]
        if (state.transcripts[sid]) transcripts[sid] = state.transcripts[sid]
        for (const key of Object.keys(state.subagentTranscripts)) {
          if (key.startsWith(`${sid}:`)) subagentTranscripts[key] = state.subagentTranscripts[key]
        }
      }

      // Close terminal on session switch - PTY is tied to a wrapperId,
      // keeping it open would stream the old session's terminal
      const closeTerminal = state.showTerminal ? { showTerminal: false, terminalWrapperId: null } : {}
      return {
        selectedSessionId: id,
        selectedSubagentId: null,
        requestedTab: defaultView === 'tty' ? 'tty' : 'transcript',
        requestedTabSeq: state.requestedTabSeq + 1,
        sessionMru: mru,
        events,
        transcripts,
        subagentTranscripts,
        ...closeTerminal,
      }
    })
    updateHash(id ? `session/${id}` : '')
    // Clear notification badge when viewing a session
    if (id) {
      const session = get().sessions.find(s => s.id === id)
      if (session?.hasNotification) {
        get().sendWsMessage({ type: 'session_viewed', sessionId: id })
      }
    }
  },
  selectSubagent: agentId => {
    set({ selectedSubagentId: agentId })
  },
  openTab: (sessionId, tab) => {
    set(state => ({
      selectedSessionId: sessionId,
      requestedTab: tab,
      requestedTabSeq: state.requestedTabSeq + 1,
    }))
    updateHash(`session/${sessionId}`)
  },
  setShowTerminal: show => {
    set({ showTerminal: show, ...(!show && { terminalWrapperId: null }) })
    if (!show) {
      const { selectedSessionId } = get()
      updateHash(selectedSessionId ? `session/${selectedSessionId}` : '')
    }
  },
  setShowSwitcher: show => set({ showSwitcher: show }),
  toggleSwitcher: () => set(state => ({ showSwitcher: !state.showSwitcher, switcherInitialFilter: '' })),
  openSwitcherWithFilter: (filter: string) => set({ showSwitcher: true, switcherInitialFilter: filter }),
  toggleDebugConsole: () => set(state => ({ showDebugConsole: !state.showDebugConsole })),
  openTerminal: wrapperId => {
    // Find the session that owns this wrapper so we can select it in the main panel too
    const { sessions } = get()
    const ownerSession = sessions.find(s => s.wrapperIds?.includes(wrapperId))
    set({
      selectedSessionId: ownerSession?.id ?? null,
      terminalWrapperId: wrapperId,
      showTerminal: true,
      showSwitcher: false,
    })
    updateHash(`terminal/${wrapperId}`)
  },
  setEvents: (sessionId, events) =>
    set(state => ({ events: { ...state.events, [sessionId]: events }, newDataSeq: state.newDataSeq + 1 })),
  setTranscript: (sessionId, entries) =>
    set(state => ({ transcripts: { ...state.transcripts, [sessionId]: entries }, newDataSeq: state.newDataSeq + 1 })),
  setTasks: (sessionId, tasks) => set(state => ({ tasks: { ...state.tasks, [sessionId]: tasks } })),
  setProjectSettings: settings => set({ projectSettings: settings }),
  setSessionOrder: order => set({ sessionOrder: order }),
  setConnected: connected =>
    set(state => ({
      isConnected: connected,
      ...(connected && { connectSeq: state.connectSeq + 1 }),
    })),
  setAgentConnected: connected => set({ agentConnected: connected }),
  setError: error => set({ error }),
  setAuthExpired: authExpired => set({ authExpired }),
  setWs: ws => set({ ws }),
  setTerminalHandler: handler => set({ terminalHandler: handler }),
  setFileHandler: handler => set({ fileHandler: handler }),
  setPendingFilePath: path => set({ pendingFilePath: path }),
  sendWsMessage: msg => {
    const { ws } = get()
    if (ws?.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify(msg)
      recordOut(payload.length)
      ws.send(payload)
    }
  },
  dismissSession: sessionId => {
    wsSend('dismiss_session', { sessionId })
    set(state => ({
      sessions: state.sessions.filter(s => s.id !== sessionId),
      selectedSessionId: state.selectedSessionId === sessionId ? null : state.selectedSessionId,
    }))
  },

  getSelectedSession: () => {
    const { sessions, selectedSessionId } = get()
    return sessions.find(s => s.id === selectedSessionId)
  },
  getSelectedEvents: () => {
    const { events, selectedSessionId } = get()
    return selectedSessionId ? events[selectedSessionId] || [] : []
  },
  getSelectedTranscript: () => {
    const { transcripts, selectedSessionId } = get()
    return selectedSessionId ? transcripts[selectedSessionId] || [] : []
  },
}))

const API_BASE = ''

/**
 * Send a typed message over the dashboard WebSocket.
 * Handles JSON serialization and readyState check.
 */
export function wsSend(type: string, data?: Record<string, unknown>): boolean {
  const ws = useSessionsStore.getState().ws
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  const json = JSON.stringify({ type, ...data })
  recordOut(json.length)
  ws.send(json)
  return true
}

export async function fetchSessionEvents(sessionId: string): Promise<HookEvent[]> {
  const res = await fetch(appendShareParam(`${API_BASE}/sessions/${sessionId}/events?limit=200`))
  if (!res.ok) throw new Error('Failed to fetch events')
  return res.json()
}

export async function fetchTranscript(sessionId: string): Promise<TranscriptEntry[] | null> {
  try {
    const res = await fetch(appendShareParam(`${API_BASE}/sessions/${sessionId}/transcript?limit=500`))
    if (!res.ok) return null // null = fetch failed, don't overwrite existing
    return res.json()
  } catch {
    return null // network error
  }
}

export async function fetchSubagents(sessionId: string): Promise<SubagentInfo[]> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/subagents`)
  if (!res.ok) return []
  return res.json()
}

export async function fetchSubagentTranscript(sessionId: string, agentId: string): Promise<TranscriptEntry[]> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/subagents/${agentId}/transcript?limit=500`)
  if (!res.ok) return []
  return res.json()
}

export function reviveSession(sessionId: string): boolean {
  return wsSend('revive_session', { sessionId })
}

export function sendInput(sessionId: string, input: string): boolean {
  const crDelay = (useSessionsStore.getState().globalSettings.carriageReturnDelay as number) || 0
  return wsSend('send_input', { sessionId, input, ...(crDelay > 0 && { crDelay }) })
}

// Push notification subscription
export async function subscribeToPush(): Promise<{ success: boolean; error?: string }> {
  try {
    // Check browser support
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return { success: false, error: 'Push notifications not supported' }
    }

    // Get VAPID public key from server
    console.log('[push] Fetching VAPID key...')
    const vapidRes = await fetch(`${API_BASE}/api/push/vapid`)
    if (!vapidRes.ok) {
      console.error('[push] VAPID fetch failed:', vapidRes.status)
      return { success: false, error: 'Push not configured on server' }
    }
    const { publicKey } = await vapidRes.json()
    console.log('[push] Got VAPID key:', `${publicKey?.slice(0, 12)}...`)

    // Register service worker
    console.log('[push] Registering service worker...')
    const registration = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
    console.log('[push] Service worker ready')

    // Request notification permission
    const permission = await Notification.requestPermission()
    console.log('[push] Permission:', permission)
    if (permission !== 'granted') {
      return { success: false, error: `Permission ${permission}` }
    }

    // Subscribe to push
    console.log('[push] Subscribing to push manager...')
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    })
    console.log('[push] Got subscription:', `${subscription.endpoint.slice(0, 50)}...`)

    // Send subscription to server
    const subRes = await fetch(`${API_BASE}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    })
    console.log('[push] Subscribe response:', subRes.status)

    if (!subRes.ok) {
      return { success: false, error: 'Failed to register subscription' }
    }

    return { success: true }
  } catch (error: unknown) {
    console.error('[push] Subscribe error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function getPushStatus(): Promise<{ supported: boolean; subscribed: boolean; permission: string }> {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window
  if (!supported) return { supported, subscribed: false, permission: 'unsupported' }

  const permission = Notification.permission
  let subscribed = false

  try {
    const registration = await navigator.serviceWorker.getRegistration('/sw.js')
    if (registration) {
      const sub = await registration.pushManager.getSubscription()
      if (sub) {
        // Browser has a subscription - verify server knows about it too
        // by re-sending it (idempotent). This handles the case where
        // the browser subscribed but the server POST failed.
        try {
          const res = await fetch(`${API_BASE}/api/push/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub.toJSON() }),
          })
          subscribed = res.ok
          console.log('[push] Re-synced subscription to server:', res.status)
        } catch {
          // Server unreachable - still show as subscribed locally
          subscribed = true
        }
      }
    }
  } catch {}

  return { supported, subscribed, permission }
}

// Server capabilities
export async function fetchServerCapabilities(): Promise<{ voice: boolean }> {
  try {
    const res = await fetch(`${API_BASE}/api/capabilities`)
    if (!res.ok) return { voice: false }
    return res.json()
  } catch {
    return { voice: false }
  }
}

// Global settings API
export async function fetchGlobalSettings(): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`${API_BASE}/api/settings`)
    if (!res.ok) return {}
    return res.json()
  } catch {
    return {}
  }
}

// Project settings API
export async function fetchProjectSettings(): Promise<ProjectSettingsMap> {
  const res = await fetch(`${API_BASE}/api/settings/projects`)
  if (!res.ok) return {}
  return res.json()
}

export function updateProjectSettings(cwd: string, settings: ProjectSettings): boolean {
  return wsSend('update_project_settings', { cwd, settings })
}

export async function generateProjectKeyterms(
  cwd: string,
): Promise<{ keyterms: string[]; settings: ProjectSettingsMap } | null> {
  const res = await fetch(`${API_BASE}/api/settings/projects/generate-keyterms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export function deleteProjectSettings(cwd: string): boolean {
  return wsSend('delete_project_settings', { cwd })
}

// Session order API
export async function fetchSessionOrder(): Promise<SessionOrderV2> {
  const res = await fetch(`${API_BASE}/api/session-order`)
  if (!res.ok) return { version: 2, tree: [] }
  const data = await res.json()
  // Handle legacy v1 response from old server
  if (data.version !== 2) return { version: 2, tree: [] }
  return data
}

export function saveSessionOrder(order: SessionOrderV2): void {
  wsSend('update_session_order', { order })
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}
