/**
 * Wire protocol integration tests -- feature-level scenarios.
 *
 * Companion to wire-protocol.test.ts (core lifecycle + shape validation).
 * Tests channels, subscriptions, heartbeat, dismiss, launch events,
 * HTTP API data contracts, and metadata updates.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestHarness, type TestHarness, testId } from './test-harness'

let h: TestHarness

beforeEach(() => {
  h = createTestHarness()
})

afterEach(() => {
  h.cleanup()
})

// ---------------------------------------------------------------------------
// Channel subscriptions
// ---------------------------------------------------------------------------

describe('channel subscriptions', () => {
  it('channel_subscribe sends ack back to subscriber', () => {
    const convId = testId('conv')
    h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })

    const dashboard = h.connectDashboard()
    dashboard.clearMessages()

    h.dashboardSend(dashboard, {
      type: 'channel_subscribe',
      channel: 'conversation:events',
      conversationId: convId,
    })

    const acks = dashboard.messagesOfType('channel_ack')
    expect(acks.length).toBe(1)
    expect(acks[0].channel).toBe('conversation:events')
    expect(acks[0].conversationId).toBe(convId)
    expect(acks[0].status).toBe('subscribed')
  })

  it('channel_unsubscribe sends ack with unsubscribed status', () => {
    const convId = testId('conv')
    h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })

    const dashboard = h.connectDashboard()
    h.dashboardSend(dashboard, {
      type: 'channel_subscribe',
      channel: 'conversation:events',
      conversationId: convId,
    })
    dashboard.clearMessages()

    h.dashboardSend(dashboard, {
      type: 'channel_unsubscribe',
      channel: 'conversation:events',
      conversationId: convId,
    })

    const acks = dashboard.messagesOfType('channel_ack')
    expect(acks.length).toBe(1)
    expect(acks[0].status).toBe('unsubscribed')
  })
})

// ---------------------------------------------------------------------------
// Multiple dashboard subscribers
// ---------------------------------------------------------------------------

describe('multiple subscribers', () => {
  it('conversation_update is broadcast to all dashboard subscribers', async () => {
    const dash1 = h.connectDashboard()
    const dash2 = h.connectDashboard()

    dash1.clearMessages()
    dash2.clearMessages()

    const convId = testId('conv')
    h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })

    await h.flushUpdates()

    const updates1 = dash1.messagesOfType('conversation_update')
    const updates2 = dash2.messagesOfType('conversation_update')
    expect(updates1.length).toBeGreaterThan(0)
    expect(updates2.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

describe('heartbeat', () => {
  it('heartbeat does not count as activity', async () => {
    const convId = testId('conv')
    const ccSessionId = testId('cc')

    const agent = h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })
    h.agentSend(agent, {
      type: 'meta',
      conversationId: convId,
      ccSessionId: ccSessionId,
      project: 'claude:///home/user/project',
      cwd: '/home/user/project',
      startedAt: Date.now(),
    })

    const conv = h.conversationStore.getConversation(ccSessionId)!
    const activityBefore = conv.lastActivity

    // Small delay to ensure timestamp would differ
    await new Promise(r => setTimeout(r, 20))

    h.agentSend(agent, {
      type: 'heartbeat',
      conversationId: convId,
      timestamp: Date.now(),
    })

    // lastActivity should NOT have changed from heartbeat
    expect(conv.lastActivity).toBe(activityBefore)
  })
})

// ---------------------------------------------------------------------------
// Dismiss ended conversation
// ---------------------------------------------------------------------------

describe('dismiss conversation', () => {
  it('dismiss_conversation removes an ended conversation', async () => {
    const convId = testId('conv')
    const ccSessionId = testId('cc')

    const agent = h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })
    h.agentSend(agent, {
      type: 'meta',
      conversationId: convId,
      ccSessionId: ccSessionId,
      project: 'claude:///home/user/project',
      cwd: '/home/user/project',
      startedAt: Date.now(),
    })
    h.agentSend(agent, {
      type: 'end',
      conversationId: ccSessionId,
      reason: 'done',
      endedAt: Date.now(),
    })

    await h.flushUpdates()

    expect(h.conversationStore.getConversation(ccSessionId)?.status).toBe('ended')

    const dashboard = h.connectDashboard()
    dashboard.clearMessages()

    h.dashboardSend(dashboard, {
      type: 'dismiss_conversation',
      conversationId: ccSessionId,
    })

    const result = dashboard.messagesOfType('dismiss_conversation_result')
    expect(result.length).toBe(1)
    expect(result[0].ok).toBe(true)

    expect(h.conversationStore.getConversation(ccSessionId)).toBeUndefined()
  })

  it('dismiss_conversation rejects active conversations', () => {
    const convId = testId('conv')
    const ccSessionId = testId('cc')

    const agent = h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })
    h.agentSend(agent, {
      type: 'meta',
      conversationId: convId,
      ccSessionId: ccSessionId,
      project: 'claude:///home/user/project',
      cwd: '/home/user/project',
      startedAt: Date.now(),
    })

    const dashboard = h.connectDashboard()
    h.dashboardSend(dashboard, {
      type: 'dismiss_conversation',
      conversationId: ccSessionId,
    })

    // GuardError replies use the message type directly (not _result suffix)
    const result = dashboard.messagesOfType('dismiss_conversation')
    expect(result.length).toBe(1)
    expect(result[0].ok).toBe(false)
    expect(result[0].error).toBe('Only ended conversations can be dismissed')
  })
})

// ---------------------------------------------------------------------------
// Launch events
// ---------------------------------------------------------------------------

describe('launch events', () => {
  it('launch_event appends to transcript', () => {
    const convId = testId('conv')

    const agent = h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })

    const dashboard = h.connectDashboard()
    h.dashboardSend(dashboard, {
      type: 'channel_subscribe',
      channel: 'conversation:transcript',
      conversationId: convId,
    })
    dashboard.clearMessages()

    h.agentSend(agent, {
      type: 'launch_event',
      conversationId: convId,
      launchId: testId('launch'),
      phase: 'initial',
      step: 'launch_started',
      detail: 'Starting CC',
      raw: { args: ['--headless'], cwd: '/home/user/project' },
      t: Date.now(),
    })

    const transcriptMsgs = dashboard.messagesOfType('transcript_entries')
    expect(transcriptMsgs.length).toBe(1)
    const entries = transcriptMsgs[0].entries as Array<Record<string, unknown>>
    expect(entries[0].type).toBe('launch')
    expect(entries[0].step).toBe('launch_started')
    expect(entries[0].phase).toBe('initial')
  })
})

// ---------------------------------------------------------------------------
// HTTP API data contracts (validates store data shapes)
// ---------------------------------------------------------------------------

describe('HTTP API data contracts', () => {
  it('getAllConversations returns correct shape for /conversations endpoint', () => {
    const convId = testId('conv')
    const ccSessionId = testId('cc')

    const agent = h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })
    h.agentSend(agent, {
      type: 'meta',
      conversationId: convId,
      ccSessionId: ccSessionId,
      project: 'claude:///home/user/project',
      cwd: '/home/user/project',
      startedAt: Date.now(),
      model: 'claude-sonnet-4-20250514',
    })

    const all = h.conversationStore.getAllConversations()
    expect(all.length).toBeGreaterThan(0)

    const conv = all.find(s => s.id === ccSessionId)
    expect(conv).toBeDefined()
    expect(conv?.id).toBe(ccSessionId)
    expect(conv?.project).toBe('claude:///home/user/project')
    expect(conv?.model).toBe('claude-sonnet-4-20250514')
    expect(typeof conv?.startedAt).toBe('number')
    expect(typeof conv?.lastActivity).toBe('number')
    expect(conv?.stats).toBeDefined()
  })

  it('getConversation returns conversation with expected fields', () => {
    const convId = testId('conv')
    const ccSessionId = testId('cc')

    const agent = h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })
    h.agentSend(agent, {
      type: 'meta',
      conversationId: convId,
      ccSessionId: ccSessionId,
      project: 'claude:///home/user/project',
      cwd: '/home/user/project',
      startedAt: Date.now(),
    })

    const conv = h.conversationStore.getConversation(ccSessionId)
    expect(conv).toBeDefined()
    expect(conv?.id).toBe(ccSessionId)
    expect(Array.isArray(conv?.events)).toBe(true)
    expect(Array.isArray(conv?.subagents)).toBe(true)
    expect(Array.isArray(conv?.tasks)).toBe(true)
    expect(Array.isArray(conv?.bgTasks)).toBe(true)
    expect(Array.isArray(conv?.monitors)).toBe(true)
    expect(Array.isArray(conv?.diagLog)).toBe(true)
  })

  it('getConversationEvents returns events for /conversations/:id/events', () => {
    const convId = testId('conv')
    const ccSessionId = testId('cc')

    const agent = h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })
    h.agentSend(agent, {
      type: 'meta',
      conversationId: convId,
      ccSessionId: ccSessionId,
      project: 'claude:///home/user/project',
      cwd: '/home/user/project',
      startedAt: Date.now(),
    })

    h.agentSend(agent, {
      type: 'hook',
      conversationId: ccSessionId,
      hookEvent: 'UserPromptSubmit',
      timestamp: Date.now(),
      data: { session_id: ccSessionId, prompt: 'Hello' },
    })

    h.agentSend(agent, {
      type: 'hook',
      conversationId: ccSessionId,
      hookEvent: 'Stop',
      timestamp: Date.now(),
      data: { session_id: ccSessionId, reason: 'completed' },
    })

    const events = h.conversationStore.getConversationEvents(ccSessionId)
    expect(events.length).toBe(2)
    expect(events[0].hookEvent).toBe('UserPromptSubmit')
    expect(events[1].hookEvent).toBe('Stop')
    expect(events[0].conversationId).toBe(ccSessionId)
  })

  it('getActiveConversations returns only non-ended conversations', () => {
    const agent1 = h.bootAgentHost({
      conversationId: testId('conv'),
      project: 'claude:///home/user/project1',
    })
    const cc1 = testId('cc')
    h.agentSend(agent1, {
      type: 'meta',
      conversationId: agent1.ws.data.conversationId!,
      ccSessionId: cc1,
      project: 'claude:///home/user/project1',
      cwd: '/home/user/project1',
      startedAt: Date.now(),
    })

    const agent2 = h.bootAgentHost({
      conversationId: testId('conv'),
      project: 'claude:///home/user/project2',
    })
    const cc2 = testId('cc')
    h.agentSend(agent2, {
      type: 'meta',
      conversationId: agent2.ws.data.conversationId!,
      ccSessionId: cc2,
      project: 'claude:///home/user/project2',
      cwd: '/home/user/project2',
      startedAt: Date.now(),
    })

    h.agentSend(agent2, {
      type: 'end',
      conversationId: cc2,
      reason: 'done',
      endedAt: Date.now(),
    })

    const active = h.conversationStore.getActiveConversations()
    const activeIds = active.map(s => s.id)
    expect(activeIds).toContain(cc1)
    expect(activeIds).not.toContain(cc2)
  })
})

// ---------------------------------------------------------------------------
// Conversation metadata updates
// ---------------------------------------------------------------------------

describe('conversation metadata updates', () => {
  it('session_name updates session title', async () => {
    const convId = testId('conv')
    const ccSessionId = testId('cc')

    const agent = h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })
    h.agentSend(agent, {
      type: 'meta',
      conversationId: convId,
      ccSessionId: ccSessionId,
      project: 'claude:///home/user/project',
      cwd: '/home/user/project',
      startedAt: Date.now(),
    })

    h.agentSend(agent, {
      type: 'session_name',
      conversationId: ccSessionId,
      name: 'My Test Session',
      description: 'Testing things',
    })

    await h.flushUpdates()

    const conv = h.conversationStore.getConversation(ccSessionId)
    expect(conv?.title).toBe('My Test Session')
    expect(conv?.description).toBe('Testing things')
  })

  it('session_name with userSet prevents auto-name overwrite', async () => {
    const convId = testId('conv')
    const ccSessionId = testId('cc')

    const agent = h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })
    h.agentSend(agent, {
      type: 'meta',
      conversationId: convId,
      ccSessionId: ccSessionId,
      project: 'claude:///home/user/project',
      cwd: '/home/user/project',
      startedAt: Date.now(),
    })

    h.agentSend(agent, {
      type: 'session_name',
      conversationId: ccSessionId,
      name: 'User Title',
      userSet: true,
    })

    h.agentSend(agent, {
      type: 'session_name',
      conversationId: ccSessionId,
      name: 'Auto Generated Title',
    })

    const conv = h.conversationStore.getConversation(ccSessionId)
    expect(conv?.title).toBe('User Title')
    expect(conv?.titleUserSet).toBe(true)
  })
})
