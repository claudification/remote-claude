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
import { isPerfEnabled, record as perfRecord } from '@/lib/perf-metrics'
import { buildWsUrl } from '@/lib/share-mode'
import type { HookEvent, Session, SessionOrderV2, TaskInfo, TranscriptEntry } from '@/lib/types'
import {
  applyHashRoute,
  buildSessionsById,
  fetchTranscript,
  handleBgTaskOutputMessage,
  type ProjectSettingsMap,
  useSessionsStore,
} from './use-sessions'
import { handleSpawnRequestAck } from './use-spawn'
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
    monitors: summary.monitors ?? [],
    runningMonitorCount: summary.runningMonitorCount ?? 0,
    teammates: summary.teammates ?? [],
    team: summary.team,
    effortLevel: summary.effortLevel,
    lastError: summary.lastError,
    rateLimit: summary.rateLimit,
    planMode: summary.planMode,
    pendingAttention: summary.pendingAttention,
    hasNotification: summary.hasNotification,
    summary: summary.summary,
    title: summary.title,
    agentName: summary.agentName,
    prLinks: summary.prLinks,
    linkedProjects: summary.linkedProjects,
    tokenUsage: summary.tokenUsage,
    cacheTtl: summary.cacheTtl,
    lastTurnEndedAt: summary.lastTurnEndedAt,
    stats: summary.stats,
    costTimeline: summary.costTimeline,
    gitBranch: summary.gitBranch,
    version: summary.version,
    buildTime: summary.buildTime,
    claudeVersion: summary.claudeVersion,
    claudeAuth: summary.claudeAuth,
    spinnerVerbs: summary.spinnerVerbs,
    autocompactPct: summary.autocompactPct,
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
          let sessions: Session[]
          if (state.sessions.some(s => s.id === newSession.id)) {
            sessions = state.sessions.map(s => (s.id === newSession.id ? { ...s, ...newSession } : s))
          } else {
            sessions = [...state.sessions, newSession]
          }
          return { sessions, sessionsById: buildSessionsById(sessions) }
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
          const sessions = state.sessions.map(s => (s.id === matchId ? { ...s, ...updated } : s))
          const newState: Partial<typeof state> = {
            sessions,
            sessionsById: buildSessionsById(sessions),
          }
          // Clear stale streaming text when session goes idle or ends
          if ((updated.status === 'idle' || updated.status === 'ended') && state.streamingText[sessionId]) {
            const { [sessionId]: _, ...rest } = state.streamingText
            newState.streamingText = rest
          }
          if (prevId && state.selectedSessionId === prevId) {
            console.log(
              `[nav] session rekey: ${prevId.slice(0, 8)} -> ${sessionId.slice(0, 8)} (selected session rekeyed)`,
            )
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
          if (isSelected) {
            // Always refetch on resume -- transcript may have been corrupted by a
            // same-ID rekey or the session may have new data from a restart.
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
          // Clear streaming text when an assistant entry arrives (defensive cleanup
          // in case message_stop was lost or arrived after the transcript entry)
          const hasAssistant = newEntries.some(e => e.type === 'assistant')
          const streamingText =
            hasAssistant && state.streamingText[sid]
              ? (() => {
                  const { [sid]: _, ...rest } = state.streamingText
                  return rest
                })()
              : state.streamingText
          return {
            transcripts: {
              ...state.transcripts,
              [sid]: result,
            },
            streamingText,
            newDataSeq: state.newDataSeq + 1,
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
        } else if (eventType === 'message_start' || eventType === 'content_block_start') {
          // New turn or new content block -- reset streaming buffer
          useSessionsStore.setState(state => {
            if (!state.streamingText[sid]) return state
            return { streamingText: { ...state.streamingText, [sid]: '' } }
          })
        } else if (eventType === 'message_stop') {
          // Turn complete -- clear streaming buffer entirely
          useSessionsStore.setState(state => {
            if (!state.streamingText[sid]) return state
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
    case 'usage_update': {
      if (msg.usage) {
        useSessionsStore.getState().setPlanUsage(msg.usage)
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
          if (state.pendingProjectLinks.some(r => r.fromSession === fromSession && r.toSession === toSession)) {
            return state
          }
          return {
            pendingProjectLinks: [
              ...state.pendingProjectLinks,
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
        // Dedup: the wrapper replays dialog_show on reconnect. If we already
        // have this exact dialog open, preserve any in-progress user input.
        const existing = useSessionsStore.getState().pendingDialogs[exSid]
        if (existing?.dialogId === exId) break
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
    case 'plan_approval': {
      const pa = msg as DashboardMessage & {
        requestId?: string
        toolUseId?: string
        plan?: string
        planFilePath?: string
        allowedPrompts?: string[]
      }
      const paSid = pa.sessionId
      if (paSid && pa.requestId && pa.plan) {
        const dialogId = `plan_${pa.requestId}`
        // Dedup: wrapper replays plan_approval on reconnect so the concentrator
        // can rebuild pending state. If we already have this exact dialog open,
        // don't overwrite -- would wipe any feedback the user has typed.
        const existing = useSessionsStore.getState().pendingDialogs[paSid]
        if (existing?.dialogId === dialogId && existing.source === 'plan_approval') break
        // Build a dialog layout from the plan content
        const layout: import('@shared/dialog-schema').DialogLayout = {
          title: 'Plan Approval',
          timeout: 600,
          submitLabel: 'Approve',
          cancelLabel: 'Reject',
          body: [
            { type: 'Markdown', content: pa.plan },
            { type: 'Divider' },
            {
              type: 'TextInput',
              id: 'feedback',
              label: 'Feedback (optional)',
              placeholder: 'Changes or additional instructions...',
              multiline: true,
            },
          ],
        }
        useSessionsStore.setState(state => ({
          pendingDialogs: {
            ...state.pendingDialogs,
            [paSid]: {
              dialogId,
              layout,
              timestamp: Date.now(),
              source: 'plan_approval',
              meta: { requestId: pa.requestId, toolUseId: pa.toolUseId },
            },
          },
        }))
        haptic('double')
      }
      break
    }
    case 'plan_approval_dismissed': {
      const sid = msg.sessionId
      if (sid) {
        useSessionsStore.setState(state => {
          const pending = state.pendingDialogs[sid]
          if (pending?.source === 'plan_approval') {
            const { [sid]: _, ...rest } = state.pendingDialogs
            return { pendingDialogs: rest }
          }
          return state
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
        useSessionsStore.setState(state => {
          const sessions = state.sessions.filter(s => s.id !== msg.sessionId)
          if (state.selectedSessionId === msg.sessionId) {
            console.log(`[nav] session_dismissed: clearing selection (WS dismissed ${msg.sessionId.slice(0, 8)})`)
          }
          return {
            sessions,
            sessionsById: buildSessionsById(sessions),
            selectedSessionId: state.selectedSessionId === msg.sessionId ? null : state.selectedSessionId,
          }
        })
      }
      break
    }
    // Server-pushed permissions (resolved from grants)
    case 'permissions': {
      const update: Record<string, unknown> = {}
      if (msg.global) update.permissions = msg.global
      if (msg.sessions) {
        // Merge into existing sessionPermissions (incremental updates for new sessions)
        update.sessionPermissions = { ...useSessionsStore.getState().sessionPermissions, ...msg.sessions }
      }
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
      // Dispatch for LaunchMonitor to pick up
      window.dispatchEvent(new CustomEvent('revive-session-result', { detail: msg }))
      break
    }

    case 'revive_result': {
      // Agent's revive result -- forwarded by concentrator for pipeline tracking
      window.dispatchEvent(new CustomEvent('revive-agent-result', { detail: msg }))
      break
    }

    // ─── Launch Job Events ──────────────────────────────────────────
    case 'launch_log':
    case 'launch_progress':
    case 'job_complete':
    case 'job_failed': {
      window.dispatchEvent(new CustomEvent('launch-job-event', { detail: msg }))
      break
    }

    // ─── Spawn Request Ack (WS spawn_request → ack by jobId) ────────
    case 'spawn_request_ack': {
      handleSpawnRequestAck(
        msg as unknown as {
          type: 'spawn_request_ack'
          ok: boolean
          jobId?: string
          wrapperId?: string
          tmuxSession?: string
          error?: string
        },
      )
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

  // Tracked send: serializes + records byte count. Uses wsRef for subscription watchers.
  function send(msg: Record<string, unknown>) {
    const w = wsRef.current
    if (!w || w.readyState !== WebSocket.OPEN) return
    const json = JSON.stringify(msg)
    recordOut(json.length)
    w.send(json)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: send is a module-scope function, not a React dep
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    try {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        send({ type: 'subscribe', protocolVersion: 2 })

        // Single batched setState for ALL onopen state changes.
        // Multiple separate setState calls fire Zustand subscribers individually,
        // causing useSyncExternalStore tearing detection to loop (React #310).
        const { selectedSessionId, selectedSubagentId, transcripts, events, connectSeq } = useSessionsStore.getState()

        // Evict stale sessions from LIFO cache (non-selected sessions may have missed WS entries)
        const evictedSids = Object.keys(transcripts).filter(sid => sid !== selectedSessionId)
        let newTranscripts = transcripts
        let newEvents = events
        if (evictedSids.length > 0) {
          newTranscripts = { ...transcripts }
          newEvents = { ...events }
          for (const sid of evictedSids) {
            delete newTranscripts[sid]
            delete newEvents[sid]
          }
          console.log(`[sync] reconnect: evicted ${evictedSids.length} stale sessions from LIFO cache`)
        }

        // ONE setState call instead of 5 separate ones
        useSessionsStore.setState({
          isConnected: true,
          error: null,
          ws,
          transcripts: newTranscripts,
          events: newEvents,
          connectSeq: connectSeq + 1,
        })

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
      }

      ws.onclose = e => {
        wsRef.current = null

        if (e.code === 1008 || e.code === 4401) {
          // Auth failure - don't reconnect, show expiry modal
          useSessionsStore.setState({
            isConnected: false,
            ws: null,
            authExpired: true,
            error: 'Session expired or unauthorized',
          })
          return
        }
        // Single setState for disconnect state
        useSessionsStore.setState({
          isConnected: false,
          ws: null,
          ...(e.code !== 1000 ? { error: `WebSocket closed (${e.code}${e.reason ? `: ${e.reason}` : ''})` } : {}),
        })

        if (!reconnectTimeoutRef.current) {
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null
            connect()
          }, RECONNECT_DELAY_MS)
        }
      }

      ws.onerror = () => {
        useSessionsStore.setState({ error: `WebSocket connection failed: ${WS_URL}` })
      }

      ws.onmessage = event => {
        const raw = event.data as string
        recordIn(raw.length)
        const wsT0 = isPerfEnabled() ? performance.now() : 0
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
            msg.type === 'project_quick_add_response' ||
            msg.type === 'file_changed'
          ) {
            const handler = useSessionsStore.getState().fileHandler
            handler?.(msg as unknown as Record<string, unknown>)
            return
          }

          // Project board messages -> direct handler callback
          if (
            typeof msg.type === 'string' &&
            ((msg.type.startsWith('project_') && msg.type.endsWith('_response')) || msg.type === 'project_changed')
          ) {
            const handler = useSessionsStore.getState().projectHandler
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
              new CustomEvent('rclaude-toast', {
                detail: {
                  title,
                  body,
                  sessionId: msg.sessionId,
                  taskId: msg.taskId,
                  variant: msg.variant,
                },
              }),
            )
            return
          }

          // --- Buffer: state-updating messages ---
          msgBuffer.push(msg)
          scheduleFlush()
        } catch {
          // Ignore parse errors
        } finally {
          if (wsT0) perfRecord('ws', 'onmessage', performance.now() - wsT0, `${(raw.length / 1024).toFixed(1)}KB`)
        }
      }
    } catch {
      useSessionsStore.setState({ isConnected: false })
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - runs once on mount, send is a module-scope function
  useEffect(() => {
    connect()

    // Watch for session selection changes and manage channel subscriptions
    // Diff-based: keep subscriptions alive for LIFO-cached sessions
    // Uses selector-based subscribe to only fire when selectedSessionId or transcript keys change
    _subscribedSessions = new Set<string>()
    let _lastSelectedId: string | null = null
    let _lastTranscriptKeys: string = ''
    const unsubSessionion = useSessionsStore.subscribe(state => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return

      // Quick check: bail if nothing subscription-relevant changed
      const transcriptKeys = Object.keys(state.transcripts).sort().join(',')
      if (state.selectedSessionId === _lastSelectedId && transcriptKeys === _lastTranscriptKeys) return
      _lastSelectedId = state.selectedSessionId
      _lastTranscriptKeys = transcriptKeys

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
