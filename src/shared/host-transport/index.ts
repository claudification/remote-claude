/**
 * Host transport primitive -- shared between every agent host binary.
 *
 * Owns the parts of agent-host <-> broker WebSocket plumbing that are
 * identical regardless of whether you're wrapping Claude Code, OpenCode,
 * Codex, Pi, or some future backend:
 *
 *   - WebSocket lifecycle (connect, reconnect with exponential backoff)
 *   - Outbound message queue (buffers messages while disconnected)
 *   - Transcript-entries ring buffer (replayed on reconnect for crash recovery)
 *   - Heartbeat (30s default)
 *   - protocol_upgrade_required handling (visible banner + exit(2))
 *   - conversation_promote dispatch when a backend-specific session id is
 *     learned (CC's `ccSessionId`, OpenCode's `ses_xxx`, etc.)
 *
 * The transport is deliberately ignorant of message *semantics*. The host
 * passes:
 *   - `buildInitialMessage()` -- called on every (re)connect to send the
 *     first message (AgentHostBoot, ConversationMeta, or a future variant).
 *   - `onMessage(msg)` -- inbound dispatch. The host routes by `msg.type`.
 *
 * Caller owns: message schema knowledge, callback contracts, host-specific
 * state. Transport owns: WS, queue, heartbeat, ring buffer, reconnect.
 *
 * Why this lives in `src/shared/`: every agent host needs the same plumbing
 * but the broker should never know which host is talking to it. Sharing the
 * transport keeps the wire-protocol invariant (heartbeat cadence, ring buffer
 * size, reconnect cap, upgrade handling) IDENTICAL across hosts -- a place
 * where divergence would silently break the broker's assumptions.
 *
 * See `.claude/docs/plan-pluggable-backends.md` for the broker-side mirror
 * of this abstraction.
 */

import type {
  AgentHostMessage,
  BrokerMessage,
  ConversationPromote,
  Heartbeat,
  TranscriptEntries,
  TranscriptEntry,
} from '../protocol'
import { DEFAULT_BROKER_URL } from '../protocol'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HostTransportOptions {
  /** Broker WS URL. Default: ws://localhost:9999. */
  brokerUrl?: string
  /** Optional shared secret. Appended as `?secret=...` query param. */
  brokerSecret?: string
  /** Stable conversation id used for heartbeat routing and conversation_promote. */
  conversationId: string

  /**
   * Called on every (re)connect to build the first wire message sent to
   * the broker. Hosts use this to choose between `agent_host_boot` and
   * `meta` depending on whether they already know a backend-specific
   * session id.
   *
   * Throwing here aborts the connection (no retry, the caller's `onError`
   * is invoked) -- it's the host's signal that the configuration is bad.
   */
  buildInitialMessage: () => AgentHostMessage

  /**
   * Called for every inbound broker message. The transport dispatches
   * `protocol_upgrade_required` itself (it's lethal -- exits the process)
   * but everything else is the caller's problem.
   */
  onMessage?: (msg: BrokerMessage) => void

  onConnected?: () => void
  onDisconnected?: () => void
  onError?: (err: Error) => void

  /** Optional structured diag sink. The transport emits a few well-known
   *  warnings (queue full, heartbeat send failed, dead-socket fall-through). */
  onDiag?: (kind: 'transport', msg: string, args?: unknown) => void

  /** Wire trace -- called once per inbound + outbound message. The default
   *  is silent. Hosts wire this to their debug logger when needed. */
  trace?: (direction: 'in' | 'out', message: unknown) => void

  /** Reconnect tuning. Defaults: 50 attempts, 60s cap, exponential 2^n. */
  reconnect?: {
    maxAttempts?: number
    capMs?: number
  }

  /** Heartbeat interval in ms. Default: 30_000. */
  heartbeatIntervalMs?: number

  /** Outbound queue size while disconnected. Default: 5_000.
   *  Once full, oldest messages are dropped (with a `onDiag` warning). */
  queueSize?: number

  /** Transcript-entries ring buffer size for replay-on-reconnect.
   *  The broker dedupes by uuid + seq, so over-replaying is safe. Default: 50. */
  transcriptRingSize?: number

  /** Behaviour when the broker sends `protocol_upgrade_required`.
   *  Default: print a visible banner to stderr and call `process.exit(2)`.
   *  Tests pass `'throw'` to inspect the rejection without exiting. */
  onProtocolUpgradeRequired?: 'exit' | 'throw' | ((msg: BrokerMessage) => void)
}

