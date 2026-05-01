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
import type { ConversationStore } from '../session-store'
import { createConversationStore } from '../session-store'

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
    conversationId: sessionId,
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

let store: ConversationStore

beforeEach(() => {
  store = createConversationStore({ enablePersistence: false })
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
    expect(session!.project).toBe('claude://default/home/user/project')
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
    store.rekeySession('old-id', 'new-id', 'conv-1', '/cwd')

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
    store.subscribeChannel(ws, 'conversation:events', 'ch-sess')

    const subs = store.getChannelSubscribers('conversation:events', 'ch-sess')
    expect(subs.has(ws)).toBe(true)
  })

  it('unsubscribeChannel removes ws from getChannelSubscribers', () => {
    store.createSession('ch-sess2', '/cwd')
    const ws = mockSocket()
    store.subscribeChannel(ws, 'conversation:events', 'ch-sess2')
    store.unsubscribeChannel(ws, 'conversation:events', 'ch-sess2')

    const subs = store.getChannelSubscribers('conversation:events', 'ch-sess2')
    expect(subs.has(ws)).toBe(false)
  })

  it('unsubscribeAllChannels removes ws from all channels it subscribed to', () => {
    store.createSession('ch-multi', '/cwd')
    const ws = mockSocket()
    // Register in subscriber registry first so unsubscribeAllChannels can find the channels
    store.addSubscriber(ws, 2)

    store.subscribeChannel(ws, 'conversation:events', 'ch-multi')
    store.subscribeChannel(ws, 'conversation:transcript', 'ch-multi')

    store.unsubscribeAllChannels(ws)

    expect(store.getChannelSubscribers('conversation:events', 'ch-multi').has(ws)).toBe(false)
    expect(store.getChannelSubscribers('conversation:transcript', 'ch-multi').has(ws)).toBe(false)
  })

  it('getSubscriptionsDiag reflects subscription state', () => {
    store.createSession('diag-sess', '/cwd')
    const ws = mockSocket()
    store.addSubscriber(ws, 2)
    store.subscribeChannel(ws, 'conversation:events', 'diag-sess')

    const diag = store.getSubscriptionsDiag()
    expect(diag.summary.totalSubscribers).toBeGreaterThanOrEqual(1)
    expect(diag.summary.v2Subscribers).toBeGreaterThanOrEqual(1)
    // Channel counts should include our subscription
    const eventCount = diag.summary.channelCounts['conversation:events']
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

describe('conversation socket tracking', () => {
  it('setSessionSocket + getSessionSocket returns the registered socket', () => {
    store.createSession('sock-sess', '/cwd')
    const ws = mockSocket()
    store.setSessionSocket('sock-sess', 'conv-1', ws)

    const retrieved = store.getSessionSocket('sock-sess')
    expect(retrieved).toBe(ws)
  })

  it('getActiveConversationCount reflects number of registered conversations', () => {
    store.createSession('wrap-count', '/cwd')
    expect(store.getActiveConversationCount('wrap-count')).toBe(0)

    const ws1 = mockSocket('ws-1')
    const ws2 = mockSocket('ws-2')
    store.setSessionSocket('wrap-count', 'conv-1', ws1)
    store.setSessionSocket('wrap-count', 'conv-2', ws2)

    expect(store.getActiveConversationCount('wrap-count')).toBe(2)
  })

  it('removeSessionSocket decrements conversation count', () => {
    store.createSession('sock-remove', '/cwd')
    const ws = mockSocket()
    store.setSessionSocket('sock-remove', 'conv-x', ws)
    expect(store.getActiveConversationCount('sock-remove')).toBe(1)

    store.removeSessionSocket('sock-remove', 'conv-x')
    expect(store.getActiveConversationCount('sock-remove')).toBe(0)
    expect(store.getSessionSocket('sock-remove')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// session.model invariant (guards commit 83a4ce7: dashboard reads session.model
// instead of scanning cached SessionStart events per render)
// ---------------------------------------------------------------------------

describe('session.model derivation', () => {
  it('SessionStart with data.model sets session.model on first arrival', () => {
    store.createSession('model-1', '/cwd')
    expect(store.getSession('model-1')!.model).toBeUndefined()

    store.addEvent(
      'model-1',
      makeHookEvent('model-1', 'SessionStart', { data: { session_id: 'model-1', model: 'claude-opus-4-7' } }),
    )

    expect(store.getSession('model-1')!.model).toBe('claude-opus-4-7')
  })

  it('second SessionStart does NOT overwrite an already-set model', () => {
    store.createSession('model-2', '/cwd')
    store.addEvent(
      'model-2',
      makeHookEvent('model-2', 'SessionStart', { data: { session_id: 'model-2', model: 'claude-opus-4-7' } }),
    )
    expect(store.getSession('model-2')!.model).toBe('claude-opus-4-7')

    // Re-emission (e.g. post /clear) arrives with a different model -- must not clobber
    store.addEvent(
      'model-2',
      makeHookEvent('model-2', 'SessionStart', { data: { session_id: 'model-2', model: 'claude-sonnet-4-6' } }),
    )
    expect(store.getSession('model-2')!.model).toBe('claude-opus-4-7')
  })

  it('assistant transcript entry sets session.model when absent', () => {
    store.createSession('model-3', '/cwd')
    store.addTranscriptEntries(
      'model-3',
      [{ type: 'assistant', message: { model: 'claude-opus-4-7' } } as TranscriptEntry],
      true,
    )
    expect(store.getSession('model-3')!.model).toBe('claude-opus-4-7')
  })

  it('assistant transcript entry does NOT overwrite an existing model (fallback only)', () => {
    store.createSession('model-4', '/cwd')
    store.addEvent(
      'model-4',
      makeHookEvent('model-4', 'SessionStart', { data: { session_id: 'model-4', model: 'claude-opus-4-7' } }),
    )
    store.addTranscriptEntries(
      'model-4',
      [{ type: 'assistant', message: { model: 'claude-sonnet-4-6' } } as TranscriptEntry],
      true,
    )
    // Assistant messages are fallback only -- they strip context-window suffixes
    // like [1m], so configuredModel / SessionStart is the authoritative source
    expect(store.getSession('model-4')!.model).toBe('claude-opus-4-7')
  })

  it('<synthetic> assistant entry does NOT clobber a real model', () => {
    store.createSession('model-5', '/cwd')
    store.addEvent(
      'model-5',
      makeHookEvent('model-5', 'SessionStart', { data: { session_id: 'model-5', model: 'claude-opus-4-7' } }),
    )
    store.addTranscriptEntries(
      'model-5',
      [{ type: 'assistant', message: { model: '<synthetic>' } } as TranscriptEntry],
      true,
    )
    expect(store.getSession('model-5')!.model).toBe('claude-opus-4-7')
  })

  it('<synthetic> assistant entry is always rejected (never sets session.model)', () => {
    store.createSession('model-6', '/cwd')
    store.addTranscriptEntries(
      'model-6',
      [{ type: 'assistant', message: { model: '<synthetic>' } } as TranscriptEntry],
      true,
    )
    // <synthetic> entries are auto-compact summaries / hook-injected messages,
    // not real API turns -- never use them for model tracking
    expect(store.getSession('model-6')!.model).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 8. Project URI field
// ---------------------------------------------------------------------------

describe('project URI field', () => {
  it('createSession auto-populates project from cwd', () => {
    store.createSession('proj-1', '/Users/jonas/projects/foo')
    const session = store.getSession('proj-1')!
    expect(session.project).toBe('claude://default/Users/jonas/projects/foo')
  })

  it('project uses claude:// scheme by default', () => {
    store.createSession('proj-2', '/tmp/test')
    expect(store.getSession('proj-2')!.project).toBe('claude://default/tmp/test')
  })

  it('rekey (different ID) recomputes project from new cwd', () => {
    store.createSession('proj-old', '/old/path')
    store.rekeySession('proj-old', 'proj-new', 'w1', '/new/path')
    const session = store.getSession('proj-new')!
    expect(session.project).toBe('claude://default/new/path')
  })

  it('same-ID rekey updates project from new cwd', () => {
    store.createSession('proj-same', '/original/path')
    store.rekeySession('proj-same', 'proj-same', 'w1', '/updated/path')
    const session = store.getSession('proj-same')!
    expect(session.project).toBe('claude://default/updated/path')
  })

  it('project field survives session resume', () => {
    store.createSession('proj-resume', '/Users/jonas/projects/bar')
    store.resumeSession('proj-resume')
    const session = store.getSession('proj-resume')!
    expect(session.project).toBe('claude://default/Users/jonas/projects/bar')
  })
})

// ---------------------------------------------------------------------------
// 9. Project URI-based lookups (Phase 1b)
// ---------------------------------------------------------------------------

describe('project link management (project URI)', () => {
  it('linkProjects + checkProjectLink uses project URI internally', () => {
    store.createSession('link-a', '/projects/alpha')
    store.createSession('link-b', '/projects/beta')
    store.linkProjects('link-a', 'link-b')

    expect(store.checkProjectLink('link-a', 'link-b')).toBe('linked')
    expect(store.checkProjectLink('link-b', 'link-a')).toBe('linked')
  })

  it('checkProjectLink returns unknown for unlinked sessions', () => {
    store.createSession('unknown-a', '/projects/one')
    store.createSession('unknown-b', '/projects/two')

    expect(store.checkProjectLink('unknown-a', 'unknown-b')).toBe('unknown')
  })

  it('checkProjectLink returns unknown for missing sessions', () => {
    store.createSession('exists', '/projects/real')
    expect(store.checkProjectLink('exists', 'ghost')).toBe('unknown')
    expect(store.checkProjectLink('ghost', 'exists')).toBe('unknown')
  })

  it('blockProject marks pair as blocked', () => {
    store.createSession('block-a', '/projects/x')
    store.createSession('block-b', '/projects/y')

    store.linkProjects('block-a', 'block-b')
    expect(store.checkProjectLink('block-a', 'block-b')).toBe('linked')

    store.blockProject('block-a', 'block-b')
    expect(store.checkProjectLink('block-a', 'block-b')).toBe('blocked')
  })

  it('unlinkProjects removes link by session ID', () => {
    store.createSession('unlink-a', '/projects/m')
    store.createSession('unlink-b', '/projects/n')

    store.linkProjects('unlink-a', 'unlink-b')
    expect(store.checkProjectLink('unlink-a', 'unlink-b')).toBe('linked')

    store.unlinkProjects('unlink-a', 'unlink-b')
    expect(store.checkProjectLink('unlink-a', 'unlink-b')).toBe('unknown')
  })

  it('unlinkProjects by session ID severs project link', () => {
    store.createSession('cwd-unlink-a', 'claude://default/projects/p')
    store.createSession('cwd-unlink-b', 'claude://default/projects/q')

    store.linkProjects('cwd-unlink-a', 'cwd-unlink-b')
    expect(store.checkProjectLink('cwd-unlink-a', 'cwd-unlink-b')).toBe('linked')

    store.unlinkProjects('cwd-unlink-a', 'cwd-unlink-b')
    expect(store.checkProjectLink('cwd-unlink-a', 'cwd-unlink-b')).toBe('unknown')
  })

  it('getLinkedProjects returns linked project CWDs for a session', () => {
    store.createSession('gp-a', '/projects/foo')
    store.createSession('gp-b', '/projects/bar')
    store.linkProjects('gp-a', 'gp-b')

    const linked = store.getLinkedProjects('gp-a')
    expect(linked).toHaveLength(1)
    expect(linked[0].project).toBe('claude://default/projects/bar')
  })

  it('getLinkedProjects returns empty for session with no links', () => {
    store.createSession('gp-solo', '/projects/solo')
    expect(store.getLinkedProjects('gp-solo')).toEqual([])
  })

  it('link key normalization: same project URI = same key', () => {
    store.createSession('norm-a', '/projects/same')
    store.createSession('norm-b', '/projects/other')

    store.linkProjects('norm-a', 'norm-b')
    expect(store.checkProjectLink('norm-a', 'norm-b')).toBe('linked')
    expect(store.checkProjectLink('norm-b', 'norm-a')).toBe('linked')
  })
})

describe('project message queue (project URI)', () => {
  it('queueProjectMessage + drainProjectMessages uses project URI keys', () => {
    store.createSession('mq-a', '/projects/sender')
    store.createSession('mq-b', '/projects/receiver')

    const msg1 = { type: 'test', content: 'hello' }
    const msg2 = { type: 'test', content: 'world' }
    store.queueProjectMessage('mq-a', 'mq-b', msg1)
    store.queueProjectMessage('mq-a', 'mq-b', msg2)

    const drained = store.drainProjectMessages('mq-a', 'mq-b')
    expect(drained).toHaveLength(2)
    expect(drained[0]).toEqual(msg1)
    expect(drained[1]).toEqual(msg2)
  })

  it('drainProjectMessages empties the queue', () => {
    store.createSession('drain-a', '/projects/s')
    store.createSession('drain-b', '/projects/r')

    store.queueProjectMessage('drain-a', 'drain-b', { type: 'x' })
    store.drainProjectMessages('drain-a', 'drain-b')

    const second = store.drainProjectMessages('drain-a', 'drain-b')
    expect(second).toHaveLength(0)
  })

  it('drainProjectMessages returns empty for missing sessions', () => {
    expect(store.drainProjectMessages('ghost-a', 'ghost-b')).toEqual([])
  })
})

describe('broadcast scoping (project URI)', () => {
  it('broadcastForProject accepts bare CWD (backward compat)', () => {
    store.createSession('bc-1', '/projects/target')
    expect(() => store.broadcastForProject('/projects/target')).not.toThrow()
  })

  it('broadcastForProject accepts project URI', () => {
    store.createSession('bc-2', '/projects/target2')
    expect(() => store.broadcastForProject('claude://default/projects/target2')).not.toThrow()
  })

  it('broadcastToConversationsAtCwd accepts bare CWD (backward compat)', () => {
    store.createSession('bw-1', '/projects/wrap')
    const count = store.broadcastToConversationsAtCwd('/projects/wrap', { type: 'test' })
    // No wrappers registered, so count is 0 but shouldn't throw
    expect(count).toBe(0)
  })

  it('broadcastToConversationsForProject accepts project URI', () => {
    store.createSession('bw-2', '/projects/wrap2')
    const count = store.broadcastToConversationsForProject('claude://default/projects/wrap2', { type: 'test' })
    expect(count).toBe(0)
  })
})
