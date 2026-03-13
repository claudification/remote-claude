/**
 * WebSocket hook for real-time updates from concentrator
 *
 * Uses rAF buffering + unstable_batchedUpdates to coalesce multiple WS messages
 * into a single React render per frame. Latency-sensitive handlers (terminal, file,
 * toast) bypass the buffer and dispatch immediately.
 */
import { useCallback, useEffect, useRef } from 'react'
import { unstable_batchedUpdates as batchUpdates } from 'react-dom'

// Graceful fallback if unstable_batchedUpdates is ever removed
const batch: (fn: () => void) => void = batchUpdates ?? (fn => fn())
import { recordIn, recordOut } from './ws-stats'
import type { SessionSummary } from '@shared/protocol'
import type { HookEvent, Session, TaskInfo, TranscriptEntry } from '@/lib/types'
import { type ProjectSettingsMap, applyHashRoute, handleBgTaskOutputMessage, useSessionsStore } from './use-sessions'

// Dashboard message from concentrator WS (loose type field for extensibility)
interface DashboardMessage {
  type: string
  sessionId?: string
  previousSessionId?: string
  session?: SessionSummary
  sessions?: SessionSummary[]
  event?: HookEvent
  connected?: boolean
  data?: string
  error?: string
  entries?: TranscriptEntry[]
  isInitial?: boolean
  tasks?: TaskInfo[]
  taskId?: string
  done?: boolean
  settings?: Record<string, unknown>
  title?: string
  message?: string
}

const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
const RECONNECT_DELAY_MS = 2000

// --- rAF message buffer (module-level, outside React) ---
let msgBuffer: DashboardMessage[] = []
let rafScheduled = false

function toSession(summary: SessionSummary): Session {
  return {
    id: summary.id,
    cwd: summary.cwd,
    model: summary.model,
    capabilities: summary.capabilities,
    wrapperIds: summary.wrapperIds,
    startedAt: summary.startedAt,
    lastActivity: summary.lastActivity,
    status: summary.status,
    compacting: summary.compacting,
    compactedAt: summary.compactedAt,
    eventCount: summary.eventCount,
    activeSubagentCount: summary.activeSubagentCount ?? 0,
    totalSubagentCount: summary.totalSubagentCount ?? 0,
    subagents: summary.subagents ?? [],
    taskCount: summary.taskCount ?? 0,
    pendingTaskCount: summary.pendingTaskCount ?? 0,
    activeTasks: summary.activeTasks ?? [],
    pendingTasks: summary.pendingTasks ?? [],
    archivedTaskCount: summary.archivedTaskCount ?? 0,
    runningBgTaskCount: summary.runningBgTaskCount ?? 0,
    bgTasks: summary.bgTasks ?? [],
    teammates: summary.teammates ?? [],
    team: summary.team,
    tokenUsage: summary.tokenUsage,
    stats: summary.stats,
    gitBranch: summary.gitBranch,
  }
}

/**
 * Flush buffered messages in a single batched update.
 * All Zustand setState calls inside unstable_batchedUpdates
 * are coalesced into one React render.
 */
function flushMessages() {
  rafScheduled = false
  if (msgBuffer.length === 0) return

  const pending = msgBuffer
  msgBuffer = []

  batch(() => {
    for (const msg of pending) {
      processMessage(msg)
    }
  })
}

