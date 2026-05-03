/**
 * Wire protocol integration tests.
 *
 * Tests the full message flow between agent host, broker, and dashboard
 * using the actual handler infrastructure and conversation store. Only
 * the transport layer (WebSocket I/O) is mocked -- all handler logic,
 * state management, and broadcast behavior is real production code.
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
    expect(lastUpdate.session).toBeDefined()
    const session = lastUpdate.session as Record<string, unknown>
    expect(session.status).toBe('booting')
    expect(session.id).toBe(convId)
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
    expect(ack.eventId).toBe(ccSessionId)

    const conv = h.conversationStore.getConversation(ccSessionId)
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
      conversationId: ccSessionId,
      reason: 'user_quit',
      endedAt: Date.now(),
    })

    await h.flushUpdates()

    const conv = h.conversationStore.getConversation(ccSessionId)
    expect(conv).toBeDefined()
    expect(conv?.status).toBe('ended')
  })

  it('session_clear (rekey) migrates conversation to new ccSessionId', async () => {
    const convId = testId('conv')
    const oldCcSessionId = testId('old-cc')
    const newCcSessionId = testId('new-cc')

    const agent = h.bootAgentHost({
      conversationId: convId,
      project: 'claude:///home/user/project',
    })
    h.agentSend(agent, {
      type: 'meta',
      conversationId: convId,
      ccSessionId: oldCcSessionId,
      project: 'claude:///home/user/project',
      cwd: '/home/user/project',
      startedAt: Date.now(),
    })

    h.agentSend(agent, {
      type: 'session_clear',
      oldSessionId: oldCcSessionId,
      newSessionId: newCcSessionId,
      conversationId: convId,
      project: 'claude:///home/user/project',
    })

    await h.flushUpdates()

    // Old session should be gone (rekeyed)
    const oldConv = h.conversationStore.getConversation(oldCcSessionId)
    expect(oldConv).toBeUndefined()

    // New session should exist
    const newConv = h.conversationStore.getConversation(newCcSessionId)
    expect(newConv).toBeDefined()
    expect(newConv?.project).toBe('claude:///home/user/project')
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
      conversationId: ccSessionId,
      hookEvent: 'UserPromptSubmit',
      timestamp: Date.now(),
      data: { session_id: ccSessionId, prompt: 'Hello world' },
    })

    const events = h.conversationStore.getConversationEvents(ccSessionId)
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
      conversationId: ccSessionId,
      input: 'test input message',
    })

    const inputMsgs = agent.messagesOfType('input')
    expect(inputMsgs.length).toBe(1)
    expect(inputMsgs[0].input).toBe('test input message')
    expect(inputMsgs[0].conversationId).toBe(ccSessionId)
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
      conversationId: ccSessionId,
    })

    const interruptMsgs = agent.messagesOfType('interrupt')
    expect(interruptMsgs.length).toBe(1)
    expect(interruptMsgs[0].conversationId).toBe(ccSessionId)

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
      conversationId: ccSessionId,
    })
    dashboard.clearMessages()

    h.agentSend(agent, {
      type: 'transcript_entries',
      conversationId: ccSessionId,
      entries: [{ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: new Date().toISOString() }],
      isInitial: false,
    })

    const cached = h.conversationStore.getTranscriptEntries(ccSessionId)
    expect(cached.length).toBe(1)

    const transcriptMsgs = dashboard.messagesOfType('transcript_entries')
    expect(transcriptMsgs.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Session status signal
// ---------------------------------------------------------------------------

describe('session status signal', () => {
  it('session_status changes conversation status and broadcasts', async () => {
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
      type: 'session_status',
      conversationId: ccSessionId,
      status: 'active',
    })

    await h.flushUpdates()

    const conv = h.conversationStore.getConversation(ccSessionId)
    expect(conv?.status).toBe('active')

    const updates = dashboard.messagesOfType('conversation_update')
    expect(updates.length).toBeGreaterThan(0)
    const session = updates[updates.length - 1].session as Record<string, unknown>
    expect(session.status).toBe('active')
  })

  it('session_status idle -> active clears stale error', async () => {
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
    const conv = h.conversationStore.getConversation(ccSessionId)!
    conv.lastError = { stopReason: 'error', errorType: 'test', timestamp: Date.now() }

    h.agentSend(agent, {
      type: 'session_status',
      conversationId: ccSessionId,
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
    const sessions = listMsgs[0].sessions as Array<Record<string, unknown>>
    expect(sessions.length).toBeGreaterThan(0)

    for (const s of sessions) {
      // Every session in the list has an 'id' field (the conversationId)
      expect(s.id).toBeDefined()
      expect(typeof s.id).toBe('string')
      // ccSessionIds is an array (separate from the primary ID)
      expect(Array.isArray(s.ccSessionIds)).toBe(true)
    }
  })

  it('conversation_update broadcasts use conversationId as session.id', async () => {
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
      const session = update.session as Record<string, unknown>
      expect(session.id).toBeDefined()
      expect(typeof session.id).toBe('string')
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
      conversationId: ccSessionId,
      hookEvent: 'Stop',
      timestamp: Date.now(),
      data: { session_id: ccSessionId, reason: 'completed' },
    })

    // Hook events are stored against the ccSessionId (which is the routing key)
    const events = h.conversationStore.getConversationEvents(ccSessionId)
    expect(events.length).toBe(1)
    expect(events[0].conversationId).toBe(ccSessionId)
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
    const sessions = listMsgs[0].sessions as Array<Record<string, unknown>>
    const session = sessions.find(s => s.id === ccSessionId)
    expect(session).toBeDefined()
    expect(session?.stats).toBeDefined()
    const stats = session?.stats as Record<string, unknown>
    expect(typeof stats.totalInputTokens).toBe('number')
    expect(typeof stats.totalOutputTokens).toBe('number')
    expect(typeof stats.turnCount).toBe('number')
  })
})
