/**
 * Integration tests for inter-session messaging (channel_list_conversations + channel_send).
 *
 * These tests verify that:
 * 1. Sessions can discover each other via list_conversations
 * 2. send_message works WITHOUT a prior list_conversations call
 * 3. send_message survives conversation_clear (rekey) -- the exact regression
 * 4. Compound project:session-slug routing works
 * 5. Unknown targets produce clean errors
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createTestHarness, type TestHarness, testId } from './test-harness'

describe('inter-session messaging', () => {
  let h: TestHarness

  beforeEach(() => {
    h = createTestHarness()
  })
  afterEach(() => h.cleanup())

  /** Boot + promote a fully registered session, with open trust for messaging */
  function bootAndPromote(opts: { conversationId: string; sessionId: string; project: string }) {
    h.setProjectSettings(opts.project, { trustLevel: 'open' })
    const agent = h.bootAgentHost({
      conversationId: opts.conversationId,
      project: opts.project,
    })
    h.agentSend(agent, {
      type: 'meta',
      conversationId: opts.conversationId,
      ccSessionId: opts.sessionId,
      project: opts.project,
      cwd: opts.project.replace('claude://', ''),
      startedAt: Date.now(),
      model: 'claude-sonnet-4-20250514',
    })
    return agent
  }

  describe('channel_list_conversations', () => {
    it('returns other conversations', async () => {
      const sessionA = testId('sess-a')
      const sessionB = testId('sess-b')
      const convA = testId('conv-a')
      const convB = testId('conv-b')

      const agentA = bootAndPromote({
        conversationId: convA,
        sessionId: sessionA,
        project: 'claude:///home/user/project-alpha',
      })
      bootAndPromote({
        conversationId: convB,
        sessionId: sessionB,
        project: 'claude:///home/user/project-beta',
      })

      await h.flushUpdates()

      h.agentSend(agentA, { type: 'channel_list_conversations' })
      const result = agentA.messagesOfType('channel_conversations_list')
      expect(result.length).toBe(1)

      const sessions = result[0].conversations as Array<{ id: string; project: string }>
      expect(sessions.length).toBeGreaterThanOrEqual(1)

      const found = sessions.find(s => s.project?.includes('project-beta'))
      expect(found).toBeDefined()
      expect(found?.id).toBeTruthy()
    })

    it('includes self with self: true annotation', async () => {
      const sessionA = testId('sess-a')
      const convA = testId('conv-a')

      const agentA = bootAndPromote({
        conversationId: convA,
        sessionId: sessionA,
        project: 'claude:///home/user/project-alpha',
      })

      await h.flushUpdates()

      h.agentSend(agentA, { type: 'channel_list_conversations' })
      const result = agentA.messagesOfType('channel_conversations_list')
      expect(result.length).toBe(1)

      const sessions = result[0].conversations as Array<{ id: string; conversation_id: string; self?: boolean }>
      const selfEntry = sessions.find(s => s.conversation_id === convA)
      expect(selfEntry).toBeDefined()
      expect(selfEntry?.self).toBe(true)
    })
  })

  describe('channel_send', () => {
    it('delivers message without prior list_conversations', async () => {
      const sessionA = testId('sess-a')
      const sessionB = testId('sess-b')
      const convA = testId('conv-a')
      const convB = testId('conv-b')

      const agentA = bootAndPromote({
        conversationId: convA,
        sessionId: sessionA,
        project: 'claude:///home/user/project-alpha',
      })
      const agentB = bootAndPromote({
        conversationId: convB,
        sessionId: sessionB,
        project: 'claude:///home/user/project-beta',
      })

      await h.flushUpdates()

      // A sends to B using the project slug -- NO list_conversations first
      h.agentSend(agentA, {
        type: 'channel_send',
        toSession: 'project-beta',
        intent: 'request',
        message: 'Hello from A',
      })

      const sendResult = agentA.messagesOfType('channel_send_result')
      expect(sendResult.length).toBe(1)
      expect(sendResult[0].ok).toBe(true)
      expect(sendResult[0].status).toBe('delivered')

      // B should have received the message
      const delivered = agentB.messagesOfType('channel_deliver')
      expect(delivered.length).toBe(1)
      expect(delivered[0].message).toBe('Hello from A')
      expect(delivered[0].intent).toBe('request')
    })

    it('works after conversation_reset -- the regression', async () => {
      const sessionA = testId('sess-a')
      const sessionB = testId('sess-b')
      const convA = testId('conv-a')
      const convB = testId('conv-b')

      const agentA = bootAndPromote({
        conversationId: convA,
        sessionId: sessionA,
        project: 'claude:///home/user/project-alpha',
      })
      const agentB = bootAndPromote({
        conversationId: convB,
        sessionId: sessionB,
        project: 'claude:///home/user/project-beta',
      })

      await h.flushUpdates()

      // Simulate /clear on conversation A -- resets ephemeral state
      h.agentSend(agentA, {
        type: 'conversation_reset',
        conversationId: convA,
        project: 'claude:///home/user/project-alpha',
      })

      await h.flushUpdates()

      // A sends to B AFTER the rekey
      h.agentSend(agentA, {
        type: 'channel_send',
        toSession: 'project-beta',
        intent: 'notify',
        message: 'Still alive after clear',
      })

      const sendResult = agentA.messagesOfType('channel_send_result')
      const lastResult = sendResult[sendResult.length - 1]
      expect(lastResult.ok).toBe(true)
      expect(lastResult.error).toBeUndefined()

      const delivered = agentB.messagesOfType('channel_deliver')
      expect(delivered.length).toBe(1)
      expect(delivered[0].message).toBe('Still alive after clear')
    })

    it('returns error for unknown target', async () => {
      const sessionA = testId('sess-a')
      const convA = testId('conv-a')

      const agentA = bootAndPromote({
        conversationId: convA,
        sessionId: sessionA,
        project: 'claude:///home/user/project-alpha',
      })

      await h.flushUpdates()

      h.agentSend(agentA, {
        type: 'channel_send',
        toSession: 'nonexistent-project',
        intent: 'request',
        message: 'Hello?',
      })

      const sendResult = agentA.messagesOfType('channel_send_result')
      expect(sendResult.length).toBe(1)
      expect(sendResult[0].ok).toBe(false)
      expect(sendResult[0].error).toBeTruthy()
    })

    it('delivers to compound project:session-slug target', async () => {
      const sessionA = testId('sess-a')
      const sessionB = testId('sess-b')
      const convA = testId('conv-a')
      const convB = testId('conv-b')

      const agentA = bootAndPromote({
        conversationId: convA,
        sessionId: sessionA,
        project: 'claude:///home/user/project-alpha',
      })
      const agentB = bootAndPromote({
        conversationId: convB,
        sessionId: sessionB,
        project: 'claude:///home/user/project-beta',
      })

      await h.flushUpdates()

      // First, list_conversations to get the compound ID
      h.agentSend(agentA, { type: 'channel_list_conversations' })
      const listResult = agentA.messagesOfType('channel_conversations_list')
      const sessions = listResult[0].conversations as Array<{ id: string }>
      const betaSession = sessions.find(s => s.id?.includes('project-beta'))
      expect(betaSession).toBeDefined()

      // Send using the compound ID from list_conversations
      h.agentSend(agentA, {
        type: 'channel_send',
        toSession: betaSession?.id,
        intent: 'request',
        message: 'Via compound ID',
      })

      const sendResult = agentA.messagesOfType('channel_send_result')
      const lastResult = sendResult[sendResult.length - 1]
      expect(lastResult.ok).toBe(true)

      const delivered = agentB.messagesOfType('channel_deliver')
      expect(delivered.length).toBe(1)
      expect(delivered[0].message).toBe('Via compound ID')
    })

    it('works bidirectionally', async () => {
      const sessionA = testId('sess-a')
      const sessionB = testId('sess-b')
      const convA = testId('conv-a')
      const convB = testId('conv-b')

      const agentA = bootAndPromote({
        conversationId: convA,
        sessionId: sessionA,
        project: 'claude:///home/user/project-alpha',
      })
      const agentB = bootAndPromote({
        conversationId: convB,
        sessionId: sessionB,
        project: 'claude:///home/user/project-beta',
      })

      await h.flushUpdates()

      // A -> B
      h.agentSend(agentA, {
        type: 'channel_send',
        toSession: 'project-beta',
        intent: 'request',
        message: 'A to B',
      })

      // B -> A
      h.agentSend(agentB, {
        type: 'channel_send',
        toSession: 'project-alpha',
        intent: 'response',
        message: 'B to A',
      })

      const deliveredToB = agentB.messagesOfType('channel_deliver')
      expect(deliveredToB.length).toBe(1)
      expect(deliveredToB[0].message).toBe('A to B')

      const deliveredToA = agentA.messagesOfType('channel_deliver')
      expect(deliveredToA.length).toBe(1)
      expect(deliveredToA[0].message).toBe('B to A')
    })
  })

  describe('pre-boot spawn discoverability', () => {
    // Regression: spawn_session returns a jobId but the spawned conversation
    // was invisible to list_conversations and unreachable via send_message
    // until the agent host finished booting (10-30s gap). Bug filed
    // 2026-05-11. Fix: surface active spawn jobs as `status: "spawning"`.
    it('list_conversations surfaces in-flight spawn jobs as status="spawning"', async () => {
      const callerConv = testId('caller')
      const pendingConv = testId('pending')
      const pendingJob = testId('job')

      // Caller is a normal booted agent host
      const agent = bootAndPromote({
        conversationId: callerConv,
        sessionId: testId('sess'),
        project: 'claude:///home/user/project-caller',
      })

      // Simulate spawn-dispatch: a job is created with a reserved conversationId,
      // and the resolved config is recorded -- but no agent host has connected yet.
      h.conversationStore.createJob(pendingJob, pendingConv)
      h.conversationStore.recordJobConfig(pendingJob, {
        cwd: '/home/user/project-target',
        name: 'launch-profiles',
      })

      await h.flushUpdates()

      h.agentSend(agent, { type: 'channel_list_conversations', status: 'all' })
      const result = agent.messagesOfType('channel_conversations_list')
      expect(result.length).toBeGreaterThanOrEqual(1)

      type Row = { conversation_id: string; status: string; name: string; spawnJobId?: string }
      const sessions = result[result.length - 1].conversations as Row[]
      const spawning = sessions.find(s => s.conversation_id === pendingConv)
      expect(spawning).toBeDefined()
      expect(spawning?.status).toBe('spawning')
      expect(spawning?.spawnJobId).toBe(pendingJob)
      expect(spawning?.name).toBe('launch-profiles')
    })

    it('send_message to a pending spawn conversationId queues instead of erroring', async () => {
      const callerConv = testId('caller')
      const pendingConv = testId('pending')
      const pendingJob = testId('job')
      let queued = false

      const agent = bootAndPromote({
        conversationId: callerConv,
        sessionId: testId('sess'),
        project: 'claude:///home/user/project-caller',
      })

      // Spy on the message queue
      const origEnqueue = h.messageQueueEnqueue
      h.messageQueueEnqueue = () => {
        queued = true
      }

      h.conversationStore.createJob(pendingJob, pendingConv)
      h.conversationStore.recordJobConfig(pendingJob, {
        cwd: '/home/user/project-target',
        name: 'launch-profiles',
      })

      h.agentSend(agent, {
        type: 'channel_send',
        toSession: pendingConv,
        intent: 'request',
        message: 'queued for boot',
      })

      const sendResult = agent.messagesOfType('channel_send_result')
      const last = sendResult[sendResult.length - 1]
      expect(last?.ok).toBe(true)
      expect(last?.status).toBe('queued')
      expect(queued).toBe(true)

      h.messageQueueEnqueue = origEnqueue
    })

    // Regression: bug-spawn-session-not-discoverable (the deeper bug).
    // A conversation registered with a malformed project URI used to throw
    // from parseProjectUri inside the per-row map, the router replied with a
    // type the agent host doesn't listen for, and every list_conversations
    // call timed out at 5s returning empty `[]` -- even when ~20 healthy
    // conversations existed in the store. The list must survive bad rows.
    it('one malformed-URI conversation does not poison list_conversations', async () => {
      const callerConv = testId('caller')
      const healthyConv = testId('healthy')
      const badConv = testId('bad')

      const agent = bootAndPromote({
        conversationId: callerConv,
        sessionId: testId('sess'),
        project: 'claude:///home/user/project-caller',
      })

      // Register a healthy peer
      bootAndPromote({
        conversationId: healthyConv,
        sessionId: testId('sess'),
        project: 'claude:///home/user/project-healthy',
      })

      // Manually create a conversation with a malformed project URI -- this
      // simulates a backend that allocates URIs from human-readable labels
      // (e.g. `chat://Mistral Dophin`). createConversation accepts whatever
      // it's given; the store has no URI-shape check.
      h.conversationStore.createConversation(badConv, 'chat://Mistral Dophin')

      await h.flushUpdates()

      h.agentSend(agent, { type: 'channel_list_conversations', status: 'all' })
      const result = agent.messagesOfType('channel_conversations_list')
      expect(result.length).toBe(1) // handler MUST reply, not timeout

      type Row = { conversation_id: string; status: string }
      const sessions = result[0].conversations as Row[]
      const ids = sessions.map(s => s.conversation_id)
      expect(ids).toContain(healthyConv) // healthy peer is visible
      expect(ids).toContain(callerConv) // caller's row is visible
      // The bad row may or may not appear (depends on whether the tolerant
      // parse succeeds for it). What matters is the rest of the list survives.
    })

    it('completed jobs are not surfaced as spawning rows', async () => {
      const callerConv = testId('caller')
      const pendingConv = testId('pending')
      const pendingJob = testId('job')

      const agent = bootAndPromote({
        conversationId: callerConv,
        sessionId: testId('sess'),
        project: 'claude:///home/user/project-caller',
      })

      h.conversationStore.createJob(pendingJob, pendingConv)
      h.conversationStore.recordJobConfig(pendingJob, {
        cwd: '/home/user/project-target',
        name: 'finished-worker',
      })
      // Mark the job complete (agent host booted)
      h.conversationStore.completeJob(pendingConv, pendingConv)

      await h.flushUpdates()

      h.agentSend(agent, { type: 'channel_list_conversations', status: 'all' })
      const result = agent.messagesOfType('channel_conversations_list')
      type Row = { conversation_id: string; status: string }
      const sessions = result[result.length - 1].conversations as Row[]
      const stillSpawning = sessions.find(s => s.conversation_id === pendingConv && s.status === 'spawning')
      expect(stillSpawning).toBeUndefined()
    })
  })
})
