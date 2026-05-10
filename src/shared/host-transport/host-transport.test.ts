/**
 * Unit tests for the shared host-transport primitive.
 *
 * Strategy: stub `WebSocket` globally with an in-memory class we control. The
 * transport sees a real WebSocket-shaped object; we drive its lifecycle by
 * calling fake.open() / receive() / closeFromServer() from the test.
 *
 * No fake timers: bun:test doesn't ship vitest's timer mocks, so the timing-
 * sensitive tests configure tiny intervals (e.g. heartbeatIntervalMs: 50,
 * reconnect.capMs: 50) and use real sleeps. Each test stays under a second
 * even on slow CI.
 *
 * Covers the parts the transport owns: queueing, ring buffer replay,
 * heartbeat, reconnect backoff, conversation_promote dispatch, and
 * protocol_upgrade_required handling.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { AGENT_HOST_PROTOCOL_VERSION, type AgentHostBoot, type TranscriptUserEntry } from '../protocol'
import { createHostTransport, type HostTransport } from './index'

// ---------------------------------------------------------------------------
// FakeWebSocket -- minimal in-memory WS we install globally
// ---------------------------------------------------------------------------

interface FakeSocket {
  url: string
  sent: string[]
  closed: boolean
  closeCode?: number
  onopen?: () => void
  onclose?: (ev: { code?: number; reason?: string }) => void
  onerror?: (ev: { message?: string; error?: unknown }) => void
  onmessage?: (ev: { data: string }) => void
  /** Test-driven helpers */
  open(): void
  receive(payload: unknown): void
  closeFromServer(code?: number): void
  errorFromNetwork(message?: string): void
}

const sockets: FakeSocket[] = []

class FakeWebSocket {
  url: string
  sent: string[] = []
  closed = false
  closeCode?: number
  onopen?: () => void
  onclose?: (ev: { code?: number; reason?: string }) => void
  onerror?: (ev: { message?: string; error?: unknown }) => void
  onmessage?: (ev: { data: string }) => void

  constructor(url: string) {
    this.url = url
    sockets.push(this as unknown as FakeSocket)
  }

  send(data: string): void {
    if (this.closed) throw new Error('socket closed')
    this.sent.push(data)
  }

  close(code = 1000): void {
    if (this.closed) return
    this.closed = true
    this.closeCode = code
    queueMicrotask(() => this.onclose?.({ code, reason: '' }))
  }

  // Test helpers (not part of WS API)
  open() {
    queueMicrotask(() => this.onopen?.())
  }
  receive(payload: unknown) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
    queueMicrotask(() => this.onmessage?.({ data }))
  }
  closeFromServer(code = 1006) {
    this.closed = true
    this.closeCode = code
    queueMicrotask(() => this.onclose?.({ code, reason: 'server' }))
  }
  errorFromNetwork(message = 'network error') {
    queueMicrotask(() => this.onerror?.({ message }))
  }
}

// Drain microtasks/timers between assertions
async function flush(ms = 0): Promise<void> {
  await new Promise(r => setTimeout(r, ms))
}

let originalWs: typeof globalThis.WebSocket | undefined

beforeEach(() => {
  sockets.length = 0
  originalWs = globalThis.WebSocket as typeof globalThis.WebSocket | undefined
  // @ts-expect-error -- override for tests
  globalThis.WebSocket = FakeWebSocket
})

afterEach(() => {
  if (originalWs) {
    globalThis.WebSocket = originalWs
  }
})

function lastSocket(): FakeSocket {
  const s = sockets[sockets.length - 1]
  if (!s) throw new Error('no socket created')
  return s
}

function parseSent(s: FakeSocket): Array<Record<string, unknown>> {
  return s.sent.map(raw => JSON.parse(raw) as Record<string, unknown>)
}

function makeBoot(conversationId: string): AgentHostBoot {
  return {
    type: 'agent_host_boot',
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    conversationId,
    project: 'opencode://test',
    capabilities: ['headless'],
    claudeArgs: [],
    agentHostType: 'opencode',
    startedAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------

describe('host-transport: connection + initial message', () => {
  it('opens a WS to brokerUrl with secret query param', async () => {
    const t = createHostTransport({
      brokerUrl: 'ws://broker:9999',
      brokerSecret: 'sekret',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
    })
    expect(sockets).toHaveLength(1)
    expect(lastSocket().url).toBe('ws://broker:9999?secret=sekret')
    t.close()
  })

  it('appends &secret= when broker URL already has a query string', () => {
    createHostTransport({
      brokerUrl: 'ws://broker:9999/?foo=bar',
      brokerSecret: 'sekret',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
    })
    expect(lastSocket().url).toBe('ws://broker:9999/?foo=bar&secret=sekret')
  })

  it('sends the initial message on open', async () => {
    const onConnected = mock(() => {})
    createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      onConnected,
    })
    lastSocket().open()
    await flush()
    expect(onConnected).toHaveBeenCalledTimes(1)
    const sent = parseSent(lastSocket())
    expect(sent[0]).toMatchObject({
      type: 'agent_host_boot',
      conversationId: 'conv-1',
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    })
  })

  it('aborts and surfaces error if buildInitialMessage throws', () => {
    const onError = mock((_err: Error) => {})
    createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => {
        throw new Error('bad config')
      },
      onError,
    })
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('bad config')
  })
})

