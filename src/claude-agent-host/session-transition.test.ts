import { describe, expect, test } from 'bun:test'
import type { AgentHostContext } from './agent-host-context'
import { observeClaudeSessionId } from './session-transition'

/**
 * Behavioural tests for observeClaudeSessionId. Every known call ordering
 * from the two observers (SessionStart hook + stream-json onInit) is
 * exercised so regressions of the 2026-04-17 race become impossible.
 */

type WsCall =
  | { fn: 'setSessionId'; id: string; source: 'hook' | 'stream_json' }
  | { fn: 'sendBootEvent'; step: string; detail?: string; raw?: unknown }
  | { fn: 'sendConversationReset'; project: string; model?: string }
  | { fn: 'sendMetadataUpdate'; metadata: Record<string, unknown> }

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
          sendConversationReset: (project: string, model?: string) =>
            wsCalls.push({ fn: 'sendConversationReset', project, model }),
          sendMetadataUpdate: (metadata: Record<string, unknown>) =>
            wsCalls.push({ fn: 'sendMetadataUpdate', metadata }),
          send: () => {},
        }

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

    expect(t).toMatchObject({
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
      { fn: 'sendBootEvent', step: 'conversation_ready', detail: undefined, raw: undefined },
    ])
    expect(diagCalls[0]).toMatchObject({ type: 'conversation', msg: 'transition: boot (first-init)' })
  })

  test('first-init boot: no wsClient, opens a fresh connection', () => {
    const { ctx, wsCalls, connectCalls } = makeCtx({ hasWs: false })

    const t = observeClaudeSessionId(ctx, 'sess-abc', 'stream_json')

    expect(t.kind).toBe('boot')
    expect(connectCalls).toEqual(['sess-abc'])
    expect(wsCalls).toEqual([])
  })

  test('post-clear reset (hook fires first): sends conversation_reset, no CC session IDs', () => {
    const { ctx, wsCalls, diagCalls } = makeCtx({
      claudeSessionId: 'sess-old',
      pendingClearFromId: 'sess-old',
    })

    const t = observeClaudeSessionId(ctx, 'sess-new', 'hook', 'claude-opus-4-7')

    expect(t).toMatchObject({
      kind: 'rekey',
      reason: 'post-clear',
      from: 'sess-old',
      to: 'sess-new',
    })
    expect(ctx.claudeSessionId).toBe('sess-new')
    expect(ctx.pendingClearFromId).toBeNull()
    expect(wsCalls).toEqual([
      { fn: 'sendConversationReset', project: 'claude://default/test/cwd', model: 'claude-opus-4-7' },
      { fn: 'sendMetadataUpdate', metadata: { ccSessionId: 'sess-new' } },
      { fn: 'setSessionId', id: 'sess-new', source: 'hook' },
    ])
    expect(diagCalls.at(-1)).toMatchObject({ type: 'conversation', msg: 'transition: rekey (post-clear)' })
  })

  test('post-clear: onInit fires AFTER hook already reset -> confirm no-op', () => {
    const { ctx, wsCalls, diagCalls } = makeCtx({
      claudeSessionId: 'sess-new',
      pendingClearFromId: null,
    })

    const t = observeClaudeSessionId(ctx, 'sess-new', 'stream_json')

    expect(t).toMatchObject({
      kind: 'confirm',
      reason: 'duplicate',
      from: 'sess-new',
      to: 'sess-new',
    })
    expect(wsCalls).toEqual([])
    expect(diagCalls.at(-1)).toMatchObject({ type: 'conversation', msg: 'transition: confirm (duplicate)' })
  })

  test('post-clear: onInit fires BEFORE hook -> onInit does the reset', () => {
    const { ctx, wsCalls } = makeCtx({
      claudeSessionId: 'sess-old',
      pendingClearFromId: 'sess-old',
    })

    const t1 = observeClaudeSessionId(ctx, 'sess-new', 'stream_json')
    expect(t1.kind).toBe('rekey')
    expect(t1.reason).toBe('post-clear')
    expect(wsCalls).toEqual([
      { fn: 'sendConversationReset', project: 'claude://default/test/cwd', model: undefined },
      { fn: 'sendMetadataUpdate', metadata: { ccSessionId: 'sess-new' } },
      { fn: 'setSessionId', id: 'sess-new', source: 'stream_json' },
    ])

    // Hook then fires with the same id -- must no-op.
    const t2 = observeClaudeSessionId(ctx, 'sess-new', 'hook')
    expect(t2.kind).toBe('confirm')
    expect(wsCalls).toHaveLength(3) // no additional calls
  })

  test('unexpected reset (no pendingClearFromId, e.g. /resume or compaction)', () => {
    const { ctx, wsCalls } = makeCtx({ claudeSessionId: 'sess-old' })

    const t = observeClaudeSessionId(ctx, 'sess-new', 'hook')

    expect(t).toMatchObject({
      kind: 'rekey',
      reason: 'unexpected',
      from: 'sess-old',
      to: 'sess-new',
    })
    expect(wsCalls).toEqual([
      { fn: 'sendConversationReset', project: 'claude://default/test/cwd', model: undefined },
      { fn: 'sendMetadataUpdate', metadata: { ccSessionId: 'sess-new' } },
      { fn: 'setSessionId', id: 'sess-new', source: 'hook' },
    ])
  })

  test('reset tears down subagent watchers and resets task watcher', () => {
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
    expect(ctx.taskWatcher).toBeNull()
    expect(taskRestart).toBe(1)
    expect(projectRestart).toBe(1)
    expect(wsCalls).toHaveLength(3) // sendConversationReset + sendMetadataUpdate + setSessionId
  })

  test('reset with disconnected wsClient: skips send but still updates state', () => {
    const { ctx } = makeCtx({ claudeSessionId: 'sess-old', pendingClearFromId: 'sess-old' })
    ;(ctx.wsClient as { isConnected: () => boolean }).isConnected = () => false

    const t = observeClaudeSessionId(ctx, 'sess-new', 'hook')

    expect(t.kind).toBe('rekey')
    expect(ctx.claudeSessionId).toBe('sess-new')
    expect(ctx.pendingClearFromId).toBeNull()
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
