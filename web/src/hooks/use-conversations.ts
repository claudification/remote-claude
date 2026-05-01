import { create } from 'zustand'
import {
  type ControlPanelPrefs,
  loadPrefs,
  resolveToolDisplay,
  type ToolDisplayKey,
  type ToolDisplayPrefs,
} from '@/lib/control-panel-prefs'
import { clearExpandedState } from '@/lib/expanded-state'
import { setPerfEnabled } from '@/lib/perf-metrics'
import { DEFAULT_PERMISSIONS, type ResolvedPermissions } from '@/lib/permissions'
import { appendShareParam } from '@/lib/share-mode'
import {
  extractProjectLabel,
  flattenProjectOrderTree,
  type HookEvent,
  type ProjectOrder,
  type ProjectSettings,
  type ProjectSettingsMap,
  type Session,
  type SubagentInfo,
  type TaskInfo,
  type TranscriptEntry,
  type UsageUpdate,
} from '@/lib/types'
import { getLastSessionId, getSessionTab, initUIState, setLastSessionId } from '@/lib/ui-state'
import { recordOut } from './ws-stats'

export type { ProjectSettingsMap }
export { extractProjectLabel }

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
  conversationId: string
  data?: string
  error?: string
}

export interface JsonStreamMessage {
  type: 'json_stream_data'
  conversationId: string
  lines: string[]
  isBackfill: boolean
}

export interface SentinelStatusInfo {
  sentinelId: string
  alias: string
  hostname?: string
  connected: boolean
  isDefault?: boolean
  color?: string
}

interface SessionsState {
  sessions: Session[]
  /** O(1) lookup index maintained alongside sessions[] */
  sessionsById: Record<string, Session>
  selectedSessionId: string | null
  selectedSubagentId: string | null
  sessionMru: string[]
  events: Record<string, HookEvent[]>
  transcripts: Record<string, TranscriptEntry[]>
  /** Per-session highest transcript entry.seq we've applied to `transcripts`.
   *  Sent back to the server in sync_check so the server can detect drift and
   *  reply with a delta (entries with seq > lastAppliedSeq) instead of a full
   *  refetch. Also used to dedup incremental transcript_entries broadcasts.
   *
   *  Reset semantics:
   *    - `sync_stale` from server -> full clear via connectSeq bump, then the
   *      initial transcript_entries (isInitial=true) reseeds from max(seqs).
   *    - Server broker restart -> SYNC_EPOCH changes -> `sync_stale`
   *      path above handles it.
   *    - Rekey on server -> sessionId changes -> old lastAppliedSeq[oldId]
   *      goes stale harmlessly (new sessionId entry in this map starts fresh). */
  lastAppliedTranscriptSeq: Record<string, number>
  streamingText: Record<string, string> // sessionId -> accumulating text from headless stream deltas
  sessionInfo: Record<
    string,
    {
      tools: string[]
      slashCommands: string[]
      skills: string[]
      agents: string[]
      mcpServers: Array<{ name: string; status?: string }>
      model: string
      permissionMode: string
      claudeCodeVersion: string
    }
  >
  subagentTranscripts: Record<string, TranscriptEntry[]> // key: `${sessionId}:${agentId}`
  tasks: Record<string, TaskInfo[]>
  projectSettings: ProjectSettingsMap
  globalSettings: Record<string, unknown>
  permissions: ResolvedPermissions
  /** Per-session resolved permissions (keyed by sessionId) */
  sessionPermissions: Record<string, ResolvedPermissions>
  projectOrder: ProjectOrder
  serverCapabilities: { voice: boolean }
  setServerCapabilities: (caps: { voice: boolean }) => void
  isConnected: boolean
  connectSeq: number // increments on each WS connect, used to trigger re-fetches
  syncEpoch: string // server epoch (changes on server restart)
  syncSeq: number // last received sequence number
  sentinelConnected: boolean
  sentinels: SentinelStatusInfo[]
  planUsage: UsageUpdate | null
  error: string | null
  authExpired: boolean
  ws: WebSocket | null
  terminalHandler: ((msg: TerminalMessage) => void) | null
  jsonStreamHandler: ((msg: JsonStreamMessage) => void) | null
  showTerminal: boolean
  terminalWrapperId: string | null
  showSwitcher: boolean
  switcherInitialFilter: string
  showDebugConsole: boolean
  pendingProjectLinks: Array<{ fromSession: string; fromProject: string; toSession: string; toProject: string }>
  respondToProjectLink: (fromSession: string, toSession: string, action: 'approve' | 'block') => void
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
  // Dialog state (pending per session)
  pendingDialogs: Record<
    string,
    {
      dialogId: string
      layout: import('@shared/dialog-schema').DialogLayout
      timestamp: number
      source?: 'mcp' | 'plan_approval'
      meta?: Record<string, unknown> // requestId, toolUseId, etc.
    }
  >
  submitDialog: (sessionId: string, dialogId: string, result: import('@shared/dialog-schema').DialogResult) => void
  dismissDialog: (sessionId: string, dialogId: string) => void
  keepaliveDialog: (sessionId: string, dialogId: string) => void

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
  notifications: Array<{
    id: string
    sessionId: string
    title: string
    message: string
    timestamp: number
  }>
  dismissNotification: (id: string) => void
  clearSessionNotifications: (sessionId: string) => void
  requestedTab: string | null
  requestedTabSeq: number
  pendingFilePath: string | null
  newDataSeq: number
  expandAll: boolean
  /** @deprecated Use SW update detection instead */
  versionMismatch: boolean
  toggleExpandAll: () => void