describe('host-transport: outbound queue', () => {
  it('queues messages sent before connect, flushes them on open', async () => {
    const t = createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
    })
    t.send({ type: 'heartbeat', conversationId: 'conv-1', timestamp: 1 })
    t.send({ type: 'heartbeat', conversationId: 'conv-1', timestamp: 2 })
    expect(lastSocket().sent).toHaveLength(0)
    lastSocket().open()
    await flush()
    const sent = parseSent(lastSocket())
    // [0] is the initial message, [1] and [2] are the queued heartbeats
    expect(sent.map(m => m.timestamp).filter(Boolean)).toEqual([1, 2])
  })

  it('drops oldest messages when queue is full', async () => {
    const onDiag = mock((_kind: string, _msg: string, _args?: unknown) => {})
    const t = createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      queueSize: 3,
      onDiag,
    })
    for (let i = 0; i < 10; i++) {
      t.send({ type: 'heartbeat', conversationId: 'conv-1', timestamp: i })
    }
    expect(onDiag).toHaveBeenCalled()
    lastSocket().open()
    await flush()
    const sent = parseSent(lastSocket())
    // Initial message + 3 newest heartbeats (timestamps 7, 8, 9)
    expect(sent.filter(m => m.type === 'heartbeat').map(m => m.timestamp)).toEqual([7, 8, 9])
  })
})

describe('host-transport: transcript ring buffer', () => {
  it('replays recent transcript_entries on reconnect', async () => {
    const userEntry: TranscriptUserEntry = {
      type: 'user',
      uuid: 'u-1',
      timestamp: '2026-05-10T00:00:00Z',
      message: { role: 'user', content: 'hi' },
    }
    const t = createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      transcriptRingSize: 5,
      // Tiny reconnect cap so the test stays fast
      reconnect: { maxAttempts: 5, capMs: 30 },
    })
    const sock1 = lastSocket()
    sock1.open()
    await flush()
    t.sendTranscriptEntries([userEntry], false)
    expect(parseSent(sock1).filter(m => m.type === 'transcript_entries')).toHaveLength(1)

    // Server drops the connection; transport reconnects (after exponential
    // backoff capped at 30ms), replays ring on the new socket.
    sock1.closeFromServer()
    await flush(80)
    expect(sockets.length).toBeGreaterThanOrEqual(2)
    const sock2 = lastSocket()
    sock2.open()
    await flush()
    const sent2 = parseSent(sock2)
    // sock2 receives: initial boot + replayed transcript_entries
    expect(sent2[0]?.type).toBe('agent_host_boot')
    expect(
      sent2.some(m => m.type === 'transcript_entries' && (m.entries as Array<{ uuid: string }>)[0]?.uuid === 'u-1'),
    ).toBe(true)
    t.close()
  })
})

describe('host-transport: heartbeat', () => {
  it('emits a heartbeat on the configured interval', async () => {
    const t = createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      heartbeatIntervalMs: 30,
    })
    lastSocket().open()
    await flush()
    const before = lastSocket().sent.length
    await flush(110)
    const hbs = parseSent(lastSocket()).filter(m => m.type === 'heartbeat')
    // At 30ms interval over ~110ms we expect at least 2 heartbeats
    expect(hbs.length).toBeGreaterThanOrEqual(2)
    expect(lastSocket().sent.length).toBeGreaterThan(before)
    t.close()
  })

  it('stops heartbeat on close', async () => {
    const t = createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      heartbeatIntervalMs: 20,
    })
    lastSocket().open()
    await flush()
    t.close()
    const before = lastSocket().sent.length
    await flush(80)
    expect(lastSocket().sent.length).toBe(before) // no new sends
  })
})

describe('host-transport: setSessionId', () => {
  it('sends conversation_promote exactly once for a new id', async () => {
    const t = createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
    })
    lastSocket().open()
    await flush()
    t.setSessionId('ses_abc', 'stream_json')
    t.setSessionId('ses_abc', 'stream_json') // duplicate, must be ignored
    await flush()
    const promotes = parseSent(lastSocket()).filter(m => m.type === 'conversation_promote')
    expect(promotes).toHaveLength(1)
    expect(promotes[0]).toMatchObject({ ccSessionId: 'ses_abc', source: 'stream_json' })
  })

  it('re-promotes when the session id changes', async () => {
    const t = createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
    })
    lastSocket().open()
    await flush()
    t.setSessionId('ses_a', 'stream_json')
    t.setSessionId('ses_b', 'stream_json')
    await flush()
    const promotes = parseSent(lastSocket()).filter(m => m.type === 'conversation_promote')
    expect(promotes).toHaveLength(2)
    expect(promotes[1]).toMatchObject({ ccSessionId: 'ses_b' })
  })
})

