import { describe, expect, test } from 'vitest'
import type { AgentHostContext } from './agent-host-context'
import { observeClaudeSessionId, type SessionTransition } from './session-transition'

/**
 * Behavioural tests for observeClaudeSessionId. Every known call ordering
 * from the two observers (SessionStart hook + stream-json onInit) is
 * exercised so regressions of the 2026-04-17 race (rekey eaten by same-id
 * guard after observer-order shuffle) become impossible.
 */

type WsCall =
  | { fn: 'setSessionId'; id: string; source: 'hook' | 'stream_json' }
  | { fn: 'sendBootEvent'; step: string; detail?: string; raw?: unknown }
  | { fn: 'sendConversationRekey'; id: string; project: string; model?: string }

interface DiagCall {
  type: string
  msg: string
  args?: unknown
}

function makeCtx(init: { claudeSessionId?: string | null; pendingClearFromId?: string | null; hasWs?: boolean } = {}): {
  ctx: AgentHostContext
  wsCalls: WsCall[]
  diagCalls: DiagCall[]
  connectCalls: Array<string | null>
} {
  const wsCalls: WsCall[] = []
  const diagCalls: DiagCall[] = []
  const connectCalls: Array<string | null> = []

  const wsStub =
    init.hasWs === false
      ? null
      : {
          isConnected: () => true,
          setSessionId: (id: string, source: 'hook' | 'stream_json') =>
            wsCalls.push({ fn: 'setSessionId', id, source }),
          sendBootEvent: (step: string, detail?: string, raw?: unknown) =>
            wsCalls.push({ fn: 'sendBootEvent', step, detail, raw }),
          sendConversationRekey: (id: string, project: string, model?: string) =>
            wsCalls.push({ fn: 'sendConversationRekey', id, project, model }),
          // observeClaudeSessionId now also emits launch events, which call
          // wsClient.send() if connected. Swallow them in the stub -- they
          // are verified indirectly via the kind/reason of the transition.
          send: () => {},
        }

  // Partial<AgentHostContext> cast -- only the fields observeClaudeSessionId
  // touches are populated. Unused fields remain undefined and would throw if
  // accessed, which is the desired failure mode for a test.
  const ctx = {
    conversationId: 'internal-xyz',
    cwd: '/test/cwd',
    claudeSessionId: init.claudeSessionId ?? null,
    pendingClearFromId: init.pendingClearFromId ?? null,
    wsClient: wsStub,
    subagentWatchers: new Map(),
    lastTasksJson: 'stale',
    taskWatcher: null,
    currentLaunchId: 'test-launch-id',
    currentLaunchPhase: 'initial' as const,
    launchEvents: [],
    pendingTranscriptEntries: [],
    diag: (type: string, msg: string, args?: unknown) => diagCalls.push({ type, msg, args }),
    debug: () => {},
    connectToBroker: (id: string | null) => connectCalls.push(id),
    startTaskWatching: () => {},
    startProjectWatching: () => {},
  } as unknown as AgentHostContext

  return { ctx, wsCalls, diagCalls, connectCalls }
}