  // Dashboard prefs (per-device, persisted to localStorage)
  controlPanelPrefs: ControlPanelPrefs
  updateControlPanelPrefs: (patch: Partial<ControlPanelPrefs>) => void
  resolveToolDisplay: (tool: ToolDisplayKey) => ToolDisplayPrefs

  setSessions: (sessions: Session[]) => void
  /** Select a session. Optional `reason` is logged to console for debugging navigation bugs. */
  selectSession: (id: string | null, reason?: string) => void
  selectSubagent: (agentId: string | null) => void
  openTab: (sessionId: string, tab: string) => void
  setShowTerminal: (show: boolean) => void
  setShowSwitcher: (show: boolean) => void
  toggleSwitcher: () => void
  openSwitcherWithFilter: (filter: string) => void
  toggleDebugConsole: () => void
  openTerminal: (conversationId: string) => void
  setEvents: (sessionId: string, events: HookEvent[]) => void
  setTranscript: (sessionId: string, entries: TranscriptEntry[]) => void
  setTasks: (sessionId: string, tasks: TaskInfo[]) => void
  setProjectSettings: (settings: ProjectSettingsMap) => void
  setProjectOrder: (order: ProjectOrder) => void
  setConnected: (connected: boolean) => void
  setSentinelConnected: (connected: boolean, sentinels?: SentinelStatusInfo[]) => void
  setPlanUsage: (usage: UsageUpdate) => void
  setError: (error: string | null) => void
  setAuthExpired: (expired: boolean) => void
  setWs: (ws: WebSocket | null) => void
  setTerminalHandler: (handler: ((msg: TerminalMessage) => void) | null) => void
  setJsonStreamHandler: (handler: ((msg: JsonStreamMessage) => void) | null) => void
  fileHandler: ((msg: Record<string, unknown>) => void) | null
  setFileHandler: (handler: ((msg: Record<string, unknown>) => void) | null) => void
  projectHandler: ((msg: Record<string, unknown>) => void) | null
  sendWsMessage: (msg: Record<string, unknown>) => void
  dismissSession: (sessionId: string) => void
  terminateSession: (sessionId: string) => void
  renamingSessionId: string | null
  setRenamingSessionId: (sessionId: string | null) => void
  renameSession: (sessionId: string, name: string, description?: string) => void
  editingDescriptionSessionId: string | null
  setEditingDescriptionSessionId: (sessionId: string | null) => void
  updateDescription: (sessionId: string, description: string) => void
  setPendingFilePath: (path: string | null) => void
  pendingTaskEdit: { slug: string; status: string } | null
  setPendingTaskEdit: (task: { slug: string; status: string } | null) => void
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
    hideUserInput?: boolean
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
      hideUserInput?: boolean
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

  initUIState()
  processHash()

  // Auto-select default session if no hash route matched
  applyDefaultSession()

  // Listen for hash changes from service worker navigation (push notification deep links)
  window.addEventListener('hashchange', () => processHash())

