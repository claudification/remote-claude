/**
 * Wire protocol integration tests.
 *
 * Tests the full message flow between agent host, broker, and dashboard
 * using the actual handler infrastructure and conversation store. Only
 * the transport layer (WebSocket I/O) is mocked -- all handler logic,
 * state management, and broadcast behavior is real production code.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createTestHarness, type TestHarness, testId } from './test-harness'

let h: TestHarness

beforeEach(() => {
  h = createTestHarness()
})

afterEach(() => {
  h.cleanup()
})

// ---------------------------------------------------------------------------
// 1. Conversation lifecycle
// ---------------------------------------------------------------------------

describe('conversation lifecycle', () => {
  it('wrapper_boot creates a booting conversation visible to the dashboard', async () => {
    const dashboard = h.connectDashboard()
    dashboard.clearMessages()

    const convId = testId('conv')
    h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/myproject',
    })

    await h.flushUpdates()

    const conv = h.conversationStore.getConversation(convId)
    expect(conv).toBeDefined()
    expect(conv?.status).toBe('booting')
    expect(conv?.project).toBe('claude:///home/user/myproject')

    const updates = dashboard.messagesOfType('conversation_update')
    expect(updates.length).toBeGreaterThan(0)
    const lastUpdate = updates[updates.length - 1]
    expect(lastUpdate.conversation).toBeDefined()
    const broadcast = lastUpdate.conversation as Record<string, unknown>
    expect(broadcast.status).toBe('booting')
    expect(broadcast.id).toBe(convId)
  })

  it('meta after wrapper_boot promotes the conversation and broadcasts update', async () => {
    const dashboard = h.connectDashboard()
    const convId = testId('conv')
    const ccSessionId = testId('cc')

    const agent = h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })

    dashboard.clearMessages()

    h.agentSend(agent, {
      type: 'meta',
      conversationId: convId,
      ccSessionId: ccSessionId,
      project: 'claude:///home/user/project',
      cwd: '/home/user/project',
      startedAt: Date.now(),
      model: 'claude-sonnet-4-20250514',
    })

    await h.flushUpdates()

    const acks = agent.messagesOfType('ack')
    expect(acks.length).toBeGreaterThanOrEqual(1)
    const ack = acks[acks.length - 1]
    expect(ack.eventId).toBe(convId)

    const conv = h.conversationStore.getConversation(convId)
    expect(conv).toBeDefined()
    expect(conv?.project).toBe('claude:///home/user/project')

    const updates = dashboard.messagesOfType('conversation_update')
    expect(updates.length).toBeGreaterThan(0)
  })

  it('end message ends the conversation and broadcasts update', async () => {
    const dashboard = h.connectDashboard()
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

    await h.flushUpdates()
    dashboard.clearMessages()

    h.agentSend(agent, {
      type: 'end',
      conversationId: convId,
      reason: 'user_quit',
      endedAt: Date.now(),
    })

    await h.flushUpdates()

    const conv = h.conversationStore.getConversation(convId)
    expect(conv).toBeDefined()
    expect(conv?.status).toBe('ended')
  })

  it('conversation_reset wipes ephemeral state, keeps conversation under same key', async () => {
    const convId = testId('conv')

    const agent = h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })
    h.agentSend(agent, {
      type: 'meta',
      conversationId: convId,
      ccSessionId: testId('cc'),
      project: 'claude:///home/user/project',
      cwd: '/home/user/project',
      startedAt: Date.now(),
    })

    h.agentSend(agent, {
      type: 'conversation_reset',
      conversationId: convId,
      project: 'claude:///home/user/project',
    })

    await h.flushUpdates()

    // Conversation stays under the same key (conversationId)
    const conv = h.conversationStore.getConversation(convId)
    expect(conv).toBeDefined()
    expect(conv?.id).toBe(convId)
    expect(conv?.project).toBe('claude:///home/user/project')
    expect(conv?.events).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Message routing
// ---------------------------------------------------------------------------

describe('message routing', () => {
  it('hook event from agent host is stored on the conversation', async () => {
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
      conversationId: convId,
      hookEvent: 'UserPromptSubmit',
      timestamp: Date.now(),
      data: { conversation_id: ccSessionId, prompt: 'Hello world' },
    })

    const events = h.conversationStore.getConversationEvents(convId)
    expect(events.length).toBe(1)
    expect(events[0].hookEvent).toBe('UserPromptSubmit')
  })

  it('send_input from dashboard is forwarded to agent host', async () => {
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

    agent.clearMessages()

    const dashboard = h.connectDashboard()
    h.dashboardSend(dashboard, {
      type: 'send_input',
      conversationId: convId,
      input: 'test input message',
    })

    const inputMsgs = agent.messagesOfType('input')
    expect(inputMsgs.length).toBe(1)
    expect(inputMsgs[0].input).toBe('test input message')
    expect(inputMsgs[0].conversationId).toBe(convId)
  })

  it('send_interrupt from dashboard is forwarded to agent host', async () => {
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

    agent.clearMessages()

    const dashboard = h.connectDashboard()
    h.dashboardSend(dashboard, {
      type: 'send_interrupt',
      conversationId: convId,
    })

    const interruptMsgs = agent.messagesOfType('interrupt')
    expect(interruptMsgs.length).toBe(1)
    expect(interruptMsgs[0].conversationId).toBe(convId)

    // Verify dashboard gets a result
    const results = dashboard.messagesOfType('send_interrupt_result')
    expect(results.length).toBe(1)
    expect(results[0].ok).toBe(true)
  })

  it('boot_event appends to transcript and broadcasts to channel subscribers', async () => {
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
      type: 'boot_event',
      conversationId: convId,
      step: 'claude_spawning',
      detail: 'Spawning Claude Code',
      t: Date.now(),
    })

    const transcriptMsgs = dashboard.messagesOfType('transcript_entries')
    expect(transcriptMsgs.length).toBe(1)
    const entries = transcriptMsgs[0].entries as Array<Record<string, unknown>>
    expect(entries.length).toBe(1)
    expect(entries[0].type).toBe('boot')
    expect(entries[0].step).toBe('claude_spawning')
  })

  it('transcript_entries from agent host are cached and broadcast', async () => {
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
      type: 'channel_subscribe',
      channel: 'conversation:transcript',
      conversationId: convId,
    })
    dashboard.clearMessages()

    h.agentSend(agent, {
      type: 'transcript_entries',
      conversationId: convId,
      entries: [{ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: new Date().toISOString() }],
      isInitial: false,
    })

    const cached = h.conversationStore.getTranscriptEntries(convId)
    expect(cached.length).toBe(1)

    const transcriptMsgs = dashboard.messagesOfType('transcript_entries')
    expect(transcriptMsgs.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Conversation status signal
// ---------------------------------------------------------------------------

describe('conversation status signal', () => {
  it('conversation_status changes conversation status and broadcasts', async () => {
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
    dashboard.clearMessages()

    h.agentSend(agent, {
      type: 'conversation_status',
      conversationId: convId,
      status: 'active',
    })

    await h.flushUpdates()

    const conv = h.conversationStore.getConversation(convId)
    expect(conv?.status).toBe('active')

    const updates = dashboard.messagesOfType('conversation_update')
    expect(updates.length).toBeGreaterThan(0)
    const convUpdate = updates[updates.length - 1].conversation as Record<string, unknown>
    expect(convUpdate.status).toBe('active')
  })

  it('conversation_status idle -> active clears stale error', async () => {
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

    // Manually inject a lastError
    const conv = h.conversationStore.getConversation(convId)!
    conv.lastError = { stopReason: 'error', errorType: 'test', timestamp: Date.now() }

    h.agentSend(agent, {
      type: 'conversation_status',
      conversationId: convId,
      status: 'active',
    })

    expect(conv.lastError).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. Wire protocol shape validation
// ---------------------------------------------------------------------------

describe('wire protocol shape', () => {
  it('conversations_list uses conversationId, not bare sessionId', async () => {
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

    const listMsgs = dashboard.messagesOfType('conversations_list')
    expect(listMsgs.length).toBe(1)
    const conversations = listMsgs[0].conversations as Array<Record<string, unknown>>
    expect(conversations.length).toBeGreaterThan(0)

    for (const s of conversations) {
      expect(s.id).toBeDefined()
      expect(typeof s.id).toBe('string')
      expect(Array.isArray(s.connectionIds)).toBe(true)
    }
  })

  it('conversation_update broadcasts use conversationId as conversation.id', async () => {
    const dashboard = h.connectDashboard()
    dashboard.clearMessages()

    const convId = testId('conv')
    h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })

    await h.flushUpdates()

    const updates = dashboard.messagesOfType('conversation_update')
    for (const update of updates) {
      const convPayload = update.conversation as Record<string, unknown>
      expect(convPayload.id).toBeDefined()
      expect(typeof convPayload.id).toBe('string')
    }
  })

  it('hook event uses conversationId (not sessionId) as the routing key', () => {
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
      conversationId: convId,
      hookEvent: 'Stop',
      timestamp: Date.now(),
      data: { conversation_id: ccSessionId, reason: 'completed' },
    })

    // Hook events are stored against the conversationId (the store's primary key)
    const events = h.conversationStore.getConversationEvents(convId)
    expect(events.length).toBe(1)
    expect(events[0].conversationId).toBe(convId)
  })

  it('meta ack includes origins array', () => {
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

    const ack = agent.messagesOfType('ack')
    expect(ack.length).toBeGreaterThanOrEqual(1)
    const lastAck = ack[ack.length - 1]
    expect(lastAck.origins).toBeDefined()
    expect(Array.isArray(lastAck.origins)).toBe(true)
  })

  it('ConversationSummary contains stats object', async () => {
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
    const listMsgs = dashboard.messagesOfType('conversations_list')
    const conversations = listMsgs[0].conversations as Array<Record<string, unknown>>
    const target = conversations.find(s => s.id === convId)
    expect(target).toBeDefined()
    expect(target?.stats).toBeDefined()
    const stats = target?.stats as Record<string, unknown>
    expect(typeof stats.totalInputTokens).toBe('number')
    expect(typeof stats.totalOutputTokens).toBe('number')
    expect(typeof stats.turnCount).toBe('number')
  })
})
