/**
 * WebSocket hook for real-time updates from broker
 *
 * Uses rAF buffering + unstable_batchedUpdates to coalesce multiple WS messages
 * into a single React render per frame. Latency-sensitive handlers (terminal, file,
 * toast) bypass the buffer and dispatch immediately.
 */
import { useCallback, useEffect, useRef } from 'react'
import { unstable_batchedUpdates as batchUpdates } from 'react-dom'

// Graceful fallback if unstable_batchedUpdates is ever removed
const batch: (fn: () => void) => void = batchUpdates ?? (fn => fn())

import { isPerfEnabled, record as perfRecord } from '@/lib/perf-metrics'
import { buildWsUrl } from '@/lib/share-mode'
import {
  fetchTranscript,
  handleBgTaskOutputMessage,
  resolveConfigResponse,
  useConversationsStore,
} from './use-conversations'
import { type DashboardMessage, handlers } from './use-websocket-handlers'
import { recordIn, recordOut } from './ws-stats'

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

  const handler = handlers[msg.type]
  if (handler) handler(msg)
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

          // Agent host outdated: an old binary tried to connect and the broker
          // rejected it. Surface as a persistent warning toast so the user
          // notices even when the agent host's terminal isn't visible.
          if (msg.type === 'agent_host_outdated') {
            const project = (msg.project as string | null) || 'unknown project'
            const upgradeCommand = (msg.upgradeCommand as string) || ''
            const reason = (msg.reason as string) || 'Outdated wire protocol'
            window.dispatchEvent(
              new CustomEvent('rclaude-toast', {
                detail: {
                  title: 'Agent host upgrade required',
                  body: `${project}\n${reason}\n\nRun: ${upgradeCommand}`,
                  variant: 'warning',
                  persistent: true,
                  copyText: upgradeCommand,
                },
              }),
            )
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