  // Listen for postMessage from service worker (notification click deep links)
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'navigate-session' && event.data.sessionId) {
      useConversationsStore.getState().selectSession(event.data.sessionId, 'sw-navigate-session')
    }
    if (event.data?.type === 'navigate-task' && event.data.taskId) {
      window.dispatchEvent(new CustomEvent('open-project-task', { detail: { taskId: event.data.taskId } }))
    }
  })
}

let defaultApplied = false

const STATUS_PRIORITY: Record<string, number> = { active: 0, idle: 1, starting: 2, ended: 3 }

function findBestSessionForProject(sessions: Session[], projectUri: string): Session | undefined {
  return sessions
    .filter(s => s.project === projectUri)
    .sort(
      (a, b) => (STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9) || b.lastActivity - a.lastActivity,
    )[0]
}

function applyDefaultSession() {
  if (defaultApplied) return
  defaultApplied = true
  const store = useConversationsStore.getState()
  // Don't override if a session was already selected (hash route, deep link, etc.)
  if (store.selectedSessionId) return

  // Try configured default session project
  const defaultProject = store.controlPanelPrefs.defaultSessionCwd
  if (defaultProject) {
    const best = findBestSessionForProject(store.sessions, defaultProject)
    if (best) {
      store.selectSession(best.id, 'default-session-project')
      return
    }
  }

  // Try last-viewed session from localStorage
  const lastId = getLastSessionId()
  if (lastId && store.sessionsById[lastId]) {
    store.selectSession(lastId, 'default-session-last-viewed')
    return
  }

  // Auto-select if only one non-ended session visible (common for restricted users)
  const activeSessions = store.sessions.filter(s => s.status !== 'ended')
  if (activeSessions.length === 1) {
    store.selectSession(activeSessions[0].id, 'default-session-only-active')
  }
}

function processHash() {
  const hash = window.location.hash.slice(1)
  if (!hash) return

  const [mode, id] = hash.split('/')
  if (!id) return

  const store = useConversationsStore.getState()
  if (mode === 'terminal') {
    store.openTerminal(id) // id is conversationId
  } else if (mode === 'session') {
    store.selectSession(id, 'hash-route')
  } else if (mode === 'task') {
    // Dispatch event for project board to open the task modal
    window.dispatchEvent(new CustomEvent('open-project-task', { detail: { taskId: id } }))
  }
}

/** Build an O(1) lookup index from a sessions array */
export function buildSessionsById(sessions: Session[]): Record<string, Session> {
  const map: Record<string, Session> = {}
  for (const s of sessions) map[s.id] = s
  return map
}

