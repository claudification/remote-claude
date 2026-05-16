import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@/lib/types'
import { processEntry } from './process-entry'
import type { GroupingState } from './types'

function group(entries: TranscriptEntry[]): GroupingState {
  const state: GroupingState = { groups: [], current: null, pendingSkillName: undefined }
  for (const e of entries) processEntry(e, state)
  return state
}

function userEntry(content: string, opts: { isMeta?: boolean } = {}): TranscriptEntry {
  return {
    type: 'user',
    timestamp: '2026-05-16T21:20:00.000Z',
    message: { role: 'user', content },
    ...(opts.isMeta ? { isMeta: true } : {}),
  } as unknown as TranscriptEntry
}

describe('processEntry - Stop hook feedback', () => {
  it('routes a Stop hook feedback meta entry to a system group, not a user bubble', () => {
    const { groups } = group([
      userEntry('Stop hook feedback:\nIt looks like you have uncommitted work in this git repository:\n\n M a.ts', {
        isMeta: true,
      }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].type).toBe('system')
    expect(groups[0].systemSubtype).toBe('hook_feedback')
  })

  it('also catches SubagentStop hook feedback', () => {
    const { groups } = group([userEntry('SubagentStop hook feedback:\nFinish the task first.', { isMeta: true })])
    expect(groups[0]?.type).toBe('system')
    expect(groups[0]?.systemSubtype).toBe('hook_feedback')
  })

  it('leaves a real user message that merely mentions a hook as a user group', () => {
    const { groups } = group([userEntry('can you check the Stop hook feedback: behaviour?')])
    expect(groups[0]?.type).toBe('user')
  })

  it('does not reclassify a non-meta entry even if the text matches', () => {
    const { groups } = group([userEntry('Stop hook feedback:\nsome reason')])
    expect(groups[0]?.type).toBe('user')
  })
})
