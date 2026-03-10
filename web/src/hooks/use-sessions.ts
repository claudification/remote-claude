import { create } from 'zustand'
import type {
  HookEvent,
  ProjectSettings,
  ProjectSettingsMap,
  Session,
  SubagentInfo,
  TaskInfo,
  TranscriptEntry,
} from '@/lib/types'

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
  events: Record<string, HookEvent[]>
  transcripts: Record<string, TranscriptEntry[]>
  subagentTranscripts: Record<string, TranscriptEntry[]> // key: `${sessionId}:${agentId}`
  tasks: Record<string, TaskInfo[]>
  projectSettings: ProjectSettingsMap
  globalSettings: Record<string, unknown>
  isConnected: boolean
  agentConnected: boolean
  error: string | null
  ws: WebSocket | null
  terminalHandler: ((msg: TerminalMessage) => void) | null
  showTerminal: boolean
  terminalWrapperId: string | null
  showSwitcher: boolean
  requestedTab: string | null
  newDataSeq: number

  setSessions: (sessions: Session[]) => void
  selectSession: (id: string | null) => void
  selectSubagent: (agentId: string | null) => void
  openTab: (sessionId: string, tab: string) => void
  setShowTerminal: (show: boolean) => void
  setShowSwitcher: (show: boolean) => void
  toggleSwitcher: () => void
  openTerminal: (wrapperId: string) => void
  setEvents: (sessionId: string, events: HookEvent[]) => void
  setTranscript: (sessionId: string, entries: TranscriptEntry[]) => void
  setTasks: (sessionId: string, tasks: TaskInfo[]) => void
  setProjectSettings: (settings: ProjectSettingsMap) => void
  setConnected: (connected: boolean) => void
  setAgentConnected: (connected: boolean) => void
  setError: (error: string | null) => void
  setWs: (ws: WebSocket | null) => void
  setTerminalHandler: (handler: ((msg: TerminalMessage) => void) | null) => void
  sendWsMessage: (msg: Record<string, unknown>) => void

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
  events: {},
  transcripts: {},
  subagentTranscripts: {},
  tasks: {},
  projectSettings: {},
  globalSettings: {},
  isConnected: false,
  agentConnected: false,
  error: null,
  ws: null,
  terminalHandler: null,
  showTerminal: false,
  terminalWrapperId: null,
  showSwitcher: false,
  requestedTab: null,
  newDataSeq: 0,

  setSessions: sessions => set({ sessions }),
  selectSession: id => {
    set({ selectedSessionId: id, selectedSubagentId: null, requestedTab: null })
    updateHash(id ? `session/${id}` : '')
  },
  selectSubagent: agentId => {
    set({ selectedSubagentId: agentId })
  },
  openTab: (sessionId, tab) => {
    set({ selectedSessionId: sessionId, requestedTab: tab })
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
  toggleSwitcher: () => set(state => ({ showSwitcher: !state.showSwitcher })),
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
  setConnected: connected => set({ isConnected: connected }),
  setAgentConnected: connected => set({ agentConnected: connected }),
  setError: error => set({ error }),
  setWs: ws => set({ ws }),
  setTerminalHandler: handler => set({ terminalHandler: handler }),
  sendWsMessage: msg => {
    const { ws } = get()
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
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

export async function fetchSessionEvents(sessionId: string): Promise<HookEvent[]> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/events?limit=200`)
  if (!res.ok) throw new Error('Failed to fetch events')
  return res.json()
}

export async function fetchTranscript(sessionId: string): Promise<TranscriptEntry[]> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/transcript?limit=500`)
  if (!res.ok) return []
  return res.json()
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

export async function reviveSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/revive`, { method: 'POST' })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Request failed' }))
    return { success: false, error: data.error || `HTTP ${res.status}` }
  }
  return { success: true }
}

export async function sendInput(sessionId: string, input: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  })
  return res.ok
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
  } catch (error: any) {
    console.error('[push] Subscribe error:', error)
    return { success: false, error: error?.message || 'Unknown error' }
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

// Project settings API
export async function fetchProjectSettings(): Promise<ProjectSettingsMap> {
  const res = await fetch(`${API_BASE}/api/settings/projects`)
  if (!res.ok) return {}
  return res.json()
}

export async function updateProjectSettings(
  cwd: string,
  settings: ProjectSettings,
): Promise<ProjectSettingsMap | null> {
  const res = await fetch(`${API_BASE}/api/settings/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, settings }),
  })
  if (!res.ok) return null
  const data = await res.json()
  return data.settings
}

export async function deleteProjectSettings(cwd: string): Promise<ProjectSettingsMap | null> {
  const res = await fetch(`${API_BASE}/api/settings/projects`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd }),
  })
  if (!res.ok) return null
  const data = await res.json()
  return data.settings
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