export const useConversationsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  sessionsById: {},
  selectedSessionId: null,
  selectedSubagentId: null,
  sessionMru: [],
  events: {},
  transcripts: {},
  lastAppliedTranscriptSeq: {},
  streamingText: {},
  sessionInfo: {},
  subagentTranscripts: {},
  tasks: {},
  projectSettings: {},
  globalSettings: {},
  permissions: DEFAULT_PERMISSIONS,
  sessionPermissions: {},
  projectOrder: { tree: [] },
  serverCapabilities: { voice: false },
  setServerCapabilities: caps => set({ serverCapabilities: caps }),
  isConnected: false,
  connectSeq: 0,
  syncEpoch: '',
  syncSeq: 0,
  sentinelConnected: false,
  sentinels: [],
  planUsage: null,
  error: null,
  authExpired: false,
  ws: null,
  terminalHandler: null,
  jsonStreamHandler: null,
  fileHandler: null,
  projectHandler: null,
  showTerminal: false,
  terminalWrapperId: null,
  showSwitcher: false,
  switcherInitialFilter: '',
  showDebugConsole: false,
  pendingProjectLinks: [],
  respondToProjectLink: (fromSession, toSession, action) => {
    wsSend('channel_link_response', { fromSession, toSession, action })
    useConversationsStore.setState(state => ({
      pendingProjectLinks: state.pendingProjectLinks.filter(
        r => !(r.fromSession === fromSession && r.toSession === toSession),
      ),
    }))
  },
  pendingPermissions: [],
  respondToPermission: (sessionId, requestId, behavior) => {
    wsSend('permission_response', { sessionId, requestId, behavior })
    useConversationsStore.setState(state => ({
      pendingPermissions: state.pendingPermissions.filter(p => p.requestId !== requestId),
    }))
  },
  sendPermissionRule: (sessionId, toolName, behavior) => {
    wsSend('permission_rule', { sessionId, toolName, behavior })
  },
  pendingAskQuestions: [],
  respondToAskQuestion: (sessionId, toolUseId, answers, annotations, skip) => {
    wsSend('ask_answer', { sessionId, toolUseId, answers, annotations, skip })
    useConversationsStore.setState(state => ({
      pendingAskQuestions: state.pendingAskQuestions.filter(q => q.toolUseId !== toolUseId),
    }))
  },
  pendingDialogs: {},
  submitDialog: (sessionId, dialogId, result) => {
    const { ws, pendingDialogs } = get()
    const pending = pendingDialogs[sessionId]
    if (ws?.readyState === WebSocket.OPEN) {
      if (pending?.source === 'plan_approval' && pending.meta) {
        // Plan approval: route as plan_approval_response instead of dialog_result
        const action = result._action === 'reject' ? 'reject' : result.feedback ? 'feedback' : 'approve'
        const msg = JSON.stringify({
          type: 'plan_approval_response',
          sessionId,
          requestId: pending.meta.requestId,
          toolUseId: pending.meta.toolUseId,
          action,
          feedback: result.feedback || undefined,
        })
        ws.send(msg)
        recordOut(msg.length)
      } else {
        const msg = JSON.stringify({
          type: 'dialog_result',
          sessionId,
          dialogId,
          result,
        })
        ws.send(msg)
        recordOut(msg.length)
      }
    }
    set(state => {
      const updated = { ...state.pendingDialogs }
      delete updated[sessionId]
      return { pendingDialogs: updated }
    })
  },
  dismissDialog: (sessionId, dialogId) => {
    const { ws, pendingDialogs } = get()
    const pending = pendingDialogs[sessionId]
    if (ws?.readyState === WebSocket.OPEN) {
      if (pending?.source === 'plan_approval' && pending.meta) {
        // Plan approval dismiss = reject
        const msg = JSON.stringify({
          type: 'plan_approval_response',
          sessionId,
          requestId: pending.meta.requestId,
          toolUseId: pending.meta.toolUseId,
          action: 'reject',
        })
        ws.send(msg)
        recordOut(msg.length)
      } else {
        const msg = JSON.stringify({
          type: 'dialog_result',
          sessionId,
          dialogId,
          result: { _action: 'submit', _timeout: false, _cancelled: true },
        })
        ws.send(msg)
        recordOut(msg.length)
      }
    }
    set(state => {
      const updated = { ...state.pendingDialogs }
      delete updated[sessionId]
      return { pendingDialogs: updated }
    })
  },
  keepaliveDialog: (sessionId, dialogId) => {
    const { ws } = get()
    if (ws?.readyState === WebSocket.OPEN) {
      const msg = JSON.stringify({ type: 'dialog_keepalive', sessionId, dialogId })
      ws.send(msg)
      recordOut(msg.length)
    }
  },
  clipboardCaptures: [],
  dismissClipboard: id =>
    useConversationsStore.setState(state => ({
      clipboardCaptures: state.clipboardCaptures.filter(c => c.id !== id),
    })),
  notifications: [],
  dismissNotification: id =>
    useConversationsStore.setState(state => ({
      notifications: state.notifications.filter(n => n.id !== id),
    })),
  clearSessionNotifications: sessionId =>
    useConversationsStore.setState(state => ({
      notifications: state.notifications.filter(n => n.sessionId !== sessionId),
    })),
  requestedTab: null,
  requestedTabSeq: 0,
  pendingFilePath: null,
  pendingTaskEdit: null,
  setPendingTaskEdit: task => set({ pendingTaskEdit: task }),
  renamingSessionId: null,
  setRenamingSessionId: sessionId => set({ renamingSessionId: sessionId }),
  renameSession: (sessionId, name, description) => {
    wsSend('rename_conversation', { sessionId, name, ...(description !== undefined ? { description } : {}) })
    set(state => {
      const sessions = state.sessions.map(s =>
        s.id === sessionId
          ? {
              ...s,
              title: name || undefined,
              ...(description !== undefined ? { description: description || undefined } : {}),
            }
          : s,
      )
      return { renamingSessionId: null, sessions, sessionsById: buildSessionsById(sessions) }
    })
  },
  editingDescriptionSessionId: null,
  setEditingDescriptionSessionId: sessionId => set({ editingDescriptionSessionId: sessionId }),
  updateDescription: (sessionId, description) => {
    const session = get().sessionsById[sessionId]
    const name = session?.title || ''
    wsSend('rename_conversation', { sessionId, name, description })
    set(state => {
      const sessions = state.sessions.map(s =>
        s.id === sessionId ? { ...s, description: description || undefined } : s,
      )
      return { editingDescriptionSessionId: null, sessions, sessionsById: buildSessionsById(sessions) }
    })
  },
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

  controlPanelPrefs: (() => {
    const prefs = loadPrefs()
    setPerfEnabled(prefs.showPerfMonitor)
    return prefs
  })(),
  updateControlPanelPrefs: patch =>
    set(state => {
      const next = { ...state.controlPanelPrefs, ...patch }
      localStorage.setItem('control-panel-prefs', JSON.stringify(next))
      window.dispatchEvent(new Event('prefs-changed'))
      if ('showPerfMonitor' in patch) setPerfEnabled(next.showPerfMonitor)
      return { controlPanelPrefs: next }
    }),
  resolveToolDisplay: (tool: ToolDisplayKey) => resolveToolDisplay(get().controlPanelPrefs, tool),

  setSessions: sessions => set({ sessions, sessionsById: buildSessionsById(sessions) }),
  selectSession: (id: string | null, reason?: string) => {
    const prev = get().selectedSessionId
    if (id !== prev) {
      console.log(
        `[nav] selectSession: ${prev?.slice(0, 8) || 'none'} -> ${id?.slice(0, 8) || 'none'}${reason ? ` (${reason})` : ''}`,
      )
    }
    clearExpandedState()
    const defaultView = get().controlPanelPrefs.defaultView
    const rememberedTab = id ? getSessionTab(id) : null
    set(state => {
      const mru = id ? [id, ...state.sessionMru.filter(s => s !== id)] : state.sessionMru
      const { sessionCacheSize } = state.controlPanelPrefs

      // LIFO cache: keep data for the N most recently viewed sessions
      const cachedIds = new Set(mru.slice(0, Math.max(1, sessionCacheSize)))
      if (id) cachedIds.add(id)

      // Only rebuild dicts if we actually need to evict sessions.
      // Check if any currently cached keys are NOT in the new cachedIds set.
      let needsEviction = false
      for (const sid of Object.keys(state.events)) {
        if (!cachedIds.has(sid)) {
          needsEviction = true
          break
        }
      }
      if (!needsEviction) {
        for (const sid of Object.keys(state.transcripts)) {
          if (!cachedIds.has(sid)) {
            needsEviction = true
            break
          }
        }
      }

      let evictedData: {
        events: Record<string, HookEvent[]>
        transcripts: Record<string, TranscriptEntry[]>
        subagentTranscripts: Record<string, TranscriptEntry[]>
      } | null = null

      if (needsEviction) {
        const events: Record<string, HookEvent[]> = {}
        const transcripts: Record<string, TranscriptEntry[]> = {}
        const subagentTranscripts: Record<string, TranscriptEntry[]> = {}
        for (const sid of cachedIds) {
          if (state.events[sid]) events[sid] = state.events[sid]
          if (state.transcripts[sid]) transcripts[sid] = state.transcripts[sid]
        }
        for (const key of Object.keys(state.subagentTranscripts)) {
          const sid = key.split(':')[0]
          if (cachedIds.has(sid)) subagentTranscripts[key] = state.subagentTranscripts[key]
        }
        evictedData = { events, transcripts, subagentTranscripts }
      }

      // Close terminal on session switch - PTY is tied to a conversationId,
      // keeping it open would stream the old session's terminal
      const closeTerminal = state.showTerminal ? { showTerminal: false, terminalWrapperId: null } : {}
      return {
        selectedSessionId: id,
        selectedSubagentId: null,
        requestedTab: rememberedTab || (defaultView === 'tty' ? 'tty' : 'transcript'),
        requestedTabSeq: state.requestedTabSeq + 1,
        sessionMru: mru,
        ...evictedData,
        ...closeTerminal,
      }
    })
    updateHash(id ? `session/${id}` : '')
    setLastSessionId(id)
    // Clear notification badge + bell notifications when viewing a session
    if (id) {
      const session = get().sessionsById[id]
      if (session?.hasNotification) {
        get().sendWsMessage({ type: 'conversation_viewed', sessionId: id })
      }
      get().clearSessionNotifications(id)
    }
  },
  selectSubagent: agentId => {
    set({ selectedSubagentId: agentId })
  },
  openTab: (sessionId, tab) => {
    const prev = get().selectedSessionId
    if (sessionId !== prev) {
      console.log(`[nav] openTab: ${prev?.slice(0, 8) || 'none'} -> ${sessionId.slice(0, 8)} tab=${tab}`)
    }
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
  openTerminal: conversationId => {
    // Find the session that owns this wrapper so we can select it in the main panel too
    const ownerSession = get().sessions.find(s => s.conversationIds?.includes(conversationId))
    const prev = get().selectedSessionId
    const next = ownerSession?.id ?? null
    if (next !== prev) {
      console.log(
        `[nav] openTerminal: ${prev?.slice(0, 8) || 'none'} -> ${next?.slice(0, 8) || 'none'} wrapper=${conversationId.slice(0, 8)}`,
      )
    }
    set({
      selectedSessionId: next,
      terminalWrapperId: conversationId,
      showTerminal: true,
      showSwitcher: false,
    })
    updateHash(`terminal/${conversationId}`)
  },
  setEvents: (sessionId, events) =>
    set(state => {
      const existing = state.events[sessionId]
      // Don't replace a larger local cache with a smaller server response.
      // WS pushes may have appended newer events since the HTTP fetch started.
      if (existing && existing.length > events.length) {
        console.log(
          `[events] SKIP replace ${sessionId.slice(0, 8)}: local=${existing.length} > server=${events.length}`,
        )
        return state
      }
      return { events: { ...state.events, [sessionId]: events }, newDataSeq: state.newDataSeq + 1 }
    }),
  setTranscript: (sessionId, entries) =>
    set(state => {
      const existing = state.transcripts[sessionId]
      // Don't replace a larger local cache with a smaller server response
      // unless the server sent an initial/full load (entries have different first entry)
      if (existing && existing.length > entries.length) {
        const firstEntry = (e: TranscriptEntry) =>
          JSON.stringify('message' in e ? (e.message as Record<string, unknown>)?.content : e.type)?.slice(0, 100)
        const existingFirst = firstEntry(existing[0])
        const newFirst = firstEntry(entries[0])
        if (existingFirst === newFirst) {
          // Same conversation, server just has fewer entries -- keep local
          console.log(
            `[transcript] SKIP replace ${sessionId.slice(0, 8)}: local=${existing.length} > server=${entries.length}`,
          )
          return state
        }
      }
      // Derive lastAppliedSeq from the stamped entries. Entries are
      // append-ordered, so the tail has the highest seq. Fall back to 0 for
      // pre-seq entries (none in practice after first deploy).
      const lastSeq = entries.length > 0 ? (entries[entries.length - 1].seq ?? 0) : 0
      return {
        transcripts: { ...state.transcripts, [sessionId]: entries },
        lastAppliedTranscriptSeq: { ...state.lastAppliedTranscriptSeq, [sessionId]: lastSeq },
        newDataSeq: state.newDataSeq + 1,
      }
    }),
  setTasks: (sessionId, tasks) => set(state => ({ tasks: { ...state.tasks, [sessionId]: tasks } })),
  setProjectSettings: settings => set({ projectSettings: settings }),
  setProjectOrder: order => set({ projectOrder: { ...order, tree: flattenProjectOrderTree(order.tree) } }),
  setConnected: connected =>
    set(state => ({
      isConnected: connected,
      ...(connected && { connectSeq: state.connectSeq + 1 }),
    })),
  setSentinelConnected: (connected, sentinels) =>
    set({ sentinelConnected: connected, ...(sentinels !== undefined && { sentinels }) }),
  setPlanUsage: usage => set({ planUsage: usage }),
  setError: error => set({ error }),
  setAuthExpired: authExpired => set({ authExpired }),
  setWs: ws => set({ ws }),
  setTerminalHandler: handler => set({ terminalHandler: handler }),
  setJsonStreamHandler: handler => set({ jsonStreamHandler: handler }),
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
    wsSend('dismiss_conversation', { sessionId })
    set(state => {
      const sessions = state.sessions.filter(s => s.id !== sessionId)
      if (state.selectedSessionId === sessionId) {
        console.log(`[nav] dismissSession: clearing selection (dismissed ${sessionId.slice(0, 8)})`)
      }
      return {
        sessions,
        sessionsById: buildSessionsById(sessions),
        selectedSessionId: state.selectedSessionId === sessionId ? null : state.selectedSessionId,
      }
    })
  },
  terminateSession: sessionId => {
    wsSend('terminate_conversation', { sessionId })
  },

  getSelectedSession: () => {
    const { sessionsById, selectedSessionId } = get()
    return selectedSessionId ? sessionsById[selectedSessionId] : undefined
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
  const ws = useConversationsStore.getState().ws
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  const json = JSON.stringify({ type, ...data })
  recordOut(json.length)
  ws.send(json)
  return true
}

