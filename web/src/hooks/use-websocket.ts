/**
 * WebSocket hook for real-time updates from concentrator
 */
import { useCallback, useEffect, useRef } from 'react'
import type { HookEvent, Session, TaskInfo, TranscriptEntry, WrapperCapability } from '@/lib/types'
import { applyHashRoute, useSessionsStore } from './use-sessions'

interface SessionSummary {
  id: string
  cwd: string
  model?: string
  capabilities?: WrapperCapability[]
  wrapperIds?: string[]
  startedAt: number
  lastActivity: number
  status: Session['status']
  compacting?: boolean
  compactedAt?: number
  eventCount: number
  activeSubagentCount?: number
  totalSubagentCount?: number
  subagents?: Array<{
    agentId: string
    agentType: string
    description?: string
    status: 'running' | 'stopped'
    startedAt: number
    stoppedAt?: number
    eventCount: number
  }>
  taskCount?: number
  pendingTaskCount?: number
  activeTasks?: Array<{ id: string; subject: string }>
  pendingTasks?: Array<{ id: string; subject: string }>
  archivedTaskCount?: number
  runningBgTaskCount?: number
  bgTasks?: Array<{
    taskId: string
    command: string
    description: string
    startedAt: number
    completedAt?: number
    status: 'running' | 'completed' | 'killed'
  }>
  teammates?: Array<{
    name: string
    status: 'idle' | 'working' | 'stopped'
    currentTaskSubject?: string
    completedTaskCount: number
  }>
  team?: { teamName: string; role: 'lead' | 'teammate' }
  tokenUsage?: { input: number; cacheCreation: number; cacheRead: number; output: number }
  stats?: Session['stats']
  gitBranch?: string
}

interface DashboardMessage {
  type: string
  sessionId?: string
  session?: SessionSummary
  sessions?: SessionSummary[]
  event?: HookEvent
  connected?: boolean
  data?: string
  error?: string
  // Transcript streaming
  entries?: TranscriptEntry[]
  isInitial?: boolean
  // Task updates
  tasks?: TaskInfo[]
  // Settings updates
  settings?: Record<string, unknown>
}

const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
const RECONNECT_DELAY_MS = 2000

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { setSessions, setConnected, setAgentConnected, setError, setWs } = useSessionsStore()

  // Convert SessionSummary to Session (for store compatibility)
  const toSession = useCallback(
    (summary: SessionSummary): Session => ({
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
    }),
    [],
  )

  const connect = useCallback(() => {
    // Don't reconnect if already connected
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    try {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        setError(null)
        setWs(ws)
        // Subscribe to dashboard updates
        ws.send(JSON.stringify({ type: 'subscribe' }))
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

        // Schedule reconnection
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
        try {
          const msg = JSON.parse(event.data) as DashboardMessage

          // Route terminal messages to terminal handler (keyed by wrapperId)
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

          switch (msg.type) {
            case 'sessions_list': {
              // Initial load - full sessions list
              if (msg.sessions) {
                setSessions(msg.sessions.map(toSession))
                // Apply hash route after sessions are loaded (deep link support)
                applyHashRoute()
              }
              break
            }
            case 'session_created': {
              // New session added
              if (msg.session) {
                const newSession = toSession(msg.session)
                useSessionsStore.setState(state => ({
                  sessions: [...state.sessions, newSession],
                }))
              }
              break
            }
            case 'session_ended':
            case 'session_update': {
              // Session updated
              if (msg.session && msg.sessionId) {
                useSessionsStore.setState(state => ({
                  sessions: state.sessions.map(s =>
                    s.id === msg.sessionId ? { ...s, ...toSession(msg.session!) } : s,
                  ),
                }))
              }
              break
            }
            case 'event': {
              // New event for a session
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
                  return {
                    transcripts: {
                      ...state.transcripts,
                      [msg.sessionId!]: msg.isInitial ? msg.entries! : [...existing, ...msg.entries!],
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
                setAgentConnected(msg.connected)
              }
              break
            }
            case 'settings_updated': {
              if (msg.settings) {
                useSessionsStore.setState({ globalSettings: msg.settings as Record<string, unknown> })
              }
              break
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    } catch {
      // Connection failed, will retry
      setConnected(false)
    }
  }, [setConnected, setAgentConnected, setSessions, setWs, toSession])

  // Connect on mount
  useEffect(() => {
    connect()

    return () => {
      // Cleanup on unmount
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