describe('host-transport: inbound dispatch', () => {
  it('forwards non-upgrade messages to onMessage', async () => {
    const onMessage = mock((_msg: unknown) => {})
    createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      onMessage,
    })
    lastSocket().open()
    await flush()
    lastSocket().receive({ type: 'input', conversationId: 'conv-1', input: 'hello' })
    await flush()
    expect(onMessage).toHaveBeenCalled()
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ type: 'input', input: 'hello' })
  })

  it('handles malformed JSON without throwing', async () => {
    const onMessage = mock((_msg: unknown) => {})
    const onDiag = mock((_kind: string, _msg: string, _args?: unknown) => {})
    createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      onMessage,
      onDiag,
    })
    lastSocket().open()
    await flush()
    lastSocket().receive('not valid json')
    await flush()
    expect(onMessage).not.toHaveBeenCalled()
    expect(onDiag).toHaveBeenCalled()
  })

  it('catches throws inside onMessage and reports via onDiag', async () => {
    const onDiag = mock((_kind: string, _msg: string, _args?: unknown) => {})
    createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      onMessage: () => {
        throw new Error('bad handler')
      },
      onDiag,
    })
    lastSocket().open()
    await flush()
    lastSocket().receive({ type: 'input', input: 'x' })
    await flush()
    expect(onDiag).toHaveBeenCalled()
    const args = onDiag.mock.calls.find(c => /threw/.test(c[1] as string))
    expect(args).toBeTruthy()
  })
})

describe('host-transport: protocol_upgrade_required', () => {
  it('with onProtocolUpgradeRequired=throw -- surfaces error and stops reconnecting', async () => {
    const onError = mock((_err: Error) => {})
    createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      onError,
      onProtocolUpgradeRequired: 'throw',
      reconnect: { maxAttempts: 3, capMs: 20 },
    })
    lastSocket().open()
    await flush()
    lastSocket().receive({ type: 'protocol_upgrade_required', reason: 'too old' })
    await flush()
    expect(onError).toHaveBeenCalled()
    expect((onError.mock.calls[0]?.[0] as Error).message).toContain('too old')
    // Closing should NOT trigger a reconnect.
    const before = sockets.length
    lastSocket().closeFromServer()
    await flush(150)
    expect(sockets.length).toBe(before)
  })

  it('custom callback is invoked instead of exit/throw', async () => {
    const cb = mock((_msg: unknown) => {})
    createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      onProtocolUpgradeRequired: cb,
    })
    lastSocket().open()
    await flush()
    lastSocket().receive({ type: 'protocol_upgrade_required', reason: 'x' })
    await flush()
    expect(cb).toHaveBeenCalled()
  })
})

describe('host-transport: reconnect backoff', () => {
  it('reconnects with exponential backoff capped by capMs', async () => {
    const t = createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      // Cap at 20ms so the test stays fast. Backoff sequence (with cap=20):
      // attempt 1 -> 1000*2^1=2000 capped to 20, attempt 2 -> 4000 capped to 20.
      reconnect: { maxAttempts: 5, capMs: 20 },
    })
    lastSocket().open()
    await flush()

    lastSocket().closeFromServer()
    // Wait a bit longer than capMs for the reconnect to fire.
    await flush(60)
    expect(sockets.length).toBeGreaterThanOrEqual(2)

    lastSocket().closeFromServer()
    await flush(60)
    expect(sockets.length).toBeGreaterThanOrEqual(3)

    t.close()
  })

  it('gives up after maxAttempts and reports via onError', async () => {
    const onError = mock((_err: Error) => {})
    createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      reconnect: { maxAttempts: 2, capMs: 15 },
      onError,
    })
    lastSocket().open()
    await flush()

    // Drop connection repeatedly, each time the transport reconnects until it
    // hits maxAttempts and gives up.
    for (let i = 0; i < 4; i++) {
      lastSocket().closeFromServer()
      await flush(40)
    }
    expect(onError.mock.calls.some(c => /gave up/.test((c[0] as Error).message))).toBe(true)
  })
})

describe('host-transport: isConnected + flush', () => {
  it('isConnected reflects the open/close lifecycle', async () => {
    const t: HostTransport = createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
    })
    expect(t.isConnected()).toBe(false)
    lastSocket().open()
    await flush()
    expect(t.isConnected()).toBe(true)
    t.close()
    await flush()
    expect(t.isConnected()).toBe(false)
  })

  it('flush() is a no-op while disconnected', () => {
    const t = createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
    })
    t.send({ type: 'heartbeat', conversationId: 'conv-1', timestamp: 1 })
    t.flush()
    expect(lastSocket().sent).toHaveLength(0)
  })
})