export async function fetchSessionEvents(sessionId: string): Promise<HookEvent[]> {
  const res = await fetch(appendShareParam(`${API_BASE}/conversations/${sessionId}/events?limit=200`))
  if (!res.ok) throw new Error('Failed to fetch events')
  return res.json()
}

export interface TranscriptFetchResult {
  entries: TranscriptEntry[]
  /** Highest seq in the server's cache after this response. Client stores
   *  this as lastAppliedTranscriptSeq[sid] after applying entries. */
  lastSeq: number
  /** True when delta mode was requested but the server had to truncate older
   *  entries (client's sinceSeq is older than the oldest cache entry). Caller
   *  should treat the response as a full replace rather than an append, since
   *  there's a hole between client's last-known seq and the returned entries. */
  gap: boolean
}

/** Fetch transcript entries for a session.
 *  - No `sinceSeq`: returns the last N entries (full mode).
 *  - With `sinceSeq`: returns entries with seq > sinceSeq (delta mode),
 *    used after sync_check flags the session as stale. If `gap=true` in the
 *    response, the client has evicted entries it needed -- full replace. */
export async function fetchTranscript(sessionId: string, sinceSeq?: number): Promise<TranscriptFetchResult | null> {
  try {
    const qs = sinceSeq !== undefined ? `?sinceSeq=${sinceSeq}&limit=1000` : `?limit=500`
    const res = await fetch(appendShareParam(`${API_BASE}/conversations/${sessionId}/transcript${qs}`))
    if (!res.ok) return null
    const body = await res.json()
    return body as TranscriptFetchResult
  } catch {
    return null
  }
}

