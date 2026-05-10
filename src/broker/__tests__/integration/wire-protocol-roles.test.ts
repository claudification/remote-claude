/**
 * Role-gating tests (Audit C3, H3, H4, H5, H7).
 *
 * Verifies that the message router rejects messages from connections
 * whose role isn't in the handler's allowed-role set:
 *   - Agent-host-only messages from a dashboard are rejected.
 *   - Dashboard-only messages from an agent host are rejected.
 *   - Sentinel result messages from a dashboard are rejected.
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

describe('role gating: agent-host-only messages', () => {
  it('rejects conversation_reset from a dashboard', () => {
    const convId = testId('conv')
    const ccSessionId = testId('cc')
    const agent = h.bootAgentHost({ conversationId: convId, project: 'claude:///home/user/project' })
    h.agentSend(agent, {
      type: 'meta',
      conversationId: convId,
      ccSessionId,
      project: 'claude:///home/user/project',
      cwd: '/home/user/project',
      startedAt: Date.now(),
    })

    const dashboard = h.connectDashboard()
    dashboard.clearMessages()

    h.dashboardSend(dashboard, { type: 'conversation_reset', conversationId: convId })

    const replies = dashboard.messagesOfType('conversation_reset_result')
    expect(replies.length).toBe(1)
    expect(replies[0].ok).toBe(false)
    expect(String(replies[0].error)).toContain('Forbidden')
  })

  it('rejects update_conversation_metadata from a dashboard', () => {
    const dashboard = h.connectDashboard()
    dashboard.clearMessages()

    h.dashboardSend(dashboard, {
      type: 'update_conversation_metadata',
      conversationId: testId('conv'),
      metadata: { ccSessionId: 'attacker-injected' },
    })

    const replies = dashboard.messagesOfType('update_conversation_metadata_result')
    expect(replies.length).toBe(1)
    expect(replies[0].ok).toBe(false)
  })

  it('rejects conversation_status from a dashboard', () => {
    const dashboard = h.connectDashboard()
    dashboard.clearMessages()

    h.dashboardSend(dashboard, {
      type: 'conversation_status',
      conversationId: testId('conv'),
      status: 'active',
    })

    const replies = dashboard.messagesOfType('conversation_status_result')
    expect(replies.length).toBe(1)
    expect(replies[0].ok).toBe(false)
  })

  it('rejects terminal_error from a dashboard', () => {
    const dashboard = h.connectDashboard()
    dashboard.clearMessages()

    h.dashboardSend(dashboard, {
      type: 'terminal_error',
      conversationId: testId('conv'),
      error: 'fake error',
    })

    const replies = dashboard.messagesOfType('terminal_error_result')
    expect(replies.length).toBe(1)
    expect(replies[0].ok).toBe(false)
  })

  it('rejects notify from a dashboard', () => {
    const dashboard = h.connectDashboard()
    dashboard.clearMessages()

    h.dashboardSend(dashboard, {
      type: 'notify',
      conversationId: testId('conv'),
      title: 'fake',
      message: 'spoofed',
    })

    const replies = dashboard.messagesOfType('notify_result')
    expect(replies.length).toBe(1)
    expect(replies[0].ok).toBe(false)
  })
})

describe('role gating: dashboard-only messages', () => {
  it('rejects send_input from an agent host', () => {
    const convId = testId('conv')
    const agent = h.bootAgentHost({ conversationId: convId, project: 'claude:///home/user/project' })
    agent.clearMessages()

    h.agentSend(agent, { type: 'send_input', conversationId: convId, content: 'spoofed' })

    const replies = agent.messagesOfType('send_input_result')
    expect(replies.length).toBe(1)
    expect(replies[0].ok).toBe(false)
  })

  it('rejects rename_conversation from an agent host', () => {
    const convId = testId('conv')
    const agent = h.bootAgentHost({ conversationId: convId, project: 'claude:///home/user/project' })
    agent.clearMessages()

    h.agentSend(agent, { type: 'rename_conversation', conversationId: convId, name: 'spoofed' })

    const replies = agent.messagesOfType('rename_conversation_result')
    expect(replies.length).toBe(1)
    expect(replies[0].ok).toBe(false)
  })
})

describe('role gating: positive cases (no regressions)', () => {
  it('accepts meta from an agent host', () => {
    const convId = testId('conv')
    const ccSessionId = testId('cc')
    const agent = h.bootAgentHost({ conversationId: convId, project: 'claude:///home/user/project' })
    agent.clearMessages()

    h.agentSend(agent, {
      type: 'meta',
      conversationId: convId,
      ccSessionId,
      project: 'claude:///home/user/project',
      cwd: '/home/user/project',
      startedAt: Date.now(),
    })

    // No protocol_upgrade_required, no _result rejection.
    expect(agent.messagesOfType('meta_result').length).toBe(0)
    expect(agent.messagesOfType('protocol_upgrade_required').length).toBe(0)
    // Successful meta produces an ack
    expect(agent.messagesOfType('ack').length).toBeGreaterThanOrEqual(1)
  })

  it('accepts subscribe from a dashboard', () => {
    const dashboard = h.connectDashboard()
    // connectDashboard already sent subscribe -- it should NOT have received a rejection
    expect(dashboard.messagesOfType('subscribe_result').filter(m => m.ok === false).length).toBe(0)
  })
})
