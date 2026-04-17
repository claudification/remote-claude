/**
 * Behavioral tests for session-store public API.
 *
 * Black-box tests on the SessionStore interface returned by createSessionStore().
 * Tests must pass on the current (pre-split) code and serve as a safety net for
 * any future structural refactoring.
 *
 * Constructed with enablePersistence: false to skip all disk I/O.
 */

import type { ServerWebSocket } from 'bun'
import { beforeEach, describe, expect, it } from 'vitest'
import type { HookEvent, TaskInfo, TranscriptEntry } from '../../shared/protocol'
import { createSessionStore } from '../session-store'
import type { SessionStore } from '../session-store'

// Minimal mock socket -- used only for identity / set membership.
// No actual send() calls reach these in non-persistence, no-subscriber mode
// because broadcastSessionScoped iterates an empty dashboardSubscribers set.
function mockSocket(id = Math.random().toString()): ServerWebSocket<unknown> {
  return {
    _id: id,
    data: {},
    send: () => 0,
    close: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    publish: () => false,
    terminate: () => {},
    ping: () => {},
    pong: () => {},
    readyState: 1,
    remoteAddress: '127.0.0.1',
    binaryType: 'nodebuffer',
    bufferedAmount: 0,
  } as unknown as ServerWebSocket<unknown>
}

function makeHookEvent(
  sessionId: string,
  hookEvent: HookEvent['hookEvent'] = 'UserPromptSubmit',
  overrides: Partial<HookEvent> = {},
): HookEvent {
  return {
    type: 'hook',
    sessionId,
    hookEvent,
    timestamp: Date.now(),
    data: { session_id: sessionId },
    ...overrides,
  }
}

