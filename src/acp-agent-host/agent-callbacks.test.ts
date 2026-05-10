import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decidePermission, handleFsRead, handleFsWrite, pickOptionId } from './agent-callbacks'

describe('decidePermission', () => {
  const bash = { toolCallId: '1', kind: 'execute', title: 'bash' }
  const read = { toolCallId: '2', kind: 'read', title: 'read' }
  const search = { toolCallId: '3', kind: 'search', title: 'grep' }
  const fetch = { toolCallId: '4', kind: 'fetch', title: 'webfetch' }
  const edit = { toolCallId: '5', kind: 'edit', title: 'write' }
  const noKind = { toolCallId: '6' }

  it('full tier allows everything', () => {
    expect(decidePermission('full', bash).outcome).toEqual({ outcome: 'selected', optionId: 'once' })
    expect(decidePermission('full', edit).outcome).toEqual({ outcome: 'selected', optionId: 'once' })
    expect(decidePermission('full', noKind).outcome).toEqual({ outcome: 'selected', optionId: 'once' })
  })

  it('none tier rejects everything', () => {
    expect(decidePermission('none', read).outcome).toEqual({ outcome: 'selected', optionId: 'reject' })
    expect(decidePermission('none', bash).outcome).toEqual({ outcome: 'selected', optionId: 'reject' })
  })

  it('safe tier allows read-family', () => {
    expect(decidePermission('safe', read).outcome).toEqual({ outcome: 'selected', optionId: 'once' })
    expect(decidePermission('safe', search).outcome).toEqual({ outcome: 'selected', optionId: 'once' })
    expect(decidePermission('safe', fetch).outcome).toEqual({ outcome: 'selected', optionId: 'once' })
  })

  it('safe tier rejects mutating tools', () => {
    expect(decidePermission('safe', bash).outcome).toEqual({ outcome: 'selected', optionId: 'reject' })
    expect(decidePermission('safe', edit).outcome).toEqual({ outcome: 'selected', optionId: 'reject' })
  })

  it('safe tier rejects delete and move kinds', () => {
    expect(decidePermission('safe', { toolCallId: 'd', kind: 'delete' }).outcome).toEqual({ outcome: 'selected', optionId: 'reject' })
    expect(decidePermission('safe', { toolCallId: 'm', kind: 'move' }).outcome).toEqual({ outcome: 'selected', optionId: 'reject' })
  })

  it('safe tier ALLOWS unknown / other kinds (deny-list, not allow-list)', () => {
    // OpenCode emits kind: 'other' for glob/ls -- legit read-family tools.
    // Allow them; only reject the explicitly mutating subset.
    expect(decidePermission('safe', { toolCallId: 'o', kind: 'other' }).outcome).toEqual({ outcome: 'selected', optionId: 'once' })
    expect(decidePermission('safe', { toolCallId: 'u', kind: 'unknown_future_kind' }).outcome).toEqual({ outcome: 'selected', optionId: 'once' })
  })

  it('safe tier allows when kind is missing (recipe preamble is the gate)', () => {
    // The recipe.prepare() preamble only opts known mutating tools into
    // session/request_permission. If something arrives with no kind it
    // means the agent already considered it allowed under its own policy.
    expect(decidePermission('safe', noKind).outcome).toEqual({ outcome: 'selected', optionId: 'once' })
  })
})

describe('pickOptionId', () => {
  const opencodeOptions = [
    { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
    { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
  ]

  it('picks the allow_once option when allowing', () => {
    expect(pickOptionId('allow', opencodeOptions)).toBe('once')
  })

  it('picks the reject_once option when rejecting', () => {
    expect(pickOptionId('reject', opencodeOptions)).toBe('reject')
  })

  it('falls back to allow_always if allow_once is absent', () => {
    const trimmed = [
      { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
    ]
    expect(pickOptionId('allow', trimmed)).toBe('always')
  })

  it('returns null when no matching option exists', () => {
    expect(pickOptionId('allow', [{ optionId: 'reject', kind: 'reject_once' }])).toBeNull()
  })

  it('handles agents that use unfamiliar optionId strings as long as kind is set', () => {
    const customOptions = [
      { optionId: 'AGENT_X_ALLOW', kind: 'allow_once', name: 'Allow' },
      { optionId: 'AGENT_X_REJECT', kind: 'reject_once', name: 'Reject' },
    ]
    expect(pickOptionId('allow', customOptions)).toBe('AGENT_X_ALLOW')
    expect(pickOptionId('reject', customOptions)).toBe('AGENT_X_REJECT')
  })
})

describe('handleFsRead / handleFsWrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-cb-test-'))
  const file = join(dir, 'sample.txt')
  writeFileSync(file, 'line1\nline2\nline3\nline4\n', 'utf8')

  it('reads full content when no line/limit', async () => {
    const r = await handleFsRead({ path: file })
    expect(r.content).toBe('line1\nline2\nline3\nline4\n')
  })

  it('slices by line+limit (1-indexed)', async () => {
    const r = await handleFsRead({ path: file, line: 2, limit: 2 })
    expect(r.content).toBe('line2\nline3')
  })

  it('writes content', async () => {
    const out = join(dir, 'written.txt')
    await handleFsWrite({ path: out, content: 'hello\n' })
    expect(readFileSync(out, 'utf8')).toBe('hello\n')
  })

  it('rejects on missing file with a real Error', async () => {
    await expect(handleFsRead({ path: join(dir, 'nope.txt') })).rejects.toThrow()
    rmSync(dir, { recursive: true, force: true })
  })
})
