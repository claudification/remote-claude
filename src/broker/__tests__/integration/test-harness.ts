/**
 * Integration test harness for wire protocol testing.
 *
 * Simulates the broker's WebSocket message routing without starting a real
 * Bun.serve. Uses the actual handler infrastructure, conversation store,
 * and message router -- only the transport layer is mocked.
 *
 * This gives us full coverage of handler logic, state transitions, and
 * broadcast behavior while running under vitest (Node runtime).
 */

import type { ServerWebSocket } from 'bun'
import type { ConversationStore } from '../../conversation-store'
import { createConversationStore } from '../../conversation-store'
import { type ContextDeps, createContext } from '../../create-context'
import type { WsData } from '../../handler-context'
import { registerAllHandlers } from '../../handlers'
import { routeMessage } from '../../message-router'
import type { StoreDriver } from '../../store/types'

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

export interface MockWs {
  ws: ServerWebSocket<WsData>
  sent: Array<Record<string, unknown>>
  lastMessage(): Record<string, unknown> | undefined
  messagesOfType(type: string): Array<Record<string, unknown>>
  clearMessages(): void
  closed: boolean
  closeCode?: number
  closeReason?: string
}

let mockIdCounter = 0

export function createMockWs(data: Partial<WsData> = {}): MockWs {
  const sent: Array<Record<string, unknown>> = []
  const id = `mock-${++mockIdCounter}`
  let closed = false
  let closeCode: number | undefined
  let closeReason: string | undefined

  const ws = {
    _id: id,
    data: { ...data } as WsData,
    send(msg: string | Buffer) {
      const str = typeof msg === 'string' ? msg : msg.toString()
      try {
        sent.push(JSON.parse(str))
      } catch {
        sent.push({ _raw: str })
      }
      return 0
    },
    close(code?: number, reason?: string) {
      closed = true
      closeCode = code
      closeReason = reason
    },
    subscribe: () => {},
    unsubscribe: () => {},
    publish: () => false,
    terminate: () => {
      closed = true
    },
    ping: () => {},
    pong: () => {},
    readyState: 1,
    remoteAddress: '127.0.0.1',
    binaryType: 'nodebuffer' as const,
    bufferedAmount: 0,
  } as unknown as ServerWebSocket<WsData>

  return {
    ws,
    sent,
    lastMessage() {
      return sent[sent.length - 1]
    },
    messagesOfType(type: string) {
      return sent.filter(m => m.type === type)
    },
    clearMessages() {
      sent.length = 0
    },
    get closed() {
      return closed
    },
    get closeCode() {
      return closeCode
    },
    get closeReason() {
      return closeReason
    },
  }
}

// ---------------------------------------------------------------------------
// Minimal mock StoreDriver (no bun:sqlite dependency)
// ---------------------------------------------------------------------------

function createMockStoreDriver(): StoreDriver {
  const noop = () => {}
  const noopStore = {
    get: () => null,
    create: () => ({}) as never,
    update: noop,
    delete: () => false,
    list: () => [],
    listByScope: () => [],
    updateStats: noop,
  }
  const noopKv = {
    get: () => null,
    set: noop,
    delete: () => false,
    keys: () => [],
  }
  const noopCosts = {
    recordTurn: noop,
    recordTurnFromCumulatives: () => false,
    queryTurns: () => ({ rows: [], total: 0 }),
    queryHourly: () => [],
    querySummary: () => ({
      period: '24h',
      totalCostUsd: 0,
      totalTurns: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      topProjects: [],
      topModels: [],
    }),
    pruneOlderThan: () => ({ turns: 0, hourly: 0 }),
  }
  return {
    sessions: noopStore,
    transcripts: {
      append: noop,
      getPage: () => ({ entries: [], nextCursor: null, prevCursor: null, totalCount: 0 }),
      getLatest: () => [],
      getSinceSeq: () => ({ entries: [], lastSeq: 0, gap: false }),
      getLastSeq: () => 0,
      find: () => [],
      search: () => [],
      count: () => 0,
      pruneOlderThan: () => 0,
    },
    events: {
      append: noop,
      getForConversation: () => [],
      pruneOlderThan: () => 0,
    },
    kv: noopKv,
    messages: {
      enqueue: noop,
      dequeueFor: () => [],
      log: noop,
      queryLog: () => [],
      pruneExpired: () => 0,
    },
    shares: {
      create: () => ({}) as never,
      get: () => null,
      getForConversation: () => [],
      incrementViewerCount: noop,
      delete: () => false,
      deleteExpired: () => 0,
    },
    addressBook: {
      resolve: () => null,
      set: noop,
      delete: () => false,
      listForScope: () => [],
      findByTarget: () => [],
    },
    scopeLinks: {
      link: noop,
      unlink: noop,
      getStatus: () => null,
      setStatus: noop,
      listLinksFor: () => [],
    },
    tasks: {
      upsert: noop,
      getForConversation: () => [],
      delete: () => false,
      deleteForConversation: () => 0,
    },
    costs: noopCosts,
    init: noop,
    close: noop,
    compact: noop,
  } as StoreDriver
}

