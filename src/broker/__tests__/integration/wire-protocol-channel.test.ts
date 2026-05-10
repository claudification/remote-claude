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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
})