function makeTranscriptEntry(type: string = 'user'): TranscriptEntry {
  return { type } as TranscriptEntry
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let store: SessionStore

beforeEach(() => {
  store = createSessionStore({ enablePersistence: false })
})

// ---------------------------------------------------------------------------
// 1. Session lifecycle
// ---------------------------------------------------------------------------

describe('session lifecycle', () => {
  it('createSession returns a session accessible via getSession', () => {
    store.createSession('sess-1', '/home/user/project')
    const session = store.getSession('sess-1')
    expect(session).toBeDefined()
    expect(session!.id).toBe('sess-1')
    expect(session!.cwd).toBe('/home/user/project')
  })

  it('createSession makes session appear in getAllSessions', () => {
    store.createSession('sess-a', '/cwd/a')
    store.createSession('sess-b', '/cwd/b')
    const all = store.getAllSessions()
    expect(all.map(s => s.id)).toContain('sess-a')
    expect(all.map(s => s.id)).toContain('sess-b')
  })

  it('createSession makes session appear in getActiveSessions (status is not ended)', () => {
    store.createSession('sess-active', '/cwd')
    const active = store.getActiveSessions()
    expect(active.map(s => s.id)).toContain('sess-active')
  })

  it('createSession called twice with same id returns existing session without duplicate', () => {
    const first = store.createSession('dup-id', '/cwd')
    // Second call -- session already exists, so it goes straight through sessions.set(id, session)
    // The implementation does NOT check for existence; it overwrites but the original session is gone.
    // Read actual code: sessions.set(id, session) -- it creates a NEW session object every time.
    // Verify via getAllSessions that only one entry exists with that id.
    store.createSession('dup-id', '/cwd')
    const all = store.getAllSessions()
    const withId = all.filter(s => s.id === 'dup-id')
    // The implementation overwrites, so there is still exactly one entry
    expect(withId).toHaveLength(1)
    // The returned session from first call is now replaced -- second createSession wins
    expect(first.id).toBe('dup-id')
  })

  it('endSession moves session out of getActiveSessions but keeps it in getAllSessions', () => {
    store.createSession('end-me', '/cwd')
    store.endSession('end-me', 'completed')

    const active = store.getActiveSessions()
    expect(active.map(s => s.id)).not.toContain('end-me')

    const all = store.getAllSessions()
    expect(all.map(s => s.id)).toContain('end-me')
    expect(store.getSession('end-me')!.status).toBe('ended')
  })

  it('removeSession removes session from everywhere', () => {
    store.createSession('remove-me', '/cwd')
    store.removeSession('remove-me')

    expect(store.getSession('remove-me')).toBeUndefined()
    expect(store.getAllSessions().map(s => s.id)).not.toContain('remove-me')
    expect(store.getActiveSessions().map(s => s.id)).not.toContain('remove-me')
  })

  it('resumeSession on an ended session restores it to active sessions', () => {
    store.createSession('resume-me', '/cwd')
    store.endSession('resume-me', 'done')
    expect(store.getActiveSessions().map(s => s.id)).not.toContain('resume-me')

    store.resumeSession('resume-me')
    expect(store.getActiveSessions().map(s => s.id)).toContain('resume-me')
    // status is reset to 'starting' on resume
    expect(store.getSession('resume-me')!.status).toBe('starting')
  })

  it('getSession on nonexistent id returns undefined', () => {
    expect(store.getSession('ghost-session')).toBeUndefined()
  })

  it('rekeySession makes session accessible under new id, old id is gone', () => {
    store.createSession('old-id', '/cwd')
    store.rekeySession('old-id', 'new-id', 'wrapper-1', '/cwd')

    expect(store.getSession('old-id')).toBeUndefined()
    const session = store.getSession('new-id')
    expect(session).toBeDefined()
    expect(session!.id).toBe('new-id')
  })

  it('updateActivity updates session lastActivity timestamp', async () => {
    store.createSession('act-test', '/cwd')
    const before = store.getSession('act-test')!.lastActivity

    // Guarantee time advance
    await new Promise(r => setTimeout(r, 2))
    store.updateActivity('act-test')

    const after = store.getSession('act-test')!.lastActivity
    expect(after).toBeGreaterThan(before)
  })
})

// ---------------------------------------------------------------------------
// 2. Event ingestion
// ---------------------------------------------------------------------------

describe('event ingestion', () => {
  it('addEvent on an existing session stores the event in getSessionEvents', () => {
    store.createSession('ev-sess', '/cwd')
    const event = makeHookEvent('ev-sess', 'UserPromptSubmit')
    store.addEvent('ev-sess', event)

    const events = store.getSessionEvents('ev-sess')
    expect(events).toHaveLength(1)
    expect(events[0].hookEvent).toBe('UserPromptSubmit')
  })

  it('addEvent on a missing session does not crash', () => {
    const event = makeHookEvent('ghost', 'UserPromptSubmit')
    // Should not throw -- event is silently dropped
    expect(() => store.addEvent('ghost', event)).not.toThrow()
    expect(store.getSessionEvents('ghost')).toHaveLength(0)
  })

  it('getSessionEvents with limit returns last N events', () => {
    store.createSession('limit-sess', '/cwd')
    for (let i = 0; i < 10; i++) {
      store.addEvent('limit-sess', makeHookEvent('limit-sess', 'UserPromptSubmit', { timestamp: i }))
    }
    const last3 = store.getSessionEvents('limit-sess', 3)
    expect(last3).toHaveLength(3)
    // Should be the last 3 (highest timestamps)
    expect(last3[2].timestamp).toBe(9)
  })

  it('getSessionEvents with since returns only events after that timestamp', () => {
    store.createSession('since-sess', '/cwd')
    for (let i = 0; i < 5; i++) {
      store.addEvent('since-sess', makeHookEvent('since-sess', 'UserPromptSubmit', { timestamp: i * 100 }))
    }
    // Timestamps: 0, 100, 200, 300, 400 -- since=150 should return 200, 300, 400
    const events = store.getSessionEvents('since-sess', undefined, 150)
    expect(events).toHaveLength(3)
    expect(events[0].timestamp).toBe(200)
  })

  it('addEvent with Stop hook transitions session status to idle', () => {
    store.createSession('stop-sess', '/cwd')
    store.addEvent('stop-sess', makeHookEvent('stop-sess', 'Stop'))
    expect(store.getSession('stop-sess')!.status).toBe('idle')
  })

  it('addEvent with non-passive hook (UserPromptSubmit) transitions session status to active', () => {
    store.createSession('prompt-sess', '/cwd')
    // Start in 'starting' status, a non-passive event should flip to 'active'
    store.addEvent('prompt-sess', makeHookEvent('prompt-sess', 'UserPromptSubmit'))
    expect(store.getSession('prompt-sess')!.status).toBe('active')
  })

  it('updateTasks replaces session tasks', () => {
    store.createSession('task-sess', '/cwd')
    const tasks: TaskInfo[] = [
      { id: 'task-1', subject: 'Do something', status: 'pending', updatedAt: Date.now() },
      { id: 'task-2', subject: 'Do another', status: 'in_progress', updatedAt: Date.now() },
    ]
    store.updateTasks('task-sess', tasks)
    const session = store.getSession('task-sess')!
    expect(session.tasks).toHaveLength(2)
    expect(session.tasks[0].id).toBe('task-1')
    expect(session.tasks[1].status).toBe('in_progress')
  })
})

// ---------------------------------------------------------------------------
// 3. Transcript cache
// ---------------------------------------------------------------------------

describe('transcript cache', () => {
  it('hasTranscriptCache returns false before any entries are added', () => {
    store.createSession('tc-sess', '/cwd')
    expect(store.hasTranscriptCache('tc-sess')).toBe(false)
  })

  it('addTranscriptEntries with isInitial=true stores entries, hasTranscriptCache returns true', () => {
    store.createSession('tc-init', '/cwd')
    const entries = [makeTranscriptEntry('user'), makeTranscriptEntry('assistant')]
    store.addTranscriptEntries('tc-init', entries, true)

    expect(store.hasTranscriptCache('tc-init')).toBe(true)
    const cached = store.getTranscriptEntries('tc-init')
    expect(cached).toHaveLength(2)
  })

  it('getTranscriptEntries with limit returns last N entries', () => {
    store.createSession('tc-limit', '/cwd')
    const entries = Array.from({ length: 10 }, (_, i) => ({ type: 'user', _i: i }) as unknown as TranscriptEntry)
    store.addTranscriptEntries('tc-limit', entries, true)

    const last3 = store.getTranscriptEntries('tc-limit', 3)
    expect(last3).toHaveLength(3)
    // Last 3 entries (indices 7, 8, 9)
    expect((last3[2] as unknown as { _i: number })._i).toBe(9)
  })

  it('addTranscriptEntries with isInitial=false appends to existing cache', () => {
    store.createSession('tc-append', '/cwd')
    store.addTranscriptEntries('tc-append', [makeTranscriptEntry('user')], true)
    store.addTranscriptEntries('tc-append', [makeTranscriptEntry('assistant')], false)

    const cached = store.getTranscriptEntries('tc-append')
    expect(cached).toHaveLength(2)
    expect(cached[0].type).toBe('user')
    expect(cached[1].type).toBe('assistant')
  })

  it('addTranscriptEntries with isInitial=true replaces existing cache', () => {
    store.createSession('tc-replace', '/cwd')
    store.addTranscriptEntries('tc-replace', [makeTranscriptEntry('user')], true)
    // Replace with a fresh initial load
    store.addTranscriptEntries('tc-replace', [makeTranscriptEntry('assistant'), makeTranscriptEntry('user')], true)

    const cached = store.getTranscriptEntries('tc-replace')
    expect(cached).toHaveLength(2)
    expect(cached[0].type).toBe('assistant')
  })

  it('subagent: hasSubagentTranscriptCache returns false before entries added', () => {
    store.createSession('sub-sess', '/cwd')
    expect(store.hasSubagentTranscriptCache('sub-sess', 'agent-1')).toBe(false)
  })

  it('subagent: addSubagentTranscriptEntries stores entries, getSubagentTranscriptEntries returns them', () => {
    store.createSession('sub-sess', '/cwd')
    const entries = [makeTranscriptEntry('user'), makeTranscriptEntry('assistant')]
    store.addSubagentTranscriptEntries('sub-sess', 'agent-1', entries, true)

    expect(store.hasSubagentTranscriptCache('sub-sess', 'agent-1')).toBe(true)
    const cached = store.getSubagentTranscriptEntries('sub-sess', 'agent-1')
    expect(cached).toHaveLength(2)
  })

  it('subagent: caches are keyed by agentId (different agents are independent)', () => {
    store.createSession('sub-multi', '/cwd')
    store.addSubagentTranscriptEntries('sub-multi', 'agent-A', [makeTranscriptEntry('user')], true)
    store.addSubagentTranscriptEntries('sub-multi', 'agent-B', [makeTranscriptEntry('assistant')], true)

    expect(store.getSubagentTranscriptEntries('sub-multi', 'agent-A')[0].type).toBe('user')
    expect(store.getSubagentTranscriptEntries('sub-multi', 'agent-B')[0].type).toBe('assistant')
  })
})

// ---------------------------------------------------------------------------
// 4. Channel pub/sub
// ---------------------------------------------------------------------------

describe('channel pub/sub', () => {
  it('subscribeChannel adds ws to getChannelSubscribers', () => {
    store.createSession('ch-sess', '/cwd')
    const ws = mockSocket()
    // Must be a registered subscriber for the reverse index to work properly
    // (subscribeChannel does track via subscriberRegistry but getChannelSubscribers
    //  uses the forward index directly -- no subscriber registry required)
    store.subscribeChannel(ws, 'session:events', 'ch-sess')

    const subs = store.getChannelSubscribers('session:events', 'ch-sess')
    expect(subs.has(ws)).toBe(true)
  })

  it('unsubscribeChannel removes ws from getChannelSubscribers', () => {
    store.createSession('ch-sess2', '/cwd')
    const ws = mockSocket()
    store.subscribeChannel(ws, 'session:events', 'ch-sess2')
    store.unsubscribeChannel(ws, 'session:events', 'ch-sess2')

    const subs = store.getChannelSubscribers('session:events', 'ch-sess2')
    expect(subs.has(ws)).toBe(false)
  })

  it('unsubscribeAllChannels removes ws from all channels it subscribed to', () => {
    store.createSession('ch-multi', '/cwd')
    const ws = mockSocket()
    // Register in subscriber registry first so unsubscribeAllChannels can find the channels
    store.addSubscriber(ws, 2)

    store.subscribeChannel(ws, 'session:events', 'ch-multi')
    store.subscribeChannel(ws, 'session:transcript', 'ch-multi')

    store.unsubscribeAllChannels(ws)

    expect(store.getChannelSubscribers('session:events', 'ch-multi').has(ws)).toBe(false)
    expect(store.getChannelSubscribers('session:transcript', 'ch-multi').has(ws)).toBe(false)
  })

  it('getSubscriptionsDiag reflects subscription state', () => {
    store.createSession('diag-sess', '/cwd')
    const ws = mockSocket()
    store.addSubscriber(ws, 2)
    store.subscribeChannel(ws, 'session:events', 'diag-sess')

    const diag = store.getSubscriptionsDiag()
    expect(diag.summary.totalSubscribers).toBeGreaterThanOrEqual(1)
    expect(diag.summary.v2Subscribers).toBeGreaterThanOrEqual(1)
    // Channel counts should include our subscription
    const eventCount = diag.summary.channelCounts['session:events']
    expect(eventCount).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// 5. Sync state
// ---------------------------------------------------------------------------

describe('sync state', () => {
  it('getSyncState returns epoch (string) and seq (number) on a fresh store', () => {
    const state = store.getSyncState()
    expect(typeof state.epoch).toBe('string')
    expect(state.epoch.length).toBeGreaterThan(0)
    expect(typeof state.seq).toBe('number')
  })

  it('seq increments after session creation (createSession triggers broadcast which stamps)', () => {
    const before = store.getSyncState().seq
    store.createSession('seq-sess', '/cwd')
    // createSession calls broadcastSessionScoped which calls stampAndBuffer -> syncSeq++
    const after = store.getSyncState().seq
    expect(after).toBeGreaterThan(before)
  })

  it('handleSyncCheck with matching epoch and current seq responds sync_ok', () => {
    store.createSession('sync-sess', '/cwd')
    const { epoch, seq } = store.getSyncState()

    const received: string[] = []
    const ws = {
      ...mockSocket(),
      data: {},
      send: (msg: string) => {
        received.push(msg)
        return 0
      },
    } as unknown as ServerWebSocket<unknown>

    store.handleSyncCheck(ws, epoch, seq)

    expect(received).toHaveLength(1)
    const response = JSON.parse(received[0])
    expect(response.type).toBe('sync_ok')
  })

  it('handleSyncCheck with mismatched epoch responds sync_stale', () => {
    const received: string[] = []
    const ws = {
      ...mockSocket(),
      data: {},
      send: (msg: string) => {
        received.push(msg)
        return 0
      },
    } as unknown as ServerWebSocket<unknown>

    store.handleSyncCheck(ws, 'wrong-epoch', 0)

    expect(received).toHaveLength(1)
    const response = JSON.parse(received[0])
    expect(response.type).toBe('sync_stale')
    expect(response.reason).toBe('epoch_changed')
  })
})

// ---------------------------------------------------------------------------
// 6. Wrapper socket tracking
// ---------------------------------------------------------------------------

describe('wrapper socket tracking', () => {
  it('setSessionSocket + getSessionSocket returns the registered socket', () => {
    store.createSession('sock-sess', '/cwd')
    const ws = mockSocket()
    store.setSessionSocket('sock-sess', 'wrapper-1', ws)

    const retrieved = store.getSessionSocket('sock-sess')
    expect(retrieved).toBe(ws)
  })

  it('getActiveWrapperCount reflects number of registered wrappers', () => {
    store.createSession('wrap-count', '/cwd')
    expect(store.getActiveWrapperCount('wrap-count')).toBe(0)

    const ws1 = mockSocket('ws-1')
    const ws2 = mockSocket('ws-2')
    store.setSessionSocket('wrap-count', 'wrapper-1', ws1)
    store.setSessionSocket('wrap-count', 'wrapper-2', ws2)

    expect(store.getActiveWrapperCount('wrap-count')).toBe(2)
  })

  it('removeSessionSocket decrements wrapper count', () => {
    store.createSession('sock-remove', '/cwd')
    const ws = mockSocket()
    store.setSessionSocket('sock-remove', 'wrapper-x', ws)
    expect(store.getActiveWrapperCount('sock-remove')).toBe(1)

    store.removeSessionSocket('sock-remove', 'wrapper-x')
    expect(store.getActiveWrapperCount('sock-remove')).toBe(0)
    expect(store.getSessionSocket('sock-remove')).toBeUndefined()
  })
})