// ---------------------------------------------------------------------------
// Test Harness
// ---------------------------------------------------------------------------

export interface TestHarness {
  conversationStore: ConversationStore
  store: StoreDriver

  /** Simulate an agent host sending a message to the broker */
  agentSend(mockWs: MockWs, message: Record<string, unknown>): void

  /** Simulate a dashboard sending a message to the broker */
  dashboardSend(mockWs: MockWs, message: Record<string, unknown>): void

  /** Create a mock WS pre-configured as an agent host connection */
  createAgentHostWs(data?: Partial<WsData>): MockWs

  /** Create a mock WS pre-configured as a dashboard connection */
  createDashboardWs(data?: Partial<WsData>): MockWs

  /**
   * Connect a dashboard subscriber. Sends the 'subscribe' message and
   * registers it with the conversation store. Returns the mock WS.
   */
  connectDashboard(data?: Partial<WsData>): MockWs

  /**
   * Simulate an agent host boot sequence. Sends wrapper_boot and returns
   * the mock WS. Optionally sends meta to promote the session.
   */
  bootAgentHost(opts: {
    conversationId: string
    project: string
    ccSessionId?: string
    capabilities?: string[]
  }): MockWs

  /** Flush coalesced microtask broadcasts (session_update) */
  flushUpdates(): Promise<void>

  /** Cleanup all state */
  cleanup(): void
}

export function createTestHarness(): TestHarness {
  // Register all message handlers (idempotent -- handlers map is global)
  registerAllHandlers()

  const store = createMockStoreDriver()

  const conversationStore = createConversationStore({
    enablePersistence: false,
  })

  const contextDeps: ContextDeps = {
    conversations: conversationStore,
    store,
    verbose: false,
    origins: ['http://localhost:0'],
    getProjectSettings: () => null,
    setProjectSettings: () => {},
    getAllProjectSettings: () => ({}),
    pushConfigured: false,
    pushSendToAll: () => {},
    getLinksForProject: () => [],
    findLink: () => false,
    addLink: () => {},
    removeLink: () => {},
    touchLink: () => {},
    logMessage: () => {},
    addressBook: {
      getOrAssign: (_caller, _target, name) => name,
      resolve: () => undefined,
    },
    messageQueue: {
      enqueue: () => {},
      drain: () => [],
      getQueueSize: () => 0,
    },
  }

  function routeToHandlers(ws: ServerWebSocket<WsData>, message: Record<string, unknown>): void {
    const ctx = createContext(ws, contextDeps)
    const type = message.type as string
    if (!routeMessage(ctx, type, message)) {
      throw new Error(`No handler registered for message type: ${type}`)
    }
  }

  function agentSend(mockWs: MockWs, message: Record<string, unknown>): void {
    routeToHandlers(mockWs.ws, message)
  }

  function dashboardSend(mockWs: MockWs, message: Record<string, unknown>): void {
    routeToHandlers(mockWs.ws, message)
  }

  function createAgentHostWs(data: Partial<WsData> = {}): MockWs {
    return createMockWs(data)
  }

  function createDashboardWs(data: Partial<WsData> = {}): MockWs {
    return createMockWs({ isControlPanel: true, ...data })
  }

  function connectDashboard(data: Partial<WsData> = {}): MockWs {
    const mock = createDashboardWs(data)
    dashboardSend(mock, { type: 'subscribe', protocolVersion: 2 })
    return mock
  }

  function bootAgentHost(opts: {
    conversationId: string
    project: string
    ccSessionId?: string
    capabilities?: string[]
  }): MockWs {
    const mock = createAgentHostWs()

    agentSend(mock, {
      type: 'wrapper_boot',
      conversationId: opts.conversationId,
      project: opts.project,
      capabilities: opts.capabilities || [],
      claudeArgs: [],
      startedAt: Date.now(),
    })

    return mock
  }

  async function flushUpdates(): Promise<void> {
    // queueMicrotask-based coalescing needs a microtask flush
    await new Promise<void>(resolve => {
      queueMicrotask(() => queueMicrotask(resolve))
    })
  }

  function cleanup(): void {
    store.close()
  }

  return {
    conversationStore,
    store,
    agentSend,
    dashboardSend,
    createAgentHostWs,
    createDashboardWs,
    connectDashboard,
    bootAgentHost,
    flushUpdates,
    cleanup,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for messages of a specific type to appear in a mock WS's sent buffer */
export async function waitForMessage(mock: MockWs, type: string, timeoutMs = 500): Promise<Record<string, unknown>> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const msgs = mock.messagesOfType(type)
    if (msgs.length > 0) return msgs[msgs.length - 1]
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`Timed out waiting for message type: ${type} (got: ${mock.sent.map(m => m.type).join(', ')})`)
}

/** Generate a unique ID for test isolation */
export function testId(prefix = 'test'): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`
}