export async function fetchSubagents(sessionId: string): Promise<SubagentInfo[]> {
  const res = await fetch(`${API_BASE}/conversations/${sessionId}/subagents`)
  if (!res.ok) return []
  return res.json()
}

export async function fetchSubagentTranscript(sessionId: string, agentId: string): Promise<TranscriptEntry[]> {
  const res = await fetch(`${API_BASE}/conversations/${sessionId}/subagents/${agentId}/transcript?limit=500`)
  if (!res.ok) return []
  return res.json()
}

interface ReviveSessionOptions {
  headless?: boolean
  jobId?: string
  model?: string
  effort?: string
}

export function reviveSession(sessionId: string, options: ReviveSessionOptions = {}): boolean {
  const { headless, jobId, model, effort } = options
  return wsSend('revive_conversation', {
    sessionId,
    ...(headless !== undefined && { headless }),
    ...(jobId && { jobId }),
    ...(model && { model }),
    ...(effort && { effort }),
  })
}

/**
 * Detect a bare control command typed on its own line and route it to the
 * `session_control` channel instead of `send_input`. The wrapper interprets
 * these verbs backend-specifically (headless vs PTY) rather than letting the
 * text reach the model. Returns the verb + args when matched, null otherwise.
 */
function detectControlCommand(input: string): {
  action: 'clear' | 'quit' | 'interrupt' | 'set_model' | 'set_effort' | 'set_permission_mode'
  model?: string
  effort?: string
  permissionMode?: string
} | null {
  const trimmed = input.trim()
  if (!trimmed || trimmed.includes('\n')) return null
  if (trimmed === '/clear') return { action: 'clear' }
  if (trimmed === '/quit' || trimmed === '/exit' || trimmed === ':q' || trimmed === ':q!') return { action: 'quit' }
  const modelMatch = trimmed.match(/^\/model\s+(\S+)$/)
  if (modelMatch) return { action: 'set_model', model: modelMatch[1] }
  const effortMatch = trimmed.match(/^\/effort\s+(\S+)$/)
  if (effortMatch) return { action: 'set_effort', effort: effortMatch[1] }
  const modeMatch = trimmed.match(/^\/mode\s+(\S+)$/)
  if (modeMatch) return { action: 'set_permission_mode', permissionMode: modeMatch[1] }
  if (trimmed === '/plan') return { action: 'set_permission_mode', permissionMode: 'plan' }
  return null
}

