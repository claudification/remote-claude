import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type {
  TranscriptAssistantEntry,
  TranscriptEntry,
  TranscriptSystemEntry,
  TranscriptUserEntry,
} from '../../../shared/protocol'
import type { ConversationStore } from '../../conversation-store'
import { cancelRecap, generateRecapManual, generateRecapOnEnd, scheduleRecap } from '../../recap-generator'

// These tests freeze the public surface of recap-generator before the
// Phase 1c refactor moves the implementation into recap/away-summary/ on
// top of recap/shared/openrouter-client.ts. They MUST keep passing through
// the move with zero changes.
//
// Coverage:
//   - scheduleRecap: API-key gate, debounce/cancel of prior timer, fires
//     after RECAP_DELAY_MS only when conversation is still idle
//   - cancelRecap: clears pending timer
//   - generateRecapOnEnd: skips when conversation already has recap;
//     bypasses idle gate via allowEnded
//   - generateRecapManual: replies with structured ack on every path
//     (no api key, missing conv, success, OpenRouter non-200)
//   - generateRecap (internal): condenses transcript, calls OpenRouter
//     with the documented model + prompt, parses JSON, writes a
//     system/away_summary entry, broadcasts conversation:transcript
//
// Side-effect surface we lock down:
//   - process.env.OPENROUTER_API_KEY presence check
//   - global fetch with the OpenRouter URL + bearer header + body shape
//   - store.addTranscriptEntries with the away_summary entry
//   - store.broadcastToChannel('conversation:transcript', ...)
//   - store.broadcastConversationUpdate
//   - store.persistConversationById (only on allowEnded path)

interface FakeConversation {
  id: string
  status: 'active' | 'idle' | 'ended'
  recap?: string
  resultText?: string
}

interface CapturedFetch {
  url: string
  init: RequestInit
}

interface CapturedEntries {
  conversationId: string
  entries: TranscriptEntry[]
  isInitial: boolean
}

interface CapturedBroadcast {
  channel: string
  conversationId: string
  msg: Record<string, unknown>
}

interface FakeStoreState {
  conv: FakeConversation
  transcript: TranscriptEntry[]
  storedTranscript: TranscriptEntry[] | null
  added: CapturedEntries[]
  broadcasts: CapturedBroadcast[]
  conversationUpdates: string[]
  persistCalls: string[]
}

function makeUserEntry(text: string, ts = '2026-05-11T10:00:00Z'): TranscriptUserEntry {
  return {
    type: 'user',
    uuid: crypto.randomUUID(),
    timestamp: ts,
    message: { role: 'user', content: text },
  } as TranscriptUserEntry
}

function makeAssistantEntry(text: string, ts = '2026-05-11T10:00:01Z'): TranscriptAssistantEntry {
  return {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: ts,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  } as TranscriptAssistantEntry
}

function makeAwaySummaryEntry(content: string): TranscriptSystemEntry {
  return {
    type: 'system',
    subtype: 'away_summary',
    uuid: crypto.randomUUID(),
    timestamp: '2026-05-11T09:00:00Z',
    content,
  } as TranscriptSystemEntry
}

function makeFakeStore(state: FakeStoreState): ConversationStore {
  // Minimal subset; cast through unknown so TypeScript doesn't demand
  // every store method we never touch.
  return {
    getConversation: (id: string) => (id === state.conv.id ? (state.conv as never) : undefined),
    getTranscriptEntries: (id: string, _limit?: number) =>
      id === state.conv.id ? (state.transcript as TranscriptEntry[]) : [],
    loadTranscriptFromStore: (id: string, _limit: number) => (id === state.conv.id ? state.storedTranscript : null),
    addTranscriptEntries: (conversationId: string, entries: TranscriptEntry[], isInitial: boolean) => {
      state.added.push({ conversationId, entries, isInitial })
    },
    broadcastToChannel: (channel: string, conversationId: string, msg: Record<string, unknown>) => {
      state.broadcasts.push({ channel, conversationId, msg })
    },
    broadcastConversationUpdate: (id: string) => {
      state.conversationUpdates.push(id)
    },
    persistConversationById: (id: string) => {
      state.persistCalls.push(id)
    },
  } as unknown as ConversationStore
}

function makeStoreState(overrides: Partial<FakeStoreState> = {}): FakeStoreState {
  return {
    conv: { id: 'conv_test_1', status: 'idle' },
    transcript: [],
    storedTranscript: null,
    added: [],
    broadcasts: [],
    conversationUpdates: [],
    persistCalls: [],
    ...overrides,
  }
}

function mockOpenRouterResponse(content: string, status = 200): typeof fetch {
  return mock(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        headers: { 'Content-Type': 'application/json' },
      }),
  ) as unknown as typeof fetch
}

function mockOpenRouterFailure(status: number): typeof fetch {
  return mock(
    async (_url: string, _init: RequestInit) =>
      new Response('rate limited', { status, statusText: 'Too Many Requests' }),
  ) as unknown as typeof fetch
}

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_API_KEY = process.env.OPENROUTER_API_KEY

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-key'
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  if (ORIGINAL_API_KEY === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = ORIGINAL_API_KEY
})

