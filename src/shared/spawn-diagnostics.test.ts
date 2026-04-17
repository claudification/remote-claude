import { describe, expect, it } from 'vitest'
import { type BuildDiagnosticsInput, buildSpawnDiagnostics } from './spawn-diagnostics'

function makeInput(over: Partial<BuildDiagnosticsInput> = {}): BuildDiagnosticsInput {
  return {
    source: 'run-task-dialog',
    jobId: 'job-1',
    wrapperId: 'wrap-1',
    sessionId: 'sess-1',
    elapsedSec: 12,
    error: null,
    config: { cwd: '/tmp/p', model: 'opus' },
    steps: [{ label: 'step', status: 'done', detail: null, ts: 1 }],
    launchEvents: [{ step: 's', status: 'ok', detail: 'd', t: 5 }],
    launchState: { completed: true, failed: false },
    ...over,
  }
}

describe('buildSpawnDiagnostics', () => {
  it('has stable envelope fields', () => {
    const d = buildSpawnDiagnostics(makeInput())
    expect(d.type).toBe('spawn_diagnostics')
    expect(d.version).toBe(1)
    expect(typeof d.time).toBe('string')
    expect(Number.isNaN(Date.parse(d.time))).toBe(false)
    expect(d.source).toBe('run-task-dialog')
    expect(d.jobId).toBe('job-1')
    expect(d.wrapperId).toBe('wrap-1')
    expect(d.sessionId).toBe('sess-1')
    expect(d.elapsed).toBe('12s')
    expect(d.launchState).toEqual({ completed: true, failed: false })
    expect(d.steps).toHaveLength(1)
    expect(d.launchEvents).toHaveLength(1)
  })

  it('coerces null-ish ids when omitted', () => {
    const d = buildSpawnDiagnostics(
      makeInput({ jobId: undefined, wrapperId: undefined, sessionId: undefined, error: undefined }),
    )
    expect(d.jobId).toBeNull()
    expect(d.wrapperId).toBeNull()
    expect(d.sessionId).toBeNull()
    expect(d.error).toBeNull()
  })

  it('redacts sensitive env keys in config', () => {
    const d = buildSpawnDiagnostics(
      makeInput({
        config: {
          cwd: '/tmp/p',
          env: { ANTHROPIC_API_KEY: 'sk-secret', MY_VAR: 'keep-me', GITHUB_TOKEN: 'ghp_xxx' },
        },
      }),
    )
    expect(d.config.env?.ANTHROPIC_API_KEY).toBe('[redacted]')
    expect(d.config.env?.GITHUB_TOKEN).toBe('[redacted]')
    expect(d.config.env?.MY_VAR).toBe('keep-me')
  })

  it('does not mutate the caller config.env', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-secret' }
    const config = { cwd: '/tmp/p', env }
    buildSpawnDiagnostics(makeInput({ config }))
    expect(env.ANTHROPIC_API_KEY).toBe('sk-secret')
  })

  it('accepts mcp source', () => {
    const d = buildSpawnDiagnostics(makeInput({ source: 'mcp' }))
    expect(d.source).toBe('mcp')
  })

  it('carries task metadata through when provided', () => {
    const d = buildSpawnDiagnostics(
      makeInput({
        task: { slug: 't-1', title: 'Ship it', status: 'open', priority: 'high', tags: ['a'] },
      }),
    )
    expect(d.task?.slug).toBe('t-1')
    expect(d.task?.title).toBe('Ship it')
  })
})