function sendSessionControl(
  sessionId: string,
  action: 'clear' | 'quit' | 'interrupt' | 'set_model' | 'set_effort' | 'set_permission_mode',
  opts: { model?: string; effort?: string; permissionMode?: string } = {},
): boolean {
  return wsSend('conversation_control', {
    targetSession: sessionId,
    action,
    ...(opts.model && { model: opts.model }),
    ...(opts.effort && { effort: opts.effort }),
    ...(opts.permissionMode && { permissionMode: opts.permissionMode }),
  })
}

export function sendInput(sessionId: string, input: string): boolean {
  // Bare control commands (/clear, /quit, :q, /model X, /effort X) bypass the
  // model and go straight to the wrapper's control channel. Everything else
  // flows through send_input as before.
  const control = detectControlCommand(input)
  if (control) {
    return sendSessionControl(sessionId, control.action, {
      model: control.model,
      effort: control.effort,
      permissionMode: control.permissionMode,
    })
  }
  const crDelay = (useConversationsStore.getState().globalSettings.carriageReturnDelay as number) || 0
  const ok = wsSend('send_input', { sessionId, input, ...(crDelay > 0 && { crDelay }) })
  // User messages for headless sessions are emitted by the wrapper's
  // sendUserMessage() directly to the broker, which persists + broadcasts.
  // No optimistic entry needed -- the broker round-trip is fast enough,
  // and a single source of truth avoids duplication + survives refresh.
  return ok
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

export function updateProjectSettings(projectUri: string, settings: ProjectSettings): boolean {
  return wsSend('update_project_settings', { project: projectUri, settings })
}

export async function generateProjectKeyterms(
  projectUri: string,
): Promise<{ keyterms: string[]; settings: ProjectSettingsMap } | null> {
  const res = await fetch(`${API_BASE}/api/settings/projects/generate-keyterms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: projectUri }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export function deleteProjectSettings(projectUri: string): boolean {
  return wsSend('delete_project_settings', { project: projectUri })
}

// ─── rclaude config (permission rules) API ──────────────────────────
export interface RclaudePermissionConfig {
  permissions?: {
    Write?: { allow?: string[] }
    Edit?: { allow?: string[] }
    Read?: { allow?: string[] }
  }
  allowAll?: boolean
  allowPlanMode?: boolean
}

interface ConfigDataResponse {
  config: RclaudePermissionConfig | null
  path: string
  project: string
}

interface ConfigOkResponse {
  ok: boolean
  error?: string
}

const configPending = new Map<string, (data: unknown) => void>()

export function resolveConfigResponse(data: Record<string, unknown>): void {
  const requestId = data.requestId as string
  const cb = configPending.get(requestId)
  if (cb) {
    configPending.delete(requestId)
    cb(data)
  }
}

export function requestRclaudeConfig(project: string): Promise<ConfigDataResponse> {
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      configPending.delete(requestId)
      reject(new Error('Config request timed out'))
    }, 10000)

    configPending.set(requestId, data => {
      clearTimeout(timeout)
      resolve(data as ConfigDataResponse)
    })

    wsSend('rclaude_config_get', { project, requestId })
  })
}

export function saveRclaudeConfig(project: string, config: RclaudePermissionConfig): Promise<ConfigOkResponse> {
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      configPending.delete(requestId)
      reject(new Error('Config save timed out'))
    }, 10000)

    configPending.set(requestId, data => {
      clearTimeout(timeout)
      resolve(data as ConfigOkResponse)
    })

    wsSend('rclaude_config_set', { project, config, requestId })
  })
}

// Project order API
export async function fetchProjectOrder(): Promise<ProjectOrder> {
  const res = await fetch(`${API_BASE}/api/project-order`)
  if (!res.ok) return { tree: [] }
  const data = await res.json()
  if (!data || !Array.isArray(data.tree)) return { tree: [] }
  return { tree: data.tree }
}

export function saveProjectOrder(order: ProjectOrder): void {
  const flat: ProjectOrder = { ...order, tree: flattenProjectOrderTree(order.tree) }
  wsSend('update_project_order', { order: flat })
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
