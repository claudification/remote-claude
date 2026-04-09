/**
 * WebSocket hook for real-time updates from concentrator
 *
 * Uses rAF buffering + unstable_batchedUpdates to coalesce multiple WS messages
 * into a single React render per frame. Latency-sensitive handlers (terminal, file,
 * toast) bypass the buffer and dispatch immediately.
 */
import { useCallback, useEffect, useRef } from 'react'
import { unstable_batchedUpdates as batchUpdates } from 'react-dom'
import { haptic } from '@/lib/utils'

// Graceful fallback if unstable_batchedUpdates is ever removed
const batch: (fn: () => void) => void = batchUpdates ?? (fn => fn())

import type { SessionSummary } from '@shared/protocol'
import { buildWsUrl } from '@/lib/share-mode'
import type { HookEvent, Session, SessionOrderV2, TaskInfo, TranscriptEntry } from '@/lib/types'
import {
  applyHashRoute,
  fetchTranscript,
  handleBgTaskOutputMessage,
  type ProjectSettingsMap,
  useSessionsStore,
} from './use-sessions'
import { recordIn, recordOut } from './ws-stats'

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
  order?: { version: number; tree: unknown[] }
  title?: string
  message?: string
  ok?: boolean
  global?: Record<string, boolean>
  // biome-ignore lint/suspicious/noExplicitAny: DashboardMessage is a loose WS type
  [key: string]: any
}

const WS_URL = buildWsUrl()
const RECONNECT_DELAY_MS = 2000
const SESSION_CHANNELS = ['session:events', 'session:transcript', 'session:tasks', 'session:bg_output'] as const

// --- rAF message buffer (module-level, outside React) ---
let msgBuffer: DashboardMessage[] = []
let rafScheduled = false

// Module-level subscription tracking - must be clearable from onopen handler
let _subscribedSessions = new Set<string>()
function clearSubscribedSessions() {
  _subscribedSessions = new Set<string>()
}

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
    archivedTasks: summary.archivedTasks ?? [],
    runningBgTaskCount: summary.runningBgTaskCount ?? 0,
    bgTasks: summary.bgTasks ?? [],
    teammates: summary.teammates ?? [],
    team: summary.team,
    effortLevel: summary.effortLevel,
    lastError: summary.lastError,
    rateLimit: summary.rateLimit,
    pendingAttention: summary.pendingAttention,
    hasNotification: summary.hasNotification,
    summary: summary.summary,
    title: summary.title,
    agentName: summary.agentName,
    prLinks: summary.prLinks,
    linkedSessions: summary.linkedSessions,
    tokenUsage: summary.tokenUsage,
    stats: summary.stats,
    gitBranch: summary.gitBranch,
    version: summary.version,
    buildTime: summary.buildTime,
    claudeVersion: summary.claudeVersion,
    claudeAuth: summary.claudeAuth,
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

  // Track sync state (epoch+seq) from incoming messages
  const { syncSeq: prevSeq, syncEpoch: prevEpoch } = useSessionsStore.getState()
  let maxSeq = prevSeq
  let epoch = prevEpoch
  for (const msg of pending) {
    const m = msg as DashboardMessage & { _epoch?: string; _seq?: number }
    if (m._epoch && m._seq) {
      epoch = m._epoch
      if (m._seq > maxSeq) maxSeq = m._seq
    }
  }
  if (maxSeq > prevSeq || epoch !== prevEpoch) {
    useSessionsStore.setState({ syncEpoch: epoch, syncSeq: maxSeq })
  }

  batch(() => {
    for (const msg of pending) {
      processMessage(msg)
    }
  })
}

function refetchStaleTranscripts(staleTranscripts?: Record<string, number>): void {
  if (!staleTranscripts) return
  const { transcripts, setTranscript } = useSessionsStore.getState()
  const sids = Object.keys(staleTranscripts)
  const actuallyStale = sids.filter(s => {
    const local = transcripts[s]?.length ?? 0
    const server = staleTranscripts[s]
    return server > local
  })
  if (actuallyStale.length === 0) {
    console.log('[sync] transcript counts: all in sync')
    return
  }
  console.log(
    `[sync] STALE transcripts: ${actuallyStale.map(s => `${s.slice(0, 8)} server=${staleTranscripts[s]} local=${transcripts[s]?.length ?? 0}`).join(', ')}`,
  )
  for (const sid of actuallyStale) {
    fetchTranscript(sid).then(transcript => {
      if (transcript) {
        console.log(`[sync] REFETCH transcript ${sid.slice(0, 8)}: ${transcript.length} entries`)
        setTranscript(sid, transcript)
      }
    })
  }
}