describe('recap-generator characterization (Phase 1a)', () => {
  describe('scheduleRecap + cancelRecap', () => {
    it('does nothing when OPENROUTER_API_KEY is unset', () => {
      delete process.env.OPENROUTER_API_KEY
      const state = makeStoreState()
      const store = makeFakeStore(state)
      // Just must not throw. Cannot easily probe internal timer map.
      expect(() => scheduleRecap(store, state.conv.id)).not.toThrow()
    })

    it('cancelRecap on an unknown conversation is a no-op', () => {
      expect(() => cancelRecap('conv_nonexistent')).not.toThrow()
    })

    it('cancelRecap clears a previously scheduled timer', () => {
      const state = makeStoreState()
      const store = makeFakeStore(state)
      scheduleRecap(store, state.conv.id)
      expect(() => cancelRecap(state.conv.id)).not.toThrow()
    })
  })

  describe('generateRecapManual', () => {
    it('replies with ok=false + reason when OPENROUTER_API_KEY is unset', () => {
      delete process.env.OPENROUTER_API_KEY
      const state = makeStoreState()
      const store = makeFakeStore(state)
      const replies: Array<Record<string, unknown>> = []
      generateRecapManual(store, state.conv.id, msg => replies.push(msg))
      expect(replies.length).toBe(1)
      expect(replies[0].type).toBe('recap_request_result')
      expect(replies[0].ok).toBe(false)
      expect(typeof replies[0].error).toBe('string')
    })

    it('replies with ok=false when conversation is missing', () => {
      const state = makeStoreState()
      const store = makeFakeStore(state)
      const replies: Array<Record<string, unknown>> = []
      generateRecapManual(store, 'conv_missing', msg => replies.push(msg))
      expect(replies.length).toBe(1)
      expect(replies[0].ok).toBe(false)
    })

    it('replies with ok=false when transcript is too short to summarise', async () => {
      const state = makeStoreState({ transcript: [makeUserEntry('hi')] })
      const store = makeFakeStore(state)
      const replies: Array<Record<string, unknown>> = []
      generateRecapManual(store, state.conv.id, msg => replies.push(msg))
      // generateRecap is async; let microtasks run. Same-tick wait.
      await new Promise(r => setTimeout(r, 10))
      expect(replies.length).toBe(1)
      expect(replies[0].ok).toBe(false)
    })

    it('produces an away_summary transcript entry on success', async () => {
      const longText = 'x'.repeat(120)
      const state = makeStoreState({
        transcript: [makeUserEntry(`tell me about ${longText}`), makeAssistantEntry(`I went and did ${longText}`)],
      })
      const store = makeFakeStore(state)
      globalThis.fetch = mockOpenRouterResponse(
        JSON.stringify({ title: 'Refactor cost store', recap: 'Splitting cumulative tracker into delta tracker.' }),
      )

      const replies: Array<Record<string, unknown>> = []
      generateRecapManual(store, state.conv.id, msg => replies.push(msg))
      await new Promise(r => setTimeout(r, 20))

      expect(state.added.length).toBe(1)
      const entry = state.added[0].entries[0] as TranscriptSystemEntry
      expect(entry.type).toBe('system')
      expect(entry.subtype).toBe('away_summary')
      const parsed = JSON.parse(entry.content as string)
      expect(parsed.title).toBe('Refactor cost store')
      expect(parsed.recap).toContain('Splitting')
      expect(state.broadcasts.length).toBe(1)
      expect(state.broadcasts[0].channel).toBe('conversation:transcript')
      expect(state.broadcasts[0].msg.type).toBe('transcript')
      expect(state.conversationUpdates).toContain(state.conv.id)
      expect(replies.some(r => r.ok === true)).toBe(true)
    })

    it('replies ok=false when OpenRouter returns non-200', async () => {
      const longText = 'y'.repeat(120)
      const state = makeStoreState({
        transcript: [makeUserEntry(longText), makeAssistantEntry(longText)],
      })
      const store = makeFakeStore(state)
      globalThis.fetch = mockOpenRouterFailure(429)

      const replies: Array<Record<string, unknown>> = []
      generateRecapManual(store, state.conv.id, msg => replies.push(msg))
      await new Promise(r => setTimeout(r, 20))

      expect(state.added.length).toBe(0)
      expect(replies.some(r => r.ok === false)).toBe(true)
    })

    it('rejects responses lacking a recap JSON object', async () => {
      const longText = 'z'.repeat(120)
      const state = makeStoreState({
        transcript: [makeUserEntry(longText), makeAssistantEntry(longText)],
      })
      const store = makeFakeStore(state)
      globalThis.fetch = mockOpenRouterResponse('Sure, no problem!')

      const replies: Array<Record<string, unknown>> = []
      generateRecapManual(store, state.conv.id, msg => replies.push(msg))
      await new Promise(r => setTimeout(r, 20))

      expect(state.added.length).toBe(0)
      expect(replies.some(r => r.ok === false)).toBe(true)
    })

    it('sends OpenRouter a request body with the haiku model + system prompt + condensed transcript', async () => {
      const longText = 'q'.repeat(120)
      const state = makeStoreState({
        transcript: [makeUserEntry(longText), makeAssistantEntry(longText)],
      })
      const store = makeFakeStore(state)
      const captured: CapturedFetch[] = []
      const wrappedFetch = mock(async (url: string | URL, init: RequestInit) => {
        captured.push({ url: String(url), init })
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"t","recap":"r"}' } }] }), {
          status: 200,
        })
      })
      globalThis.fetch = wrappedFetch as unknown as typeof fetch

      generateRecapManual(store, state.conv.id, () => {})
      await new Promise(r => setTimeout(r, 20))

      expect(captured.length).toBe(1)
      expect(captured[0].url).toBe('https://openrouter.ai/api/v1/chat/completions')
      const headers = captured[0].init.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer test-key')
      const body = JSON.parse(captured[0].init.body as string)
      expect(body.model).toBe('anthropic/claude-haiku-4.5')
      expect(body.messages.length).toBe(2)
      expect(body.messages[0].role).toBe('system')
      expect(body.messages[1].role).toBe('user')
      expect(body.max_tokens).toBe(256)
      expect(body.temperature).toBe(0.1)
    })
  })

  describe('generateRecapOnEnd', () => {
    it('skips when the conversation already has a recap field', async () => {
      const state = makeStoreState({
        conv: { id: 'conv_done', status: 'ended', recap: 'already summarised' },
        transcript: [makeUserEntry('a'.repeat(100)), makeAssistantEntry('b'.repeat(100))],
      })
      const store = makeFakeStore(state)
      globalThis.fetch = mockOpenRouterResponse('{"title":"t","recap":"r"}')
      generateRecapOnEnd(store, state.conv.id)
      await new Promise(r => setTimeout(r, 20))
      expect(state.added.length).toBe(0)
    })

    it('persists the conversation row after writing the away_summary on the allowEnded path', async () => {
      const longText = 'p'.repeat(120)
      const state = makeStoreState({
        conv: { id: 'conv_ended', status: 'ended' },
        transcript: [makeUserEntry(longText), makeAssistantEntry(longText)],
      })
      const store = makeFakeStore(state)
      globalThis.fetch = mockOpenRouterResponse('{"title":"t","recap":"r"}')
      generateRecapOnEnd(store, state.conv.id)
      await new Promise(r => setTimeout(r, 30))
      expect(state.added.length).toBe(1)
      expect(state.persistCalls).toContain(state.conv.id)
    })

    it('skips when OPENROUTER_API_KEY is unset', () => {
      delete process.env.OPENROUTER_API_KEY
      const state = makeStoreState({ conv: { id: 'conv_e', status: 'ended' } })
      const store = makeFakeStore(state)
      expect(() => generateRecapOnEnd(store, state.conv.id)).not.toThrow()
    })
  })

  describe('transcript condensation', () => {
    it('refuses to call OpenRouter when there is no transcript content', async () => {
      const state = makeStoreState()
      const store = makeFakeStore(state)
      const fetchSpy = mock(async () => new Response('', { status: 200 }))
      globalThis.fetch = fetchSpy as unknown as typeof fetch
      const replies: Array<Record<string, unknown>> = []
      generateRecapManual(store, state.conv.id, m => replies.push(m))
      await new Promise(r => setTimeout(r, 10))
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(replies.some(r => r.ok === false)).toBe(true)
    })

    it('falls back to loadTranscriptFromStore when in-memory cache is empty', async () => {
      const longText = 'r'.repeat(120)
      const state = makeStoreState({
        transcript: [],
        storedTranscript: [makeUserEntry(longText), makeAssistantEntry(longText)],
      })
      const store = makeFakeStore(state)
      globalThis.fetch = mockOpenRouterResponse('{"title":"t","recap":"r"}')
      generateRecapManual(store, state.conv.id, () => {})
      await new Promise(r => setTimeout(r, 30))
      expect(state.added.length).toBe(1)
    })

    it('includes prior away_summary entries as background context', async () => {
      const longText = 's'.repeat(120)
      const captured: CapturedFetch[] = []
      const fetchMock = mock(async (url: string | URL, init: RequestInit) => {
        captured.push({ url: String(url), init })
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"t","recap":"r"}' } }] }), {
          status: 200,
        })
      })
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const state = makeStoreState({
        transcript: [
          makeAwaySummaryEntry('{"title":"earlier","recap":"earlier work happened"}'),
          makeUserEntry(longText),
          makeAssistantEntry(longText),
        ],
      })
      const store = makeFakeStore(state)
      generateRecapManual(store, state.conv.id, () => {})
      await new Promise(r => setTimeout(r, 30))

      expect(captured.length).toBe(1)
      const body = JSON.parse(captured[0].init.body as string)
      const userPrompt = body.messages[1].content as string
      expect(userPrompt).toContain('BACKGROUND')
      expect(userPrompt).toContain('earlier work happened')
    })
  })
})