export interface HostTransport {
  /** Send any agent-host message. Queued while disconnected. */
  send(msg: AgentHostMessage): void

  /** Send transcript entries. Tracked in the ring buffer so they get
   *  replayed on reconnect (broker dedupes by uuid). */
  sendTranscriptEntries(entries: TranscriptEntry[], isInitial: boolean): void

  /** Once a backend-specific session id is learned (CC's session id,
   *  OpenCode's `ses_xxx`, ...), call this. Sends `conversation_promote`
   *  exactly once -- subsequent calls with the same id are no-ops, calls
   *  with a different id reset and re-promote. */
  setSessionId(ccSessionId: string, source: 'stream_json' | 'hook'): void

  /** Close the WS and stop reconnecting. */
  close(): void

  /** Whether the WS is currently OPEN. */
  isConnected(): boolean

  /** Manually flush queued messages. Called automatically on (re)connect.
   *  Exposed for tests + edge-case host code. */
  flush(): void
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createHostTransport(opts: HostTransportOptions): HostTransport {
  const brokerUrl = opts.brokerUrl ?? DEFAULT_BROKER_URL
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30_000
  const queueSize = opts.queueSize ?? 5_000
  const transcriptRingSize = opts.transcriptRingSize ?? 50
  const reconnectMax = opts.reconnect?.maxAttempts ?? 50
  const reconnectCapMs = opts.reconnect?.capMs ?? 60_000
  const upgradeBehaviour = opts.onProtocolUpgradeRequired ?? 'exit'

  const wsUrl = opts.brokerSecret
    ? `${brokerUrl}${brokerUrl.includes('?') ? '&' : '?'}secret=${encodeURIComponent(opts.brokerSecret)}`
    : brokerUrl

  let ws: WebSocket | null = null
  let connected = false
  let shouldReconnect = true
  let reconnectAttempts = 0
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let lastSessionId: string | null = null

  const queue: AgentHostMessage[] = []
  function enqueue(msg: AgentHostMessage) {
    if (queue.length >= queueSize) {
      // Drop oldest -- prefer keeping recent transcript over ancient state.
      queue.shift()
      opts.onDiag?.('transport', 'queue full, dropped oldest message', { size: queueSize })
    }
    queue.push(msg)
  }

  // Ring buffer: last N transcript-entries messages, replayed on every
  // reconnect. Broker deduplicates via UUID (SQLite INSERT OR IGNORE) and
  // client deduplicates via seq.
  const ring: TranscriptEntries[] = new Array(transcriptRingSize)
  let ringHead = 0
  let ringCount = 0
  function pushRing(msg: TranscriptEntries) {
    ring[ringHead] = msg
    ringHead = (ringHead + 1) % transcriptRingSize
    if (ringCount < transcriptRingSize) ringCount++
  }
  function flushRing() {
    if (ringCount === 0 || !ws || !connected) return
    const start = (ringHead - ringCount + transcriptRingSize) % transcriptRingSize
    for (let i = 0; i < ringCount; i++) {
      const idx = (start + i) % transcriptRingSize
      const m = ring[idx]
      if (m) {
        try {
          opts.trace?.('out', m)
          ws.send(JSON.stringify(m))
        } catch {
          break
        }
      }
    }
  }

  function rawSend(msg: AgentHostMessage): boolean {
    if (!ws || !connected) return false
    try {
      opts.trace?.('out', msg)
      ws.send(JSON.stringify(msg))
      return true
    } catch (err) {
      opts.onDiag?.('transport', 'send failed (will requeue)', {
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  function send(msg: AgentHostMessage): void {
    if (rawSend(msg)) return
    enqueue(msg)
  }

  function flush(): void {
    while (queue.length > 0 && ws && connected) {
      const m = queue[0]
      if (!m) {
        queue.shift()
        continue
      }
      if (!rawSend(m)) return
      queue.shift()
    }
  }

  function sendTranscriptEntries(entries: TranscriptEntry[], isInitial: boolean): void {
    const msg: TranscriptEntries = {
      type: 'transcript_entries',
      conversationId: opts.conversationId,
      entries,
      isInitial,
    }
    pushRing(msg)
    send(msg)
  }

  function setSessionId(newId: string, source: 'stream_json' | 'hook'): void {
    if (lastSessionId === newId) return
    lastSessionId = newId
    const promote: ConversationPromote = {
      type: 'conversation_promote',
      conversationId: opts.conversationId,
      ccSessionId: newId,
      source,
    }
    send(promote)
  }

  function handleProtocolUpgrade(msg: BrokerMessage): void {
    shouldReconnect = false
    if (typeof upgradeBehaviour === 'function') {
      upgradeBehaviour(msg)
      return
    }
    if (upgradeBehaviour === 'throw') {
      opts.onError?.(new Error(`protocol upgrade required: ${(msg as { reason?: string }).reason ?? 'unknown'}`))
      return
    }
    // 'exit' default -- print the banner and exit(2). Same lethal behaviour
    // claude-agent-host has used since v0.7 so the user sees the upgrade
    // hint even if tmux/sentinel restart the process.
    const m = msg as Record<string, unknown>
    const banner = [
      '',
      '════════════════════════════════════════════════════════════════════',
      '  agent host is OUT OF DATE -- broker rejected the connection',
      '════════════════════════════════════════════════════════════════════',
      `  reason:   ${m.reason}`,
      `  broker:   v${m.serverProtocolVersion}`,
      `  this CLI: v${m.clientProtocolVersion ?? '<missing>'}`,
      '',
      '  Upgrade with:',
      '',
      `      ${m.upgradeCommand}`,
      '',
      ...(m.details ? [`  Details: ${m.details}`, ''] : []),
      '════════════════════════════════════════════════════════════════════',
      '',
    ].join('\n')
    process.stderr.write(banner)
    opts.onError?.(new Error(`protocol upgrade required: ${m.reason}`))
    try {
      ws?.close(1002, 'protocol upgrade required')
    } catch {}
    process.exit(2)
  }

  function startHeartbeat(): void {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = setInterval(() => {
      if (!connected || !ws) return
      const hb: Heartbeat = {
        type: 'heartbeat',
        conversationId: opts.conversationId,
        timestamp: Date.now(),
      }
      try {
        opts.trace?.('out', hb)
        ws.send(JSON.stringify(hb))
      } catch (err) {
        opts.onDiag?.('transport', 'heartbeat send failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }, heartbeatIntervalMs)
  }

  function stopHeartbeat(): void {
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }

  function connect(): void {
    let initialMessage: AgentHostMessage
    try {
      initialMessage = opts.buildInitialMessage()
    } catch (err) {
      shouldReconnect = false
      opts.onError?.(err instanceof Error ? err : new Error(String(err)))
      return
    }

    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      connected = true
      reconnectAttempts = 0
      try {
        opts.trace?.('out', initialMessage)
        ws?.send(JSON.stringify(initialMessage))
      } catch (err) {
        opts.onDiag?.('transport', 'initial message send failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      flush()
      flushRing()
      startHeartbeat()
      opts.onConnected?.()
    }

    ws.onclose = () => {
      const wasConnected = connected
      connected = false
      stopHeartbeat()
      if (wasConnected) opts.onDisconnected?.()
      if (!shouldReconnect) return
      reconnectAttempts++
      if (reconnectAttempts > reconnectMax) {
        opts.onError?.(new Error(`WebSocket reconnection gave up after ${reconnectMax} attempts`))
        return
      }
      const delay = Math.min(1000 * 2 ** Math.min(reconnectAttempts, 6), reconnectCapMs)
      setTimeout(connect, delay)
    }

    ws.onerror = ev => {
      const detail = (ev as ErrorEvent).message ?? (ev as ErrorEvent).error ?? 'unknown'
      opts.onError?.(new Error(`WebSocket error: ${detail}`))
    }

    ws.onmessage = ev => {
      let msg: BrokerMessage
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as BrokerMessage
      } catch {
        opts.onDiag?.('transport', 'malformed JSON inbound (ignored)')
        return
      }
      opts.trace?.('in', msg)
      if ((msg as { type?: string }).type === 'protocol_upgrade_required') {
        handleProtocolUpgrade(msg)
        return
      }
      try {
        opts.onMessage?.(msg)
      } catch (err) {
        opts.onDiag?.('transport', 'onMessage handler threw', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  connect()

  return {
    send,
    sendTranscriptEntries,
    setSessionId,
    flush,
    isConnected: () => connected,
    close: () => {
      shouldReconnect = false
      stopHeartbeat()
      try {
        ws?.close()
      } catch {}
    },
  }
}