function processMessage(msg: DashboardMessage) {
  // All sync responses may carry staleTranscripts - handle once before type-specific logic
  const syncMsg = msg as DashboardMessage & { staleTranscripts?: Record<string, number> }
  if (syncMsg.staleTranscripts) refetchStaleTranscripts(syncMsg.staleTranscripts)

  switch (msg.type) {
    // Sync protocol responses
    case 'sync_ok': {
      const ok = msg as DashboardMessage & { epoch?: string; seq?: number }
      console.log(`[sync] ok (epoch=${ok.epoch?.slice(0, 8)} seq=${ok.seq})`)
      break
    }
    case 'sync_catchup': {
      const cu = msg as DashboardMessage & { count?: number; epoch?: string; seq?: number }
      console.log(`[sync] catchup: ${cu.count} missed messages (epoch=${cu.epoch?.slice(0, 8)} seq=${cu.seq})`)
      break
    }
    case 'sync_stale': {
      const stale = msg as DashboardMessage & { reason?: string; missed?: number; epoch?: string; seq?: number }
      console.log(`[sync] stale: ${stale.reason || 'unknown'} (missed=${stale.missed || '?'})`)
      // Full resync needed - bump connectSeq (triggers LIFO eviction + re-fetch in onopen)
      useSessionsStore.setState(s => ({
        connectSeq: s.connectSeq + 1,
        syncEpoch: stale.epoch || '',
        syncSeq: stale.seq || 0,
      }))
      break
    }
    case 'sessions_list': {
      if (msg.sessions) {
        useSessionsStore.getState().setSessions(msg.sessions.map(toSession))
        applyHashRoute()
      }
      // Check for version mismatch between server and this frontend bundle
      // Compare just the 7-char git hash, ignoring -dirty suffix
      // Version mismatch detection removed -- SW lifecycle handles update detection.
      // When sw.js changes, browser installs new SW and sends 'sw-updated' postMessage.
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
        const sessionId = msg.sessionId
        const session = msg.session
        const prevId = msg.previousSessionId
        const matchId = prevId || sessionId
        useSessionsStore.setState(state => {
          const updated = toSession(session)
          const newState: Partial<typeof state> = {
            sessions: state.sessions.map(s => (s.id === matchId ? { ...s, ...updated } : s)),
          }
          if (prevId && state.selectedSessionId === prevId) {
            newState.selectedSessionId = sessionId
            const oldEvents = state.events[prevId]
            const oldTranscripts = state.transcripts[prevId]
            if (oldEvents || oldTranscripts) {
              const events = { ...state.events }
              const transcripts = { ...state.transcripts }
              delete events[prevId]
              delete transcripts[prevId]
              // Preserve any data already received for the new session ID
              // (e.g. compacting marker broadcast during rekey)
              if (!events[sessionId]) events[sessionId] = []
              if (!transcripts[sessionId]) transcripts[sessionId] = []
              newState.events = events
              newState.transcripts = transcripts
            }
          }
          return newState
        })
        // Rekey: transcript moved from old-id to new-id locally, but we may have
        // missed channel entries under new-id while backgrounded. Re-fetch.
        if (prevId) {
          console.log(
            `[sync] session_update: REKEY ${prevId.slice(0, 8)} -> ${sessionId.slice(0, 8)} status=${session.status}`,
          )
          // Delay: concentrator processes rekey and re-receives transcript from rclaude.
          // 500ms gives the transcript watcher time to stream initial entries to the new ID.
          setTimeout(() => {
            fetchTranscript(sessionId).then(transcript => {
              console.log(`[sync] rekey refetch ${sessionId.slice(0, 8)}: ${transcript?.length ?? 'null'} entries`)
              if (transcript) useSessionsStore.getState().setTranscript(sessionId, transcript)
            })
          }, 500)
        } else if (session.status === 'starting') {
          const state = useSessionsStore.getState()
          const cached = state.transcripts[sessionId]?.length ?? 0
          const isSelected = state.selectedSessionId === sessionId
          console.log(`[sync] session_update: RESUME ${sessionId.slice(0, 8)} selected=${isSelected} cached=${cached}`)
          if (isSelected && cached === 0) {
            // Delay: rclaude just reconnected, transcript watcher needs time to read
            // the JSONL file and stream entries to concentrator before our fetch returns data.
            setTimeout(() => {
              fetchTranscript(sessionId).then(transcript => {
                console.log(`[sync] resume refetch ${sessionId.slice(0, 8)}: ${transcript?.length ?? 'null'} entries`)
                if (transcript) useSessionsStore.getState().setTranscript(sessionId, transcript)
              })
            }, 1000)
          }
        }
      }
      break
    }
    case 'channel_ack': {
      // Channel subscription acknowledgment - log for debugging
      const ack = msg as DashboardMessage & { channel?: string; previousSessionId?: string }
      if (ack.previousSessionId) {
        console.log(
          `[ws] Channel ${ack.channel} rolled over: ${ack.previousSessionId.slice(0, 8)} -> ${ack.sessionId?.slice(0, 8)}`,
        )
      }
      break
    }
    case 'event': {
      if (msg.event && msg.sessionId) {
        const sid = msg.sessionId
        const evt = msg.event
        useSessionsStore.setState(state => {
          const currentEvents = state.events[sid] || []
          return {
            events: {
              ...state.events,
              [sid]: [...currentEvents, evt],
            },
          }
        })
      }
      break
    }
    case 'transcript_entries': {
      if (msg.sessionId && msg.entries?.length) {
        const sid = msg.sessionId
        const newEntries = msg.entries as TranscriptEntry[]
        const initial = msg.isInitial
        useSessionsStore.setState(state => {
          const existing = state.transcripts[sid] || []
          const result = initial ? newEntries : [...existing, ...newEntries]
          if (initial || newEntries.length > 2) {
            console.log(
              `[ws] transcript ${sid.slice(0, 8)}: +${newEntries.length} ${initial ? 'INITIAL' : 'incremental'} (total=${result.length})`,
            )
          }
          return {
            transcripts: {
              ...state.transcripts,
              [sid]: result,
            },
          }
        })
      }
      break
    }
    case 'session_info': {
      // Session metadata from headless init - store for autocomplete
      const sid = msg.sessionId as string
      if (sid) {
        useSessionsStore.setState(state => ({
          sessionInfo: {
            ...state.sessionInfo,
            [sid]: {
              tools: (msg.tools as string[]) || [],
              slashCommands: (msg.slashCommands as string[]) || [],
              skills: (msg.skills as string[]) || [],
              agents: (msg.agents as string[]) || [],
              mcpServers: (msg.mcpServers as Array<{ name: string; status?: string }>) || [],
              model: (msg.model as string) || '',
              permissionMode: (msg.permissionMode as string) || '',
              claudeCodeVersion: (msg.claudeCodeVersion as string) || '',
            },
          },
        }))
        console.log(
          `[ws] session_info ${sid.slice(0, 8)}: ${(msg.tools as unknown[])?.length} tools, ${(msg.skills as unknown[])?.length} skills`,
        )
      }
      break
    }
    case 'stream_delta': {
      // Headless token streaming - accumulate text deltas
      const sid = msg.sessionId as string
      const event = msg.event as Record<string, unknown> | undefined
      if (sid && event) {
        const eventType = event.type as string
        if (eventType === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown> | undefined
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            useSessionsStore.setState(state => {
              const updated = (state.streamingText[sid] || '') + delta.text
              // Bump newDataSeq every ~500 chars to trigger auto-scroll without thrashing
              const prevLen = (state.streamingText[sid] || '').length
              const bumpScroll = Math.floor(updated.length / 500) > Math.floor(prevLen / 500)
              return {
                streamingText: { ...state.streamingText, [sid]: updated },
                ...(bumpScroll ? { newDataSeq: state.newDataSeq + 1 } : {}),
              }
            })
          }
        } else if (eventType === 'message_stop') {
          // Clear streaming buffer when the full assistant message arrives via transcript_entries
          useSessionsStore.setState(state => {
            const { [sid]: _, ...rest } = state.streamingText
            return { streamingText: rest }
          })
        }
      }
      break
    }
    case 'subagent_transcript': {
      if (msg.sessionId && msg.entries?.length) {
        const subMsg = msg as DashboardMessage & { agentId?: string }
        const agentId = subMsg.agentId
        if (agentId) {
          const sid = msg.sessionId
          const newEntries = msg.entries
          const initial = msg.isInitial
          const key = `${sid}:${agentId}`
          useSessionsStore.setState(state => {
            const existing = state.subagentTranscripts[key] || []
            return {
              subagentTranscripts: {
                ...state.subagentTranscripts,
                [key]: initial ? newEntries : [...existing, ...newEntries],
              },
            }
          })
        }
      }
      break
    }
    case 'tasks_update': {
      if (msg.sessionId && msg.tasks) {
        const sid = msg.sessionId
        const taskList = msg.tasks
        useSessionsStore.setState(state => ({
          tasks: { ...state.tasks, [sid]: taskList },
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
    case 'session_order_updated': {
      if (msg.order) {
        useSessionsStore.getState().setSessionOrder(msg.order as SessionOrderV2)
      }
      break
    }
    case 'shares_updated': {
      if (msg.shares) {
        useSessionsStore.getState().setShares(msg.shares)
      }
      break
    }
    case 'channel_link_request': {
      const req = msg as DashboardMessage & {
        fromSession?: string
        fromProject?: string
        toSession?: string
        toProject?: string
      }
      const fromSession = req.fromSession
      const toSession = req.toSession
      if (fromSession && toSession) {
        useSessionsStore.setState(state => {
          // Deduplicate
          if (state.pendingLinkRequests.some(r => r.fromSession === fromSession && r.toSession === toSession)) {
            return state
          }
          return {
            pendingLinkRequests: [
              ...state.pendingLinkRequests,
              {
                fromSession,
                fromProject: req.fromProject || fromSession.slice(0, 8),
                toSession,
                toProject: req.toProject || toSession.slice(0, 8),
              },
            ],
          }
        })
      }
      break
    }
    case 'permission_request': {
      const req = msg as DashboardMessage & {
        requestId?: string
        toolName?: string
        description?: string
        inputPreview?: string
      }
      const permSid = req.sessionId
      const permRid = req.requestId
      if (permSid && permRid) {
        useSessionsStore.setState(state => {
          if (state.pendingPermissions.some(p => p.requestId === permRid)) return state
          return {
            pendingPermissions: [
              ...state.pendingPermissions,
              {
                sessionId: permSid,
                requestId: permRid,
                toolName: req.toolName || 'Unknown',
                description: req.description || '',
                inputPreview: req.inputPreview || '',
                timestamp: Date.now(),
              },
            ],
          }
        })
        // Haptic + visual alert for permission requests (haptic may be silent on iOS outside gestures)
        haptic('double')
      }
      break
    }
    case 'permission_auto_approved': {
      const auto = msg as DashboardMessage & {
        requestId?: string
        toolName?: string
        description?: string
      }
      if (auto.sessionId && auto.toolName) {
        // Emit a custom event that the session-detail can pick up for a brief toast
        window.dispatchEvent(
          new CustomEvent('permission-auto-approved', {
            detail: { sessionId: auto.sessionId, toolName: auto.toolName, description: auto.description },
          }),
        )
      }
      break
    }
    case 'ask_question': {
      const askMsg = msg as DashboardMessage & {
        toolUseId?: string
        questions?: Array<{
          question: string
          header: string
          options: Array<{ label: string; description: string; preview?: string }>
          multiSelect?: boolean
        }>
      }
      const askSid = askMsg.sessionId
      const askTuid = askMsg.toolUseId
      if (askSid && askTuid && askMsg.questions) {
        useSessionsStore.setState(state => {
          if (state.pendingAskQuestions.some(q => q.toolUseId === askTuid)) return state
          return {
            pendingAskQuestions: [
              ...state.pendingAskQuestions,
              {
                sessionId: askSid,
                toolUseId: askTuid,
                questions: askMsg.questions || [],
                timestamp: Date.now(),
              },
            ],
          }
        })
      }
      break
    }
    case 'dialog_show': {
      const exSid = msg.sessionId as string
      const exId = msg.dialogId as string
      const exLayout = msg.layout as import('@shared/dialog-schema').DialogLayout
      if (exSid && exId && exLayout) {
        useSessionsStore.setState(state => ({
          pendingDialogs: {
            ...state.pendingDialogs,
            [exSid]: { dialogId: exId, layout: exLayout, timestamp: Date.now() },
          },
        }))
      }
      break
    }
    case 'dialog_dismiss': {
      const exSid = msg.sessionId as string
      if (exSid) {
        useSessionsStore.setState(state => {
          const updated = { ...state.pendingDialogs }
          delete updated[exSid]
          return { pendingDialogs: updated }
        })
      }
      break
    }
    case 'clipboard_capture': {
      const clipMsg = msg as DashboardMessage & {
        contentType?: 'text' | 'image'
        text?: string
        base64?: string
        mimeType?: string
        timestamp?: number
      }
      if (clipMsg.sessionId && clipMsg.contentType) {
        useSessionsStore.setState(state => {
          const capture = {
            id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            sessionId: clipMsg.sessionId || '',
            contentType: clipMsg.contentType || ('text' as const),
            text: clipMsg.text,
            base64: clipMsg.base64,
            mimeType: clipMsg.mimeType,
            timestamp: clipMsg.timestamp || Date.now(),
          }
          // Stack max 4, drop oldest
          const next = [capture, ...state.clipboardCaptures].slice(0, 4)
          return { clipboardCaptures: next }
        })
      }
      break
    }
    case 'session_dismissed': {
      if (msg.sessionId) {
        useSessionsStore.setState(state => ({
          sessions: state.sessions.filter(s => s.id !== msg.sessionId),
          selectedSessionId: state.selectedSessionId === msg.sessionId ? null : state.selectedSessionId,
        }))
      }
      break
    }
    // Server-pushed permissions (resolved from grants)
    case 'permissions': {
      const update: Record<string, unknown> = {}
      if (msg.global) update.permissions = msg.global
      if (msg.sessions) update.sessionPermissions = msg.sessions
      if (Object.keys(update).length > 0) useSessionsStore.setState(update)
      break
    }
    // WS action results (fire-and-forget error feedback)
    case 'send_input_result':
    case 'dismiss_session_result':
    case 'update_settings_result':
    case 'update_project_settings_result':
    case 'delete_project_settings_result':
    case 'update_session_order_result':
    case 'revive_session_result': {
      if (msg.ok === false) {
        console.error(`[ws] ${msg.type}: ${msg.error}`)
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

  const setConnected = useSessionsStore(s => s.setConnected)
  const setError = useSessionsStore(s => s.setError)
  const setWs = useSessionsStore(s => s.setWs)

  // Tracked send: serializes + records byte count. Uses wsRef for subscription watchers.
  function send(msg: Record<string, unknown>) {
    const w = wsRef.current
    if (!w || w.readyState !== WebSocket.OPEN) return
    const json = JSON.stringify(msg)
    recordOut(json.length)
    w.send(json)
  }

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    try {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        setError(null)
        setWs(ws)
        send({ type: 'subscribe', protocolVersion: 2 })

        // On reconnect: evict all non-selected sessions from LIFO cache.
        // Their data is potentially stale (missed WS entries during disconnect).
        // They'll be re-fetched fresh when the user navigates to them.
        // Only the current session keeps its cache + gets re-subscribed.
        const { selectedSessionId, selectedSubagentId, transcripts, events } = useSessionsStore.getState()
        const evictedSids = Object.keys(transcripts).filter(sid => sid !== selectedSessionId)
        if (evictedSids.length > 0) {
          const newTranscripts = { ...transcripts }
          const newEvents = { ...events }
          for (const sid of evictedSids) {
            delete newTranscripts[sid]
            delete newEvents[sid]
          }
          console.log(`[sync] reconnect: evicted ${evictedSids.length} stale sessions from LIFO cache`)
          useSessionsStore.setState({ transcripts: newTranscripts, events: newEvents })
        }

        // Reset subscription tracking - only current session
        clearSubscribedSessions()

        // Subscribe current session immediately
        if (selectedSessionId) {
          for (const ch of SESSION_CHANNELS) {
            send({ type: 'channel_subscribe', channel: ch, sessionId: selectedSessionId })
          }
          _subscribedSessions.add(selectedSessionId)
          if (selectedSubagentId) {
            send({
              type: 'channel_subscribe',
              channel: 'session:subagent_transcript',
              sessionId: selectedSessionId,
              agentId: selectedSubagentId,
            })
          }
        }

        // Bump connectSeq to trigger re-fetch of current session
        useSessionsStore.setState(s => ({ connectSeq: s.connectSeq + 1 }))
      }

      ws.onclose = e => {
        setConnected(false)
        setWs(null)
        wsRef.current = null

        if (e.code === 1008 || e.code === 4401) {
          // Auth failure - don't reconnect, show expiry modal
          useSessionsStore.getState().setAuthExpired(true)
          setError(`Session expired or unauthorized`)
          return
        }
        if (e.code !== 1000) {
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
            handler?.(msg as unknown as Record<string, unknown>)
            return
          }

          // Task notes messages -> direct handler callback
          if (
            typeof msg.type === 'string' &&
            ((msg.type.startsWith('task_notes_') && msg.type.endsWith('_response')) ||
              msg.type === 'task_notes_changed')
          ) {
            const handler = useSessionsStore.getState().taskNotesHandler
            handler?.(msg as unknown as Record<string, unknown>)
            return
          }

          // Terminal data -> direct handler callback (low latency critical)
          if (msg.type === 'terminal_data' || msg.type === 'terminal_error') {
            const handler = useSessionsStore.getState().terminalHandler
            handler?.({
              type: msg.type as 'terminal_data' | 'terminal_error',
              wrapperId: (msg as DashboardMessage & { wrapperId?: string }).wrapperId || '',
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
            const title = (msg.title as string) || 'Notification'
            const body = (msg.message as string) || ''
            window.dispatchEvent(
              new CustomEvent('rclaude-toast', { detail: { title, body, sessionId: msg.sessionId } }),
            )
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

    // Watch for session selection changes and manage channel subscriptions
    // Diff-based: keep subscriptions alive for LIFO-cached sessions
    _subscribedSessions = new Set<string>()
    const unsubSessionion = useSessionsStore.subscribe(state => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return

      // Desired subscriptions: selected + all sessions with cached transcripts
      const desired = new Set<string>()
      if (state.selectedSessionId) desired.add(state.selectedSessionId)
      for (const sid of Object.keys(state.transcripts)) {
        if (state.transcripts[sid]?.length) desired.add(sid)
      }

      // Unsubscribe sessions no longer in cache
      for (const sid of _subscribedSessions) {
        if (!desired.has(sid)) {
          for (const ch of SESSION_CHANNELS) {
            send({ type: 'channel_unsubscribe', channel: ch, sessionId: sid })
          }
        }
      }
      // Subscribe new sessions
      for (const sid of desired) {
        if (!_subscribedSessions.has(sid)) {
          for (const ch of SESSION_CHANNELS) {
            send({ type: 'channel_subscribe', channel: ch, sessionId: sid })
          }
        }
      }
      _subscribedSessions = desired
    })

    // Watch for subagent selection and subscribe to its transcript channel
    let lastSubagentKey: string | null = null
    const unsubAgent = useSessionsStore.subscribe(state => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
      const sessionId = state.selectedSessionId
      const agentId = state.selectedSubagentId
      const key = sessionId && agentId ? `${sessionId}:${agentId}` : null

      if (key === lastSubagentKey) return
      const prevKey = lastSubagentKey
      lastSubagentKey = key

      if (prevKey) {
        const [prevSid, prevAid] = prevKey.split(':')
        send({
          type: 'channel_unsubscribe',
          channel: 'session:subagent_transcript',
          sessionId: prevSid,
          agentId: prevAid,
        })
      }
      if (key && sessionId && agentId) {
        send({ type: 'channel_subscribe', channel: 'session:subagent_transcript', sessionId, agentId })
      }
    })

    return () => {
      unsubSessionion()
      unsubAgent()
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
