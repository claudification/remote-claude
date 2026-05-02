/**
 * WebSocket hook for real-time updates from broker
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

import type { ConversationSummary } from '@shared/protocol'
import { isPerfEnabled, record as perfRecord } from '@/lib/perf-metrics'
import { buildWsUrl } from '@/lib/share-mode'
import type { HookEvent, ProjectOrder, Session, TaskInfo, TranscriptEntry } from '@/lib/types'
import {
  applyHashRoute,
  buildConversationsById,
  fetchTranscript,
  handleBgTaskOutputMessage,
  type ProjectSettingsMap,
  resolveConfigResponse,
  useConversationsStore,
} from './use-conversations'
import { handleSpawnRequestAck } from './use-spawn'
import { recordIn, recordOut } from './ws-stats'

// Dashboard message from broker WS (loose type field for extensibility)
interface DashboardMessage {
  type: string
  conversationId?: string
  previousSessionId?: string
  session?: ConversationSummary
  sessions?: ConversationSummary[]
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

let _wsUrl: string | null = null
function getWsUrl() {
  if (!_wsUrl) _wsUrl = buildWsUrl()
  return _wsUrl
}
const RECONNECT_DELAY_MS = 2000
const SESSION_CHANNELS = [
  'conversation:events',
  'conversation:transcript',
  'conversation:tasks',
  'conversation:bg_output',
] as const

// --- rAF message buffer (module-level, outside React) ---
let msgBuffer: DashboardMessage[] = []
let rafScheduled = false

// Module-level subscription tracking - must be clearable from onopen handler
let _subscribedSessions = new Set<string>()
function clearSubscribedSessions() {
  _subscribedSessions = new Set<string>()
}

function toSession(summary: ConversationSummary): Session {
  return {
    id: summary.id,
    project: summary.project,
    model: summary.model,
    capabilities: summary.capabilities,
    ccSessionIds: summary.ccSessionIds,
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
    permissionMode: summary.permissionMode,
    lastError: summary.lastError,
    rateLimit: summary.rateLimit,
    planMode: summary.planMode,
    pendingAttention: summary.pendingAttention,
    hasNotification: summary.hasNotification,
    summary: summary.summary,
    title: summary.title,
    description: summary.description,
    agentName: summary.agentName,
    prLinks: summary.prLinks,
    linkedProjects: summary.linkedProjects,
    tokenUsage: summary.tokenUsage,
    contextWindow: summary.contextWindow,
    cacheTtl: summary.cacheTtl,
    lastTurnEndedAt: summary.lastTurnEndedAt,
    stats: summary.stats,
    costTimeline: summary.costTimeline,
    gitBranch: summary.gitBranch,
    adHocTaskId: summary.adHocTaskId,
    adHocWorktree: summary.adHocWorktree,
    resultText: summary.resultText,
    recap: summary.recap,
    recapFresh: summary.recapFresh,
    hostSentinelId: summary.hostSentinelId,
    hostSentinelAlias: summary.hostSentinelAlias,
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
  const { syncSeq: prevSeq, syncEpoch: prevEpoch } = useConversationsStore.getState()
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
    useConversationsStore.setState({ syncEpoch: epoch, syncSeq: maxSeq })
  }

  batch(() => {
    for (const msg of pending) {
      processMessage(msg)
    }
  })
}

// Server now reports staleTranscripts as { [sid]: serverLastSeq }. Compare
// against our lastAppliedTranscriptSeq to decide what to refetch, and fetch
// via ?sinceSeq=N delta so we only pull the gap rather than the entire tail.
//
// Edge case: server returns `gap: true` when its cache has evicted entries
// older than our sinceSeq (MAX_TRANSCRIPT_ENTRIES rolled over past us). Treat
// gap=true as "full replace with what you got", not an append -- otherwise
// we'd have a hole between our lastAppliedSeq and the first returned seq.
function refetchStaleTranscripts(staleTranscripts?: Record<string, number>): void {
  if (!staleTranscripts) return
  const { lastAppliedTranscriptSeq, setTranscript } = useConversationsStore.getState()
  const sids = Object.keys(staleTranscripts)
  const actuallyStale = sids.filter(s => {
    const localSeq = lastAppliedTranscriptSeq[s] ?? 0
    const serverSeq = staleTranscripts[s]
    return serverSeq > localSeq
  })
  if (actuallyStale.length === 0) {
    console.log(`[sync] staleTranscripts=${sids.length} all-in-sync (no refetch)`)
    return
  }
  console.log(
    `[sync] STALE transcripts: ${actuallyStale
      .map(s => `${s.slice(0, 8)} serverSeq=${staleTranscripts[s]} localSeq=${lastAppliedTranscriptSeq[s] ?? 0}`)
      .join(', ')}`,
  )
  for (const sid of actuallyStale) {
    const sinceSeq = lastAppliedTranscriptSeq[sid] ?? 0
    fetchTranscript(sid, sinceSeq).then(result => {
      if (!result) {
        console.log(`[sync] REFETCH transcript ${sid.slice(0, 8)}: FAILED (null response)`)
        return
      }
      if (result.gap) {
        // Server couldn't fulfil the delta (we were behind by more than the
        // cache holds). Full replace from whatever server has.
        console.log(
          `[sync] REFETCH transcript ${sid.slice(0, 8)}: GAP delta=${result.entries.length} lastSeq=${result.lastSeq} -- full replace`,
        )
        setTranscript(sid, result.entries)
        return
      }
      if (result.entries.length === 0) {
        // Nothing to apply -- but bump our lastAppliedSeq to server's lastSeq
        // so we stop asking. Happens if server advanced its counter without
        // net-new cached entries (e.g. all new entries got evicted between
        // sync_check and our fetch).
        useConversationsStore.setState(state => ({
          lastAppliedTranscriptSeq: { ...state.lastAppliedTranscriptSeq, [sid]: result.lastSeq },
        }))
        console.log(`[sync] REFETCH transcript ${sid.slice(0, 8)}: no new entries, bumped seq -> ${result.lastSeq}`)
        return
      }
      // Normal delta: append to existing transcript.
      useConversationsStore.setState(state => {
        const existing = state.transcripts[sid] || []
        // Guard: only append entries strictly newer than what we have.
        // Handles the race where a WS transcript_entries broadcast landed
        // between our sync_check send and this HTTP response.
        const localMax = state.lastAppliedTranscriptSeq[sid] ?? 0
        const fresh = result.entries.filter(e => (e.seq ?? 0) > localMax)
        if (fresh.length === 0) {
          return {
            lastAppliedTranscriptSeq: { ...state.lastAppliedTranscriptSeq, [sid]: Math.max(localMax, result.lastSeq) },
          }
        }
        console.log(
          `[sync] REFETCH transcript ${sid.slice(0, 8)}: +${fresh.length} delta entries (lastSeq ${localMax} -> ${result.lastSeq})`,
        )
        return {
          transcripts: { ...state.transcripts, [sid]: [...existing, ...fresh] },
          lastAppliedTranscriptSeq: { ...state.lastAppliedTranscriptSeq, [sid]: result.lastSeq },
          newDataSeq: state.newDataSeq + 1,
        }
      })
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
      const stale = syncMsg.staleTranscripts
      const staleInfo = stale ? ` staleTranscripts=${Object.keys(stale).length}` : ''
      console.log(`[sync] <- sync_ok (epoch=${ok.epoch?.slice(0, 8)} seq=${ok.seq})${staleInfo}`)
      break
    }
    case 'sync_catchup': {
      const cu = msg as DashboardMessage & { count?: number; epoch?: string; seq?: number }
      const stale = syncMsg.staleTranscripts
      const staleInfo = stale ? ` staleTranscripts=${Object.keys(stale).length}` : ''
      console.log(
        `[sync] <- sync_catchup: ${cu.count} missed (epoch=${cu.epoch?.slice(0, 8)} seq=${cu.seq})${staleInfo}`,
      )
      break
    }
    case 'sync_stale': {
      const stale = msg as DashboardMessage & { reason?: string; missed?: number; epoch?: string; seq?: number }
      const staleTranscripts = syncMsg.staleTranscripts
      const staleInfo = staleTranscripts ? ` staleTranscripts=${Object.keys(staleTranscripts).length}` : ''
      console.log(`[sync] <- sync_stale: ${stale.reason || 'unknown'} missed=${stale.missed || '?'}${staleInfo}`)
      // Full resync needed - bump connectSeq (triggers LIFO eviction + re-fetch in onopen).
      // Clear lastAppliedTranscriptSeq: epoch changed means server's per-conversation
      // seq counters reset, so our stored seqs are from the previous generation
      // and would false-negative a future sync_check. The upcoming initial
      // transcript_entries broadcasts will reseed from fresh seqs.
      useConversationsStore.setState(s => ({
        connectSeq: s.connectSeq + 1,
        syncEpoch: stale.epoch || '',
        syncSeq: stale.seq || 0,
        lastAppliedTranscriptSeq: {},
      }))
      break
    }
    case 'conversations_list': {
      if (msg.sessions) {
        useConversationsStore.getState().setConversations(msg.sessions.map(toSession))
        applyHashRoute()
      }
      // Check for version mismatch between server and this frontend bundle
      // Compare just the 7-char git hash, ignoring -dirty suffix
      // Version mismatch detection removed -- SW lifecycle handles update detection.
      // When sw.js changes, browser installs new SW and sends 'sw-updated' postMessage.
      break
    }
    case 'conversation_created': {
      if (msg.session) {
        const newConversation = toSession(msg.session)
        useConversationsStore.setState(state => {
          let sessions: Session[]
          if (state.sessions.some(s => s.id === newConversation.id)) {
            sessions = state.sessions.map(s => (s.id === newConversation.id ? { ...s, ...newConversation } : s))
          } else {
            sessions = [...state.sessions, newConversation]
          }
          return { sessions, sessionsById: buildConversationsById(sessions) }
        })
      }
      break
    }
    case 'conversation_ended':
    case 'conversation_update': {
      if (msg.session && msg.conversationId) {
        const conversationId = msg.conversationId
        const session = msg.session
        const prevId = msg.previousSessionId
        const matchId = prevId || conversationId
        useConversationsStore.setState(state => {
          const updated = toSession(session)
          // Rekey collision: if two booting placeholders (different conversationIds)
          // both get rekeyed to the same real session id, the map-replace leaves
          // two entries in the array with identical `updated.id`. Dedupe by id
          // (merge any duplicates into the first occurrence) so the sidebar
          // doesn't render ghost rows. Without dedupe, a double-spawn shows as
          // two identical session rows sharing a short-id.
          const replaced = state.sessions.map(s => (s.id === matchId ? { ...s, ...updated } : s))
          const seen = new Set<string>()
          const sessions: Session[] = []
          for (const s of replaced) {
            if (seen.has(s.id)) continue
            seen.add(s.id)
            sessions.push(s)
          }
          const newState: Partial<typeof state> = {
            sessions,
            sessionsById: buildConversationsById(sessions),
          }
          // Clear stale streaming text when session goes idle or ends
          if ((updated.status === 'idle' || updated.status === 'ended') && state.streamingText[conversationId]) {
            const { [conversationId]: _, ...rest } = state.streamingText
            newState.streamingText = rest
          }
          if (prevId && state.selectedConversationId === prevId) {
            console.log(
              `[nav] session rekey: ${prevId.slice(0, 8)} -> ${conversationId.slice(0, 8)} (selected session rekeyed)`,
            )
            newState.selectedConversationId = conversationId
            const oldEvents = state.events[prevId]
            const oldTranscripts = state.transcripts[prevId]
            if (oldEvents || oldTranscripts) {
              const events = { ...state.events }
              const transcripts = { ...state.transcripts }
              delete events[prevId]
              delete transcripts[prevId]
              // Preserve any data already received for the new conversation ID
              // (e.g. compacting marker broadcast during rekey)
              if (!events[conversationId]) events[conversationId] = []
              if (!transcripts[conversationId]) transcripts[conversationId] = []
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
            `[sync] session_update: REKEY ${prevId.slice(0, 8)} -> ${conversationId.slice(0, 8)} status=${session.status}`,
          )
          // Delay: broker processes rekey and re-receives transcript from rclaude.
          // 500ms gives the transcript watcher time to stream initial entries to the new ID.
          setTimeout(() => {
            fetchTranscript(conversationId).then(transcript => {
              console.log(
                `[sync] rekey refetch ${conversationId.slice(0, 8)}: ${transcript?.entries.length ?? 'null'} entries lastSeq=${transcript?.lastSeq ?? '-'}`,
              )
              if (transcript) useConversationsStore.getState().setTranscript(conversationId, transcript.entries)
            })
          }, 500)
        } else if (session.status === 'starting') {
          const state = useConversationsStore.getState()
          const cached = state.transcripts[conversationId]?.length ?? 0
          const isSelected = state.selectedConversationId === conversationId
          console.log(
            `[sync] session_update: RESUME ${conversationId.slice(0, 8)} selected=${isSelected} cached=${cached}`,
          )
          if (isSelected) {
            // Always refetch on resume -- transcript may have been corrupted by a
            // same-ID rekey or the conversation may have new data from a restart.
            setTimeout(() => {
              fetchTranscript(conversationId).then(transcript => {
                console.log(
                  `[sync] resume refetch ${conversationId.slice(0, 8)}: ${transcript?.entries.length ?? 'null'} entries lastSeq=${transcript?.lastSeq ?? '-'}`,
                )
                if (transcript) useConversationsStore.getState().setTranscript(conversationId, transcript.entries)
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
      if (msg.event && msg.conversationId) {
        const sid = msg.conversationId
        const evt = msg.event
        useConversationsStore.setState(state => {
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
      if (msg.conversationId && msg.entries?.length) {
        const sid = msg.conversationId
        const newEntries = msg.entries as TranscriptEntry[]
        const initial = msg.isInitial
        useConversationsStore.setState(state => {
          const existing = state.transcripts[sid] || []
          // isInitial=true REPLACES the cache. The wrapper fires this on WS
          // reconnect (resendTranscriptFromFile in headless) and on PTY
          // truncation. If the snapshot is SMALLER than what we already have
          // AND the first entry matches, the snapshot was taken before CC
          // flushed the newest entries -- swallowing the replace would wipe
          // live entries the client already displayed. Skip in that case
          // (mirrors setTranscript's guard). When first entries differ
          // (e.g. /clear created a new conversation, or compaction rewrote
          // the prefix) the replace is legitimate -- proceed.
          let result: TranscriptEntry[]
          let skipped = false
          if (initial && existing.length > newEntries.length && existing.length > 0 && newEntries.length > 0) {
            const fp = (e: TranscriptEntry) => {
              const m = (e as { message?: { content?: unknown } }).message
              const c = m?.content
              return JSON.stringify(c ?? e.type)?.slice(0, 100)
            }
            if (fp(existing[0]) === fp(newEntries[0])) {
              result = existing
              skipped = true
            } else {
              result = newEntries
            }
          } else if (initial) {
            result = newEntries
          } else {
            // Incremental append -- dedup by seq against our last-applied.
            // Guards the race where a sync_check delta fetch raced with a live
            // WS broadcast and we applied the delta first. Without this guard,
            // the broadcast would re-append entries we already have.
            const localMax = state.lastAppliedTranscriptSeq[sid] ?? 0
            const fresh = newEntries.filter(e => e.seq === undefined || e.seq > localMax)
            if (fresh.length === 0) {
              return {}
            }
            result = [...existing, ...fresh]
          }
          if (initial || newEntries.length > 2) {
            console.log(
              `[ws] transcript ${sid.slice(0, 8)}: +${newEntries.length} ${initial ? (skipped ? 'INITIAL-SKIP' : 'INITIAL') : 'incremental'} (total=${result.length})`,
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
          // Update lastAppliedTranscriptSeq to max(existing, max-in-result).
          // Skipped initial snapshots don't move the marker (result === existing).
          const maxSeqInResult = result.length > 0 ? (result[result.length - 1].seq ?? 0) : 0
          const prevSeq = state.lastAppliedTranscriptSeq[sid] ?? 0
          const newSeq = Math.max(prevSeq, maxSeqInResult)
          return {
            transcripts: {
              ...state.transcripts,
              [sid]: result,
            },
            lastAppliedTranscriptSeq:
              newSeq !== prevSeq
                ? { ...state.lastAppliedTranscriptSeq, [sid]: newSeq }
                : state.lastAppliedTranscriptSeq,
            streamingText,
            newDataSeq: state.newDataSeq + 1,
          }
        })
      }
      break
    }
    case 'conversation_info': {
      // Session metadata from headless init - store for autocomplete
      const sid = msg.conversationId as string
      if (sid) {
        useConversationsStore.setState(state => ({
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
      const sid = msg.conversationId as string
      const event = msg.event as Record<string, unknown> | undefined
      if (sid && event) {
        const eventType = event.type as string
        if (eventType === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown> | undefined
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            useConversationsStore.setState(state => {
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
        } else if (eventType === 'message_start') {
          // New turn -- reset streaming buffer. Do NOT reset on content_block_start:
          // a single assistant message can have multiple text blocks (interleaved with
          // tool_use / thinking) and resetting on each block wipes earlier text_deltas
          // before message_stop flushes the final assistant entry, making the first
          // block look "missed" to the viewer.
          useConversationsStore.setState(state => {
            if (!state.streamingText[sid]) return state
            return { streamingText: { ...state.streamingText, [sid]: '' } }
          })
        } else if (eventType === 'message_stop') {
          // Turn complete -- clear streaming buffer entirely
          useConversationsStore.setState(state => {
            if (!state.streamingText[sid]) return state
            const { [sid]: _, ...rest } = state.streamingText
            return { streamingText: rest }
          })
        }
      }
      break
    }
    case 'subagent_transcript': {
      if (msg.conversationId && msg.entries?.length) {
        const subMsg = msg as DashboardMessage & { agentId?: string }
        const agentId = subMsg.agentId
        if (agentId) {
          const sid = msg.conversationId
          const newEntries = msg.entries
          const initial = msg.isInitial
          const key = `${sid}:${agentId}`
          useConversationsStore.setState(state => {
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
      if (msg.conversationId && msg.tasks) {
        const sid = msg.conversationId
        const taskList = msg.tasks
        useConversationsStore.setState(state => ({
          tasks: { ...state.tasks, [sid]: taskList },
        }))
      }
      break
    }
    case 'sentinel_status': {
      if (msg.connected !== undefined) {
        useConversationsStore.getState().setSentinelConnected(msg.connected, msg.sentinels)
      }
      break
    }
    case 'usage_update': {
      if (msg.usage) {
        useConversationsStore.getState().setPlanUsage(msg.usage)
      }
      break
    }
    case 'settings_updated': {
      if (msg.settings) {
        useConversationsStore.setState({ globalSettings: msg.settings as Record<string, unknown> })
      }
      break
    }
    case 'project_settings_updated': {
      if (msg.settings) {
        useConversationsStore.getState().setProjectSettings(msg.settings as ProjectSettingsMap)
      }
      break
    }
    case 'project_order_updated': {
      if (msg.order) {
        useConversationsStore.getState().setProjectOrder(msg.order as ProjectOrder)
      }
      break
    }
    case 'shares_updated': {
      if (msg.shares) {
        useConversationsStore.getState().setShares(msg.shares)
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
        useConversationsStore.setState(state => {
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
      const permSid = req.conversationId
      const permRid = req.requestId
      if (permSid && permRid) {
        useConversationsStore.setState(state => {
          if (state.pendingPermissions.some(p => p.requestId === permRid)) return state
          return {
            pendingPermissions: [
              ...state.pendingPermissions,
              {
                conversationId: permSid,
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
      if (auto.conversationId && auto.toolName) {
        // Emit a custom event that the conversation-detail can pick up for a brief toast
        window.dispatchEvent(
          new CustomEvent('permission-auto-approved', {
            detail: { conversationId: auto.conversationId, toolName: auto.toolName, description: auto.description },
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
      const askSid = askMsg.conversationId
      const askTuid = askMsg.toolUseId
      if (askSid && askTuid && askMsg.questions) {
        useConversationsStore.setState(state => {
          if (state.pendingAskQuestions.some(q => q.toolUseId === askTuid)) return state
          return {
            pendingAskQuestions: [
              ...state.pendingAskQuestions,
              {
                conversationId: askSid,
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
      const exSid = msg.conversationId as string
      const exId = msg.dialogId as string
      const exLayout = msg.layout as import('@shared/dialog-schema').DialogLayout
      if (exSid && exId && exLayout) {
        // Dedup: the wrapper replays dialog_show on reconnect. If we already
        // have this exact dialog open, preserve any in-progress user input.
        const existing = useConversationsStore.getState().pendingDialogs[exSid]
        if (existing?.dialogId === exId) break
        useConversationsStore.setState(state => ({
          pendingDialogs: {
            ...state.pendingDialogs,
            [exSid]: { dialogId: exId, layout: exLayout, timestamp: Date.now() },
          },
        }))
      }
      break
    }
    case 'dialog_dismiss': {
      const exSid = msg.conversationId as string
      if (exSid) {
        useConversationsStore.setState(state => {
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
      const paSid = pa.conversationId
      if (paSid && pa.requestId && pa.plan) {
        const dialogId = `plan_${pa.requestId}`
        // Dedup: wrapper replays plan_approval on reconnect so the broker
        // can rebuild pending state. If we already have this exact dialog open,
        // don't overwrite -- would wipe any feedback the user has typed.
        const existing = useConversationsStore.getState().pendingDialogs[paSid]
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
        useConversationsStore.setState(state => ({
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
      const sid = msg.conversationId
      if (sid) {
        useConversationsStore.setState(state => {
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
      if (clipMsg.conversationId && clipMsg.contentType) {
        useConversationsStore.setState(state => {
          const capture = {
            id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            conversationId: clipMsg.conversationId || '',
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
    case 'conversation_dismissed': {
      if (msg.conversationId) {
        useConversationsStore.setState(state => {
          const sessions = state.sessions.filter(s => s.id !== msg.conversationId)
          if (state.selectedConversationId === msg.conversationId) {
            console.log(`[nav] session_dismissed: clearing selection (WS dismissed ${msg.conversationId.slice(0, 8)})`)
          }
          return {
            sessions,
            sessionsById: buildConversationsById(sessions),
            selectedConversationId:
              state.selectedConversationId === msg.conversationId ? null : state.selectedConversationId,
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
        // Merge into existing sessionPermissions (incremental updates for new conversation)
        update.sessionPermissions = { ...useConversationsStore.getState().sessionPermissions, ...msg.sessions }
      }
      if (Object.keys(update).length > 0) useConversationsStore.setState(update)
      break
    }
    // WS action results (fire-and-forget error feedback)
    case 'send_input_result':
    case 'dismiss_conversation_result':
    case 'dismiss_session_result': // backward compat
    case 'update_settings_result':
    case 'update_project_settings_result':
    case 'delete_project_settings_result':
    case 'update_project_order_result':
    case 'revive_conversation_result':
    case 'revive_session_result': {
      // backward compat
      if (msg.ok === false) {
        console.error(`[ws] ${msg.type}: ${msg.error}`)
      }
      // Dispatch for LaunchMonitor to pick up
      window.dispatchEvent(new CustomEvent('revive-session-result', { detail: msg }))
      break
    }

    case 'revive_result': {
      // Agent's revive result -- forwarded by broker for pipeline tracking
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
          conversationId?: string
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
      const ws = new WebSocket(getWsUrl())
      wsRef.current = ws

      ws.onopen = () => {
        send({ type: 'subscribe', protocolVersion: 2 })

        // Single batched setState for ALL onopen state changes.
        // Multiple separate setState calls fire Zustand subscribers individually,
        // causing useSyncExternalStore tearing detection to loop (React #310).
        const { selectedConversationId, selectedSubagentId, transcripts, events, connectSeq } =
          useConversationsStore.getState()

        // Evict stale conversations from LIFO cache (non-selected sessions may have missed WS entries)
        const evictedSids = Object.keys(transcripts).filter(sid => sid !== selectedConversationId)
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
        useConversationsStore.setState({
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
        if (selectedConversationId) {
          for (const ch of SESSION_CHANNELS) {
            send({ type: 'channel_subscribe', channel: ch, conversationId: selectedConversationId })
          }
          _subscribedSessions.add(selectedConversationId)
          if (selectedSubagentId) {
            send({
              type: 'channel_subscribe',
              channel: 'conversation:subagent_transcript',
              conversationId: selectedConversationId,
              agentId: selectedSubagentId,
            })
          }
        }

        // Sync check after re-subscribing: detect transcript entries missed during
        // the disconnect gap (between subscribe and channel_subscribe, or entries
        // that arrived while WS was down). Small delay lets server process the
        // channel subscriptions first so the sync_check response is accurate.
        setTimeout(() => {
          // sync_check sends the last applied transcript seq per session, not
          // entry counts. Server compares against its own lastAssignedSeq per
          // session and replies with a delta list if we're behind.
          const { syncEpoch, syncSeq, lastAppliedTranscriptSeq } = useConversationsStore.getState()
          const transcriptSeqs: Record<string, number> = {}
          for (const [sid, seq] of Object.entries(lastAppliedTranscriptSeq)) {
            if (seq > 0) transcriptSeqs[sid] = seq
          }
          if (Object.keys(transcriptSeqs).length > 0) {
            const summary = Object.entries(transcriptSeqs)
              .map(([sid, s]) => `${sid.slice(0, 8)}@${s}`)
              .join(' ')
            console.log(
              `[sync] -> sync_check (reconnect) epoch=${syncEpoch.slice(0, 8)} seq=${syncSeq} transcriptSeqs=[${summary}]`,
            )
            send({ type: 'sync_check', epoch: syncEpoch, lastSeq: syncSeq, transcripts: transcriptSeqs })
          } else {
            console.log(`[sync] -> sync_check SKIP (reconnect): no tracked transcript seqs to compare`)
          }
        }, 500)
      }

      ws.onclose = e => {
        wsRef.current = null

        if (e.code === 1008 || e.code === 4401) {
          // Auth failure - don't reconnect, show expiry modal
          useConversationsStore.setState({
            isConnected: false,
            ws: null,
            authExpired: true,
            error: 'Session expired or unauthorized',
          })
          return
        }
        // Single setState for disconnect state
        useConversationsStore.setState({
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
        useConversationsStore.setState({ error: `WebSocket connection failed: ${getWsUrl()}` })
      }

      ws.onmessage = event => {
        const raw = event.data as string
        recordIn(raw.length)
        const wsT0 = isPerfEnabled() ? performance.now() : 0
        try {
          const msg = JSON.parse(raw) as DashboardMessage

          // --- Bypass buffer: latency-sensitive handlers ---

          // rclaude config responses -> promise resolution
          if (msg.type === 'rclaude_config_data' || msg.type === 'rclaude_config_ok') {
            resolveConfigResponse(msg as unknown as Record<string, unknown>)
            return
          }

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
            const handler = useConversationsStore.getState().fileHandler
            handler?.(msg as unknown as Record<string, unknown>)
            return
          }

          // Project board messages -> direct handler callback
          if (
            typeof msg.type === 'string' &&
            ((msg.type.startsWith('project_') && msg.type.endsWith('_response')) || msg.type === 'project_changed')
          ) {
            const handler = useConversationsStore.getState().projectHandler
            handler?.(msg as unknown as Record<string, unknown>)
            return
          }

          // Terminal data -> direct handler callback (low latency critical)
          if (msg.type === 'terminal_data' || msg.type === 'terminal_error') {
            const handler = useConversationsStore.getState().terminalHandler
            handler?.({
              type: msg.type as 'terminal_data' | 'terminal_error',
              conversationId: (msg as DashboardMessage & { conversationId?: string }).conversationId || '',
              data: msg.data,
              error: msg.error,
            })
            return
          }

          // JSON stream data -> direct handler callback (raw NDJSON for headless sessions)
          if (msg.type === 'json_stream_data') {
            const handler = useConversationsStore.getState().jsonStreamHandler
            handler?.({
              type: 'json_stream_data',
              conversationId: (msg as DashboardMessage & { conversationId?: string }).conversationId || '',
              lines: (msg as DashboardMessage & { lines?: string[] }).lines || [],
              isBackfill: !!(msg as DashboardMessage & { isBackfill?: boolean }).isBackfill,
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

          // Toast notifications -> direct DOM event + bell accumulation
          if (msg.type === 'toast') {
            const title = (msg.title as string) || 'Notification'
            const body = (msg.message as string) || ''
            window.dispatchEvent(
              new CustomEvent('rclaude-toast', {
                detail: {
                  title,
                  body,
                  conversationId: msg.conversationId,
                  taskId: msg.taskId,
                  variant: msg.variant,
                },
              }),
            )
            // Accumulate non-transient toasts into bell notifications
            if (msg.conversationId && !msg.variant) {
              const store = useConversationsStore.getState()
              const isViewing = store.selectedConversationId === msg.conversationId
              if (!isViewing) {
                useConversationsStore.setState(state => ({
                  notifications: [
                    ...state.notifications,
                    {
                      id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                      conversationId: msg.conversationId as string,
                      title,
                      message: body,
                      timestamp: Date.now(),
                    },
                  ],
                }))
              }
            }
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
      useConversationsStore.setState({ isConnected: false })
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - runs once on mount, send is a module-scope function
  useEffect(() => {
    connect()

    // Watch for session selection changes and manage channel subscriptions
    // Diff-based: keep subscriptions alive for LIFO-cached sessions
    // Uses selector-based subscribe to only fire when selectedConversationId or transcript keys change
    _subscribedSessions = new Set<string>()
    let _lastSelectedId: string | null = null
    let _lastTranscriptKeys: string = ''
    const unsubSessionion = useConversationsStore.subscribe(state => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return

      // Quick check: bail if nothing subscription-relevant changed
      const transcriptKeys = Object.keys(state.transcripts).sort().join(',')
      if (state.selectedConversationId === _lastSelectedId && transcriptKeys === _lastTranscriptKeys) return
      _lastSelectedId = state.selectedConversationId
      _lastTranscriptKeys = transcriptKeys

      // Desired subscriptions: selected + all conversations with cached transcripts
      const desired = new Set<string>()
      if (state.selectedConversationId) desired.add(state.selectedConversationId)
      for (const sid of Object.keys(state.transcripts)) {
        if (state.transcripts[sid]?.length) desired.add(sid)
      }

      // Unsubscribe sessions no longer in cache
      for (const sid of _subscribedSessions) {
        if (!desired.has(sid)) {
          for (const ch of SESSION_CHANNELS) {
            send({ type: 'channel_unsubscribe', channel: ch, conversationId: sid })
          }
        }
      }
      // Subscribe new conversation
      for (const sid of desired) {
        if (!_subscribedSessions.has(sid)) {
          for (const ch of SESSION_CHANNELS) {
            send({ type: 'channel_subscribe', channel: ch, conversationId: sid })
          }
        }
      }
      _subscribedSessions = desired
    })

    // Watch for subagent selection and subscribe to its transcript channel
    let lastSubagentKey: string | null = null
    const unsubAgent = useConversationsStore.subscribe(state => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
      const conversationId = state.selectedConversationId
      const agentId = state.selectedSubagentId
      const key = conversationId && agentId ? `${conversationId}:${agentId}` : null

      if (key === lastSubagentKey) return
      const prevKey = lastSubagentKey
      lastSubagentKey = key

      if (prevKey) {
        const [prevSid, prevAid] = prevKey.split(':')
        send({
          type: 'channel_unsubscribe',
          channel: 'conversation:subagent_transcript',
          conversationId: prevSid,
          agentId: prevAid,
        })
      }
      if (key && conversationId && agentId) {
        send({ type: 'channel_subscribe', channel: 'conversation:subagent_transcript', conversationId, agentId })
      }
    })

    // Periodic sync check: detect silently dropped transcript entries.
    // Runs every 60s while connected. Sends per-conversation lastAppliedSeq so the
    // server can report back any conversation where its counter has advanced past
    // what we've applied -- those get a ?sinceSeq=N delta refetch.
    const syncInterval = setInterval(() => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
      const { syncEpoch, syncSeq, lastAppliedTranscriptSeq } = useConversationsStore.getState()
      const transcriptSeqs: Record<string, number> = {}
      for (const [sid, seq] of Object.entries(lastAppliedTranscriptSeq)) {
        if (seq > 0) transcriptSeqs[sid] = seq
      }
      if (Object.keys(transcriptSeqs).length > 0) {
        const summary = Object.entries(transcriptSeqs)
          .map(([sid, s]) => `${sid.slice(0, 8)}@${s}`)
          .join(' ')
        console.log(
          `[sync] -> sync_check (periodic) epoch=${syncEpoch.slice(0, 8)} seq=${syncSeq} transcriptSeqs=[${summary}]`,
        )
        send({ type: 'sync_check', epoch: syncEpoch, lastSeq: syncSeq, transcripts: transcriptSeqs })
      }
    }, 60_000)

    return () => {
      unsubSessionion()
      unsubAgent()
      clearInterval(syncInterval)
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
