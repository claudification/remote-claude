/**
 * Tests for Chat API spawn bypass in dispatchSpawn
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { type ConversationStore, createConversationStore } from '../conversation-store'
import { dispatchSpawn, type SpawnDispatchDeps } from '../spawn-dispatch'
import { createMemoryDriver } from '../store/memory/driver'
import type { StoreDriver } from '../store/types'

let conversationStore: ConversationStore
let store: StoreDriver
let deps: SpawnDispatchDeps

function makeDeps(overrides: Partial<SpawnDispatchDeps> = {}): SpawnDispatchDeps {
  return {
    conversationStore,
    getProjectSettings: () => null,
    getGlobalSettings: () => ({}) as ReturnType<SpawnDispatchDeps['getGlobalSettings']>,
    callerContext: {
      kind: 'http',
      hasSpawnPermission: true,
      trustLevel: 'trusted',
      callerProject: null,
    },
    ...overrides,
  }
}

beforeEach(() => {
  store = createMemoryDriver()
  store.init()
  conversationStore = createConversationStore({ store, enablePersistence: false })
  deps = makeDeps()
})

describe('Chat API spawn bypass', () => {
  it('creates conversation immediately without sentinel', async () => {
    const req: SpawnRequest = {
      cwd: '~',
      backend: 'chat-api',
      chatConnectionId: 'conn-123',
      chatConnectionName: 'Personal',
    }

    const result = await dispatchSpawn(req, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.conversationId).toBeTruthy()
    expect(result.jobId).toBeTruthy()

    const conv = conversationStore.getConversation(result.conversationId)
    expect(conv).toBeDefined()
    expect(conv?.status).toBe('active')
    expect(conv?.agentHostType).toBe('chat-api')
    expect(conv?.agentHostMeta?.chatConnectionId).toBe('conn-123')
    expect(conv?.agentHostMeta?.backend).toBe('chat-api')
  })

  it('uses chat://{connectionName} as project URI', async () => {
    const req: SpawnRequest = {
      cwd: '~',
      backend: 'chat-api',
      chatConnectionId: 'conn-123',
      chatConnectionName: 'Work',
    }

    const result = await dispatchSpawn(req, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const conv = conversationStore.getConversation(result.conversationId)
    expect(conv?.project).toBe('chat://Work')
  })

  it('defaults project to chat://default when no connection name', async () => {
    const req: SpawnRequest = {
      cwd: '~',
      backend: 'chat-api',
      chatConnectionId: 'conn-123',
    }

    const result = await dispatchSpawn(req, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const conv = conversationStore.getConversation(result.conversationId)
    expect(conv?.project).toBe('chat://default')
  })

  it('fails when chatConnectionId is missing', async () => {
    const req: SpawnRequest = {
      cwd: '~',
      backend: 'chat-api',
    }

    const result = await dispatchSpawn(req, deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('chatConnectionId')
    expect(result.statusCode).toBe(400)
  })

  it('uses provided name as conversation title', async () => {
    const req: SpawnRequest = {
      cwd: '~',
      backend: 'chat-api',
      chatConnectionId: 'conn-123',
      chatConnectionName: 'Personal',
      name: 'Morning Briefing',
    }

    const result = await dispatchSpawn(req, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const conv = conversationStore.getConversation(result.conversationId)
    expect(conv?.title).toBe('Morning Briefing')
  })

  it('uses caller-supplied jobId when provided', async () => {
    const jobId = '11111111-2222-3333-4444-555555555555'
    const req: SpawnRequest = {
      cwd: '~',
      backend: 'chat-api',
      chatConnectionId: 'conn-123',
      chatConnectionName: 'Personal',
      jobId,
    }

    const result = await dispatchSpawn(req, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.jobId).toBe(jobId)
  })

  it('does not require a sentinel connection', async () => {
    // No sentinel set up at all -- should still work for Chat API
    expect(conversationStore.hasSentinel()).toBe(false)

    const req: SpawnRequest = {
      cwd: '~',
      backend: 'chat-api',
      chatConnectionId: 'conn-123',
      chatConnectionName: 'Personal',
    }

    const result = await dispatchSpawn(req, deps)
    expect(result.ok).toBe(true)
  })
})

describe('Non-Chat API spawn still requires sentinel', () => {
  it('fails without sentinel for claude backend', async () => {
    const req: SpawnRequest = {
      cwd: '/tmp/test',
    }

    const result = await dispatchSpawn(req, deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('No sentinel')
  })
})