function processMessage(msg: DashboardMessage) {
  switch (msg.type) {
    case 'sessions_list': {
      if (msg.sessions) {
        useSessionsStore.getState().setSessions(msg.sessions.map(toSession))
        applyHashRoute()
      }
      break
    }
    case 'session_created': {
      if (msg.session) {
        const newSession = toSession(msg.session)
        useSessionsStore.setState(state => {
          if (state.sessions.some(s => s.id === newSession.id)) {
            return { sessions: state.sessions.map(s => (s.id === newSession.id ? { ...s, ...newSession } : s)) }
          }
          return { sessions: [...state.sessions, newSession] }
        })
      }
      break
    }
    case 'session_ended':
    case 'session_update': {
      if (msg.session && msg.sessionId) {
        const matchId = msg.previousSessionId || msg.sessionId
        useSessionsStore.setState(state => {
          const updated = toSession(msg.session!)
          const newState: Partial<typeof state> = {
            sessions: state.sessions.map(s => (s.id === matchId ? { ...s, ...updated } : s)),
          }
          if (msg.previousSessionId && state.selectedSessionId === msg.previousSessionId) {
            newState.selectedSessionId = msg.sessionId!
            const oldEvents = state.events[msg.previousSessionId]
            const oldTranscripts = state.transcripts[msg.previousSessionId]
            if (oldEvents || oldTranscripts) {
              const events = { ...state.events }
              const transcripts = { ...state.transcripts }
              delete events[msg.previousSessionId]
              delete transcripts[msg.previousSessionId]
              events[msg.sessionId!] = []
              transcripts[msg.sessionId!] = []
              newState.events = events
              newState.transcripts = transcripts
            }
          }
          return newState
        })
      }
      break
    }
    case 'event': {
      if (msg.event && msg.sessionId) {
        useSessionsStore.setState(state => {
          const currentEvents = state.events[msg.sessionId!] || []
          return {
            events: {
              ...state.events,
              [msg.sessionId!]: [...currentEvents, msg.event!],
            },
          }
        })
      }
      break
    }
    case 'transcript_entries': {
      if (msg.sessionId && msg.entries?.length) {
        useSessionsStore.setState(state => {
          const existing = state.transcripts[msg.sessionId!] || []
          // Strip optimistic entries (injected by sendInput) when real data arrives
          const filtered = existing.filter(e => !e.data?._optimistic)
          return {
            transcripts: {
              ...state.transcripts,
              [msg.sessionId!]: msg.isInitial ? msg.entries! : [...filtered, ...msg.entries!],
            },
          }
        })
      }
      break
    }
    case 'subagent_transcript': {
      if (msg.sessionId && msg.entries?.length) {
        const agentId = (msg as any).agentId
        if (agentId) {
          const key = `${msg.sessionId}:${agentId}`
          useSessionsStore.setState(state => {
            const existing = state.subagentTranscripts[key] || []
            return {
              subagentTranscripts: {
                ...state.subagentTranscripts,
                [key]: (msg as any).isInitial ? msg.entries! : [...existing, ...msg.entries!],
              },
            }
          })
        }
      }
      break
    }
    case 'tasks_update': {
      if (msg.sessionId && msg.tasks) {
        useSessionsStore.setState(state => ({
          tasks: { ...state.tasks, [msg.sessionId!]: msg.tasks! },
        }))
      }
      break
    }
    case 'agent_status': {
      if (msg.connected !== undefined) {
        useSessionsStore.getState().setAgentConnected(msg.connected)
      }
      break
    }
    case 'settings_updated': {
      if (msg.settings) {
        useSessionsStore.setState({ globalSettings: msg.settings as Record<string, unknown> })
      }
      break
    }
    case 'project_settings_updated': {
      if (msg.settings) {
        useSessionsStore.getState().setProjectSettings(msg.settings as ProjectSettingsMap)
      }
      break
    }
  }
}

function scheduleFlush() {
  if (!rafScheduled) {
    rafScheduled = true
    requestAnimationFrame(flushMessages)
  }
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { setConnected, setError, setWs } = useSessionsStore()

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    try {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        setError(null)
        setWs(ws)
        const sub = JSON.stringify({ type: 'subscribe' })
        recordOut(sub.length)
        ws.send(sub)
      }

      ws.onclose = e => {
        setConnected(false)
        setWs(null)
        wsRef.current = null

        if (e.code === 1008 || e.code === 4401) {
          setError(`WebSocket rejected: ${e.reason || 'Unauthorized'}`)
        } else if (e.code !== 1000) {
          setError(`WebSocket closed (${e.code}${e.reason ? `: ${e.reason}` : ''})`)
        }

        if (!reconnectTimeoutRef.current) {
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null
            connect()
          }, RECONNECT_DELAY_MS)
        }
      }

      ws.onerror = () => {
        setError(`WebSocket connection failed: ${WS_URL}`)
      }

      ws.onmessage = event => {
        const raw = event.data as string
        recordIn(raw.length)
        try {
          const msg = JSON.parse(raw) as DashboardMessage

          // --- Bypass buffer: latency-sensitive handlers ---

          // File editor messages -> direct handler callback
          if (
            msg.type === 'file_list_response' ||
            msg.type === 'file_content_response' ||
            msg.type === 'file_save_response' ||
            msg.type === 'file_history_response' ||
            msg.type === 'file_restore_response' ||
            msg.type === 'quick_note_response' ||
            msg.type === 'file_changed'
          ) {
            const handler = useSessionsStore.getState().fileHandler
            handler?.(msg)
            return
          }

          // Terminal data -> direct handler callback (low latency critical)
          if (msg.type === 'terminal_data' || msg.type === 'terminal_error') {
            const handler = useSessionsStore.getState().terminalHandler
            handler?.({
              type: msg.type as 'terminal_data' | 'terminal_error',
              wrapperId: (msg as any).wrapperId || '',
              data: msg.data,
              error: msg.error,
            })
            return
          }

          // Background task output -> direct handler
          if (msg.type === 'bg_task_output') {
            if (msg.taskId) {
              handleBgTaskOutputMessage({
                taskId: msg.taskId,
                data: msg.data || '',
                done: msg.done || false,
              })
            }
            return
          }

          // Toast notifications -> direct DOM event
          if (msg.type === 'toast') {
            const title = msg.title as string || 'Notification'
            const body = msg.message as string || ''
            window.dispatchEvent(new CustomEvent('rclaude-toast', { detail: { title, body, sessionId: msg.sessionId } }))
            return
          }

          // --- Buffer: state-updating messages ---
          msgBuffer.push(msg)
          scheduleFlush()
        } catch {
          // Ignore parse errors
        }
      }
    } catch {
      setConnected(false)
    }
  }, [setConnected, setError, setWs])

  useEffect(() => {
    connect()

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [connect])

  return {
    isConnected: wsRef.current?.readyState === WebSocket.OPEN,
  }
}
