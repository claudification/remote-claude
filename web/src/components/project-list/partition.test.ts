import { describe, expect, it } from 'vitest'
import type { Session } from '@/lib/types'
import { partitionSessions } from './partition'

function makeSession(overrides: Partial<Session>): Session {
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

describe('partitionSessions', () => {
  it('returns empty arrays for empty input', () => {
    const result = partitionSessions([])
    expect(result).toEqual({ adhoc: [], normal: [], ended: [] })
  })

  it('routes sessions with ad-hoc capability into adhoc bucket', () => {
    const s = makeSession({ id: 'a', capabilities: ['ad-hoc'] })
    expect(partitionSessions([s])).toEqual({ adhoc: [s], normal: [], ended: [] })
  })

  it('routes sessions without ad-hoc capability into normal bucket', () => {
    const s = makeSession({ id: 'n', capabilities: ['headless'] })
    expect(partitionSessions([s])).toEqual({ adhoc: [], normal: [s], ended: [] })
  })

  it('treats missing capabilities as normal (not adhoc)', () => {
    const s = makeSession({ id: 'm' })
    expect(partitionSessions([s])).toEqual({ adhoc: [], normal: [s], ended: [] })
  })

  it('ended sessions appear in the ended bucket AND in adhoc/normal by capability', () => {
    // `ended` is a status-based view for DismissAllEndedButton; it overlaps with
    // the capability buckets on purpose so both renderers see the session.
    const endedAdhoc = makeSession({ id: 'ea', status: 'ended', capabilities: ['ad-hoc'] })
    const endedNormal = makeSession({ id: 'en', status: 'ended' })
    const result = partitionSessions([endedAdhoc, endedNormal])
    expect(result.adhoc).toEqual([endedAdhoc])
    expect(result.normal).toEqual([endedNormal])
    expect(result.ended).toEqual([endedAdhoc, endedNormal])
  })

  it('partitions a mixed group once per session (no double-walk)', () => {
    const a1 = makeSession({ id: 'a1', capabilities: ['ad-hoc'] })
    const a2 = makeSession({ id: 'a2', capabilities: ['ad-hoc'], status: 'ended' })
    const n1 = makeSession({ id: 'n1' })
    const n2 = makeSession({ id: 'n2', status: 'ended' })
    const result = partitionSessions([a1, a2, n1, n2])
    expect(result.adhoc).toEqual([a1, a2])
    expect(result.normal).toEqual([n1, n2])
    expect(result.ended).toEqual([a2, n2])
  })

  it('preserves input order within each bucket', () => {
    const sessions = [
      makeSession({ id: '1' }),
      makeSession({ id: '2', capabilities: ['ad-hoc'] }),
      makeSession({ id: '3' }),
      makeSession({ id: '4', capabilities: ['ad-hoc'] }),
    ]
    const { adhoc, normal } = partitionSessions(sessions)
    expect(adhoc.map(s => s.id)).toEqual(['2', '4'])
    expect(normal.map(s => s.id)).toEqual(['1', '3'])
  })
})
