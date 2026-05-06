/**
 * Staging test harness for live wire protocol validation.
 *
 * Connects to a REAL running broker via WebSocket and HTTP.
 * No mocks -- everything goes over the network. Reads config
 * from environment:
 *
 *   STAGING_BROKER_URL  -- host:port (e.g. "localhost:19999")
 *   STAGING_SECRET      -- shared secret for agent host auth
 */

import { AGENT_HOST_PROTOCOL_VERSION } from '../../../shared/protocol'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}

function getBrokerUrl(): string {
  return requireEnv('STAGING_BROKER_URL')
}

export function getBrokerSecret(): string {
  return requireEnv('STAGING_SECRET')
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpUrl(path: string): string {
  return `http://${getBrokerUrl()}${path}`
}

export async function httpGet(path: string, opts?: { bearer?: string }): Promise<Response> {
  const headers: Record<string, string> = {}
  if (opts?.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  return fetch(httpUrl(path), { headers })
}

// ---------------------------------------------------------------------------
// WebSocket client (Bun native)
// ---------------------------------------------------------------------------

export interface LiveWs {
  /** Raw WebSocket instance */
  raw: WebSocket
  /** All received messages (parsed JSON) */
  received: Array<Record<string, unknown>>
  /** Get messages of a specific type */
  messagesOfType(type: string): Array<Record<string, unknown>>
  /** Send a JSON message */
  send(data: Record<string, unknown>): void
  /** Close the connection */
  close(): void
  /** Wait until WS is open */
  waitOpen(): Promise<void>
  /** Whether the socket has been closed */
  closed: boolean
}

function createLiveWs(url: string): LiveWs {
  const received: Array<Record<string, unknown>> = []
  let closed = false
  let openResolve: (() => void) | null = null
  let openReject: ((err: Error) => void) | null = null
  const openPromise = new Promise<void>((res, rej) => {
    openResolve = res
    openReject = rej
  })

  const ws = new WebSocket(url)

  ws.onopen = () => {
    openResolve?.()
  }
  ws.onerror = ev => {
    openReject?.(new Error(`WebSocket error: ${ev}`))
  }
  ws.onmessage = ev => {
    try {
      const data = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      received.push(data)
    } catch {
      received.push({ _raw: String(ev.data) })
    }
  }
  ws.onclose = () => {
    closed = true
  }

  return {
    raw: ws,
    received,
    messagesOfType(type: string) {
      return received.filter(m => m.type === type)
    },
    send(data: Record<string, unknown>) {
      // Auto-inject protocolVersion on the two messages that gate on it.
      // The broker rejects agent_host_boot / meta without it; tests that
      // exercise the gate explicitly can override by setting it themselves.
      if ((data.type === 'agent_host_boot' || data.type === 'meta') && data.protocolVersion === undefined) {
        data = { ...data, protocolVersion: AGENT_HOST_PROTOCOL_VERSION }
      }
      ws.send(JSON.stringify(data))
    },
    close() {
      if (!closed) ws.close()
      closed = true
    },
    waitOpen() {
      return openPromise
    },
    get closed() {
      return closed
    },
  }
}

// ---------------------------------------------------------------------------
// Connection factories
// ---------------------------------------------------------------------------

/** All connections created during a test -- cleaned up by cleanup() */
const activeConnections: LiveWs[] = []

/**
 * Connect as an agent host (authenticates with shared secret).
 * Returns a LiveWs ready for wrapper_boot / meta messages.
 */
export async function connectAgentHost(): Promise<LiveWs> {
  const wsUrl = `ws://${getBrokerUrl()}/?secret=${encodeURIComponent(getBrokerSecret())}`
  const ws = createLiveWs(wsUrl)
  activeConnections.push(ws)
  await ws.waitOpen()
  return ws
}

/**
 * Connect as a dashboard subscriber (authenticates with shared secret).
 * Immediately sends the `subscribe` message after open.
 */
export async function connectDashboard(): Promise<LiveWs> {
  const wsUrl = `ws://${getBrokerUrl()}/?secret=${encodeURIComponent(getBrokerSecret())}`
  const ws = createLiveWs(wsUrl)
  activeConnections.push(ws)
  await ws.waitOpen()
  ws.send({ type: 'subscribe', protocolVersion: 2 })
  return ws
}

// ---------------------------------------------------------------------------
// Wait helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a message of a specific type to arrive on a WebSocket.
 * Checks existing messages first, then polls for new ones.
 */
export async function waitForMessage(ws: LiveWs, type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const msgs = ws.messagesOfType(type)
    if (msgs.length > 0) return msgs[msgs.length - 1]
    await sleep(50)
  }
  const types = ws.received.map(m => m.type).join(', ')
  throw new Error(`Timed out waiting for message type "${type}" after ${timeoutMs}ms (got: ${types || 'none'})`)
}

/**
 * Wait for a message matching a predicate. Use when the broker may emit
 * multiple messages of the same type (e.g. conversation_update for unrelated
 * conversations created by other tests in the same staging run) and the test
 * needs to pick the one that matches a specific id.
 */
export async function waitForMatch(
  ws: LiveWs,
  type: string,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const msgs = ws.messagesOfType(type).filter(predicate)
    if (msgs.length > 0) return msgs[msgs.length - 1]
    await sleep(50)
  }
  const types = ws.received.map(m => m.type).join(', ')
  throw new Error(
    `Timed out waiting for message type "${type}" matching predicate after ${timeoutMs}ms (got: ${types || 'none'})`,
  )
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Generate a unique ID for test isolation */
export function testId(prefix = 'test'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

/** Close all active WebSocket connections */
export function cleanup(): void {
  for (const ws of activeConnections) {
    ws.close()
  }
  activeConnections.length = 0
}