describe('observeClaudeSessionId', () => {
  test('first-init boot: wsClient present, promotes booting session', () => {
    const { ctx, wsCalls, diagCalls } = makeCtx()

    const t = observeClaudeSessionId(ctx, 'sess-abc', 'hook', 'claude-opus-4-7')

    expect(t).toMatchObject<Partial<SessionTransition>>({
      kind: 'boot',
      source: 'hook',
      reason: 'first-init',
      from: null,
      to: 'sess-abc',
    })
    expect(ctx.claudeSessionId).toBe('sess-abc')
    expect(wsCalls).toEqual([
      { fn: 'setSessionId', id: 'sess-abc', source: 'hook' },
      {
        fn: 'sendBootEvent',
        step: 'init_received',
        detail: 'session=sess-abc (hook)',
        raw: { model: 'claude-opus-4-7' },
      },
      { fn: 'sendBootEvent', step: 'session_ready', detail: undefined, raw: undefined },
    ])
    expect(diagCalls[0]).toMatchObject({ type: 'session', msg: 'transition: boot (first-init)' })
  })

  test('first-init boot: no wsClient, opens a fresh connection', () => {
    const { ctx, wsCalls, connectCalls } = makeCtx({ hasWs: false })

    const t = observeClaudeSessionId(ctx, 'sess-abc', 'stream_json')

    expect(t.kind).toBe('boot')
    expect(connectCalls).toEqual(['sess-abc'])
    expect(wsCalls).toEqual([])
  })

  test('post-clear rekey (hook fires first): emits session_clear with old->new', () => {
    // Scenario from the 2026-04-17 incident. onExit left claudeSessionId intact
    // and set pendingClearFromId. Hook sees the new id first and MUST rekey,
    // not promote-as-boot.
    const { ctx, wsCalls, diagCalls } = makeCtx({
      claudeSessionId: 'sess-old',
      pendingClearFromId: 'sess-old',
    })

    const t = observeClaudeSessionId(ctx, 'sess-new', 'hook', 'claude-opus-4-7')

    expect(t).toMatchObject<Partial<SessionTransition>>({
      kind: 'rekey',
      reason: 'post-clear',
      from: 'sess-old',
      to: 'sess-new',
    })
    expect(ctx.claudeSessionId).toBe('sess-new')
    expect(ctx.pendingClearFromId).toBe(null)
    expect(wsCalls).toEqual([
      { fn: 'sendConversationRekey', id: 'sess-new', project: 'claude://default/test/cwd', model: 'claude-opus-4-7' },
    ])
    expect(diagCalls.at(-1)).toMatchObject({ type: 'session', msg: 'transition: rekey (post-clear)' })
  })

  test('post-clear: onInit fires AFTER hook already rekeyed -> confirm no-op', () => {
    // Hook ran first, updated claudeSessionId to the new id, cleared pending.
    // onInit now fires with the same id -- must classify as duplicate confirm,
    // NOT emit another session_clear (would hit the same-id guard regression).
    const { ctx, wsCalls, diagCalls } = makeCtx({
      claudeSessionId: 'sess-new',
      pendingClearFromId: null,
    })

    const t = observeClaudeSessionId(ctx, 'sess-new', 'stream_json')

    expect(t).toMatchObject<Partial<SessionTransition>>({
      kind: 'confirm',
      reason: 'duplicate',
      from: 'sess-new',
      to: 'sess-new',
    })
    expect(wsCalls).toEqual([])
    expect(diagCalls.at(-1)).toMatchObject({ type: 'session', msg: 'transition: confirm (duplicate)' })
  })

  test('post-clear: onInit fires BEFORE hook -> onInit does the rekey', () => {
    const { ctx, wsCalls } = makeCtx({
      claudeSessionId: 'sess-old',
      pendingClearFromId: 'sess-old',
    })

    const t1 = observeClaudeSessionId(ctx, 'sess-new', 'stream_json')
    expect(t1.kind).toBe('rekey')
    expect(t1.reason).toBe('post-clear')
    expect(wsCalls).toEqual([
      { fn: 'sendConversationRekey', id: 'sess-new', project: 'claude://default/test/cwd', model: undefined },
    ])

    // Hook then fires with the same id -- must no-op.
    const t2 = observeClaudeSessionId(ctx, 'sess-new', 'hook')
    expect(t2.kind).toBe('confirm')
    expect(wsCalls).toHaveLength(1) // no additional calls
  })

  test('unexpected rekey (no pendingClearFromId, e.g. /resume or compaction)', () => {
    const { ctx, wsCalls } = makeCtx({ claudeSessionId: 'sess-old' })

    const t = observeClaudeSessionId(ctx, 'sess-new', 'hook')

    expect(t).toMatchObject<Partial<SessionTransition>>({
      kind: 'rekey',
      reason: 'unexpected',
      from: 'sess-old',
      to: 'sess-new',
    })
    expect(wsCalls).toEqual([
      { fn: 'sendConversationRekey', id: 'sess-new', project: 'claude://default/test/cwd', model: undefined },
    ])
  })

  test('rekey tears down subagent watchers and resets task watcher', () => {
    const stoppedAgents: string[] = []
    const { ctx, wsCalls } = makeCtx({
      claudeSessionId: 'sess-old',
      pendingClearFromId: 'sess-old',
    })
    ;(ctx.subagentWatchers as Map<string, { stop: () => void }>).set('agent-a', {
      stop: () => stoppedAgents.push('agent-a'),
    } as never)
    ;(ctx.subagentWatchers as Map<string, { stop: () => void }>).set('agent-b', {
      stop: () => stoppedAgents.push('agent-b'),
    } as never)
    ctx.lastTasksJson = 'stale-json'
    let taskWatcherClosed = false
    ctx.taskWatcher = { close: () => (taskWatcherClosed = true) } as never
    let taskRestart = 0
    let projectRestart = 0
    ctx.startTaskWatching = () => {
      taskRestart++
    }
    ctx.startProjectWatching = () => {
      projectRestart++
    }

    observeClaudeSessionId(ctx, 'sess-new', 'hook')

    expect(stoppedAgents.sort()).toEqual(['agent-a', 'agent-b'])
    expect(ctx.subagentWatchers.size).toBe(0)
    expect(ctx.lastTasksJson).toBe('')
    expect(taskWatcherClosed).toBe(true)
    expect(ctx.taskWatcher).toBe(null)
    expect(taskRestart).toBe(1)
    expect(projectRestart).toBe(1)
    expect(wsCalls).toHaveLength(1) // sendConversationRekey
  })

  test('rekey with disconnected wsClient: skips send but still updates state', () => {
    const { ctx } = makeCtx({ claudeSessionId: 'sess-old', pendingClearFromId: 'sess-old' })
    // Override isConnected to simulate disconnected ws
    ;(ctx.wsClient as { isConnected: () => boolean }).isConnected = () => false
    const wsCallsOverride: WsCall[] = []
    ;(
      ctx.wsClient as unknown as { sendConversationRekey: (id: string, project: string) => void }
    ).sendConversationRekey = (id: string, project: string) => {
      wsCallsOverride.push({ fn: 'sendConversationRekey', id, project })
    }

    const t = observeClaudeSessionId(ctx, 'sess-new', 'hook')

    expect(t.kind).toBe('rekey')
    expect(ctx.claudeSessionId).toBe('sess-new')
    expect(ctx.pendingClearFromId).toBe(null)
    expect(wsCallsOverride).toEqual([]) // nothing sent (not connected)
  })

  test('same id observed twice in a row on cold start: second call is confirm', () => {
    const { ctx, wsCalls } = makeCtx()

    const t1 = observeClaudeSessionId(ctx, 'sess-abc', 'hook')
    expect(t1.kind).toBe('boot')

    const t2 = observeClaudeSessionId(ctx, 'sess-abc', 'stream_json')
    expect(t2.kind).toBe('confirm')
    expect(t2.reason).toBe('duplicate')
    // Only the boot produced ws calls.
    expect(wsCalls).toHaveLength(3) // setSessionId + 2 boot events from first call
  })
})
