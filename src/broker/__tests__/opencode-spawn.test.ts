/**
 * Tests for the OpenCode backend spawn path.
 *
 * Slug derivation is exercised in isolation; the full sentinel round-trip
 * (broker -> sentinel -> opencode-host -> broker) is exercised by the
 * staging integration test, not here.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { _internal as opencodeInternal } from '../backends/opencode'
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

describe('OpenCode backend slug derivation', () => {
  it('slugifies provider/model into a stable project URI bucket', () => {
    expect(
      opencodeInternal.deriveOpenCodeSlug({
        cwd: '~',
        model: 'openrouter/anthropic/claude-haiku-4.5',
      } as SpawnRequest),
    ).toBe('openrouter-claude-haiku-4-5')
  })

  it('falls back to "default" when no model is set', () => {
    expect(opencodeInternal.deriveOpenCodeSlug({ cwd: '~' } as SpawnRequest)).toBe('default')
  })

  it('handles plain model names without provider prefix', () => {
    expect(opencodeInternal.deriveOpenCodeSlug({ cwd: '~', model: 'claude-haiku-4-5' } as SpawnRequest)).toBe(
      'claude-haiku-4-5',
    )
  })

  it('prefers openCodeModel over model when both set', () => {
    expect(
      opencodeInternal.deriveOpenCodeSlug({
        cwd: '~',
        model: 'claude-haiku-4-5',
        openCodeModel: 'openrouter/openai/gpt-oss-20b:free',
      } as SpawnRequest),
    ).toBe('openrouter-gpt-oss-20b-free')
  })
})

describe('OpenCode spawn -- registry-driven dispatch', () => {
  it('rejects spawns when no sentinel is connected', async () => {
    const req: SpawnRequest = {
      cwd: '/tmp/test',
      backend: 'opencode',
      openCodeModel: 'openrouter/openai/gpt-oss-20b:free',
    }
    const result = await dispatchSpawn(req, deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('No sentinel')
    expect(result.statusCode).toBe(503)
  })

  it('rejects unknown backend names with a 400', async () => {
    const req = {
      cwd: '/tmp/test',
      backend: 'totally-not-a-real-backend',
    } as unknown as SpawnRequest
    const result = await dispatchSpawn(req, deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Unknown backend')
    expect(result.statusCode).toBe(400)
  })
})
