/**
 * Unit tests for the shared host-transport primitive.
 *
 * Strategy: stub `WebSocket` globally with an in-memory class we control. The
 * transport sees a real WebSocket-shaped object; we drive its lifecycle by
 * calling fake.onopen / onmessage / onclose from the test.
 *
 * Covers the parts the transport owns: queueing, ring buffer replay,
 * heartbeat, reconnect backoff, conversation_promote dispatch, and
 * protocol_upgrade_required handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

beforeEach(() => {
  sockets.length = 0
  // @ts-expect-error -- override for tests
  globalThis.WebSocket = FakeWebSocket
})

afterEach(() => {
  vi.restoreAllMocks()
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
    const onConnected = vi.fn()
    createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      onConnected,
    })
    lastSocket().open()
    await flush()
    expect(onConnected).toHaveBeenCalledOnce()
    const sent = parseSent(lastSocket())
    expect(sent[0]).toMatchObject({
      type: 'agent_host_boot',
      conversationId: 'conv-1',
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    })
  })

  it('aborts and surfaces error if buildInitialMessage throws', () => {
    const onError = vi.fn()
    createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => {
        throw new Error('bad config')
      },
      onError,
    })
    expect(onError).toHaveBeenCalledOnce()
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
    const onDiag = vi.fn()
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
    vi.useFakeTimers()
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
    })
    const sock1 = lastSocket()
    sock1.open()
    await vi.advanceTimersByTimeAsync(0)
    t.sendTranscriptEntries([userEntry], false)
    expect(parseSent(sock1).filter(m => m.type === 'transcript_entries')).toHaveLength(1)

    // Server drops the connection; transport reconnects, replays ring.
    sock1.closeFromServer()
    await vi.advanceTimersByTimeAsync(2000)
    expect(sockets).toHaveLength(2)
    const sock2 = lastSocket()
    sock2.open()
    await vi.advanceTimersByTimeAsync(0)
    const sent2 = parseSent(sock2)
    // sock2 receives: initial boot + replayed transcript_entries
    expect(sent2[0]?.type).toBe('agent_host_boot')
    expect(
      sent2.some(m => m.type === 'transcript_entries' && (m.entries as Array<{ uuid: string }>)[0]?.uuid === 'u-1'),
    ).toBe(true)
    t.close()
    vi.useRealTimers()
  })
})

describe('host-transport: heartbeat', () => {
  it('emits a heartbeat on the configured interval', async () => {
    vi.useFakeTimers()
    createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      heartbeatIntervalMs: 1000,
    })
    lastSocket().open()
    await vi.advanceTimersByTimeAsync(0)
    const before = lastSocket().sent.length
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    const after = lastSocket().sent.length
    expect(after - before).toBe(2)
    const hbs = parseSent(lastSocket()).filter(m => m.type === 'heartbeat')
    expect(hbs.length).toBeGreaterThanOrEqual(2)
    vi.useRealTimers()
  })

  it('stops heartbeat on close', async () => {
    vi.useFakeTimers()
    const t = createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      heartbeatIntervalMs: 500,
    })
    lastSocket().open()
    await vi.advanceTimersByTimeAsync(0)
    t.close()
    const before = lastSocket().sent.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(lastSocket().sent.length).toBe(before) // no new sends
    vi.useRealTimers()
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
    const promotes = parseSent(lastSocket()).filter(m => m.type === 'conversation_promote')
    expect(promotes).toHaveLength(2)
    expect(promotes[1]).toMatchObject({ ccSessionId: 'ses_b' })
  })
})

describe('host-transport: inbound dispatch', () => {
  it('forwards non-upgrade messages to onMessage', async () => {
    const onMessage = vi.fn()
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
    const onMessage = vi.fn()
    const onDiag = vi.fn()
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
    const onDiag = vi.fn()
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
    const args = onDiag.mock.calls.find(c => /threw/.test(c[1]))
    expect(args).toBeTruthy()
  })
})

describe('host-transport: protocol_upgrade_required', () => {
  it('with onProtocolUpgradeRequired=throw -- surfaces error and stops reconnecting', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      onError,
      onProtocolUpgradeRequired: 'throw',
    })
    lastSocket().open()
    await vi.advanceTimersByTimeAsync(0)
    lastSocket().receive({ type: 'protocol_upgrade_required', reason: 'too old' })
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).toHaveBeenCalled()
    expect((onError.mock.calls[0]?.[0] as Error).message).toContain('too old')
    // Closing should NOT trigger a reconnect.
    lastSocket().closeFromServer()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sockets).toHaveLength(1)
    vi.useRealTimers()
  })

  it('custom callback is invoked instead of exit/throw', async () => {
    const cb = vi.fn()
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
    vi.useFakeTimers()
    const t = createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      reconnect: { maxAttempts: 5, capMs: 4000 },
    })
    lastSocket().open()
    await vi.advanceTimersByTimeAsync(0)

    lastSocket().closeFromServer()
    // First retry at 2^1=2000ms
    await vi.advanceTimersByTimeAsync(2000)
    expect(sockets).toHaveLength(2)

    lastSocket().closeFromServer()
    // Second retry at 2^2=4000ms (capped)
    await vi.advanceTimersByTimeAsync(4000)
    expect(sockets).toHaveLength(3)

    t.close()
    vi.useRealTimers()
  })

  it('gives up after maxAttempts and reports via onError', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    createHostTransport({
      brokerUrl: 'ws://b:1',
      conversationId: 'conv-1',
      buildInitialMessage: () => makeBoot('conv-1'),
      reconnect: { maxAttempts: 2, capMs: 1000 },
      onError,
    })
    lastSocket().open()
    await vi.advanceTimersByTimeAsync(0)

    // Drop and let it retry up to the limit
    for (let i = 0; i < 4; i++) {
      lastSocket().closeFromServer()
      await vi.advanceTimersByTimeAsync(2000)
    }
    expect(onError.mock.calls.some(c => /gave up/.test((c[0] as Error).message))).toBe(true)
    vi.useRealTimers()
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
