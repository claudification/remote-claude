import { describe, expect, it } from 'vitest'
import type { Session } from '@/lib/types'
import { partitionConversations } from './partition'

function makeConversation(overrides: Partial<Session>): Session {
  return {
    id: 'sess',
    cwd: '/cwd',
    status: 'idle',
    startedAt: 0,
    lastActivity: 0,
    eventCount: 0,
    activeSubagentCount: 0,
    totalSubagentCount: 0,
    subagents: [],
    taskCount: 0,
    pendingTaskCount: 0,
    activeTasks: [],
    pendingTasks: [],
    runningBgTaskCount: 0,
    bgTasks: [],
    teammates: [],
    ...overrides,
  } as Session
}

describe('partitionConversations', () => {
  it('returns empty arrays for empty input', () => {
    const result = partitionConversations([])
    expect(result).toEqual({ adhoc: [], normal: [], ended: [] })
  })

  it('routes sessions with ad-hoc capability into adhoc bucket', () => {
    const s = makeConversation({ id: 'a', capabilities: ['ad-hoc'] })
    expect(partitionConversations([s])).toEqual({ adhoc: [s], normal: [], ended: [] })
  })

  it('routes sessions without ad-hoc capability into normal bucket', () => {
    const s = makeConversation({ id: 'n', capabilities: ['headless'] })
    expect(partitionConversations([s])).toEqual({ adhoc: [], normal: [s], ended: [] })
  })

  it('treats missing capabilities as normal (not adhoc)', () => {
    const s = makeConversation({ id: 'm' })
    expect(partitionConversations([s])).toEqual({ adhoc: [], normal: [s], ended: [] })
  })

  it('ended conversations appear in the ended bucket AND in adhoc/normal by capability', () => {
    // `ended` is a status-based view for DismissAllEndedButton; it overlaps with
    // the capability buckets on purpose so both renderers see the conversation.
    const endedAdhoc = makeConversation({ id: 'ea', status: 'ended', capabilities: ['ad-hoc'] })
    const endedNormal = makeConversation({ id: 'en', status: 'ended' })
    const result = partitionConversations([endedAdhoc, endedNormal])
    expect(result.adhoc).toEqual([endedAdhoc])
    expect(result.normal).toEqual([endedNormal])
    expect(result.ended).toEqual([endedAdhoc, endedNormal])
  })

  it('partitions a mixed group once per conversation (no double-walk)', () => {
    const a1 = makeConversation({ id: 'a1', capabilities: ['ad-hoc'] })
    const a2 = makeConversation({ id: 'a2', capabilities: ['ad-hoc'], status: 'ended' })
    const n1 = makeConversation({ id: 'n1' })
    const n2 = makeConversation({ id: 'n2', status: 'ended' })
    const result = partitionConversations([a1, a2, n1, n2])
    expect(result.adhoc).toEqual([a1, a2])
    expect(result.normal).toEqual([n1, n2])
    expect(result.ended).toEqual([a2, n2])
  })

  it('preserves input order within each bucket', () => {
    const sessions = [
      makeConversation({ id: '1' }),
      makeConversation({ id: '2', capabilities: ['ad-hoc'] }),
      makeConversation({ id: '3' }),
      makeConversation({ id: '4', capabilities: ['ad-hoc'] }),
    ]
    const { adhoc, normal } = partitionConversations(sessions)
    expect(adhoc.map(s => s.id)).toEqual(['2', '4'])
    expect(normal.map(s => s.id)).toEqual(['1', '3'])
  })
})
