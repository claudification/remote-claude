import { describe, expect, it } from 'vitest'
import {
  assertSpawnAllowed,
  mapProjectTrust,
  type SpawnCallerContext,
  SpawnPermissionError,
  type TrustLevel,
} from './spawn-permissions'
import type { SpawnRequest } from './spawn-schema'

function makeCtx(overrides: Partial<SpawnCallerContext> = {}): SpawnCallerContext {
  return {
    kind: 'http',
    hasSpawnPermission: true,
    trustLevel: 'trusted',
    cwd: null,
    ...overrides,
  }
}

const baseReq: SpawnRequest = { cwd: '/tmp/project' }

describe('assertSpawnAllowed', () => {
  it('passes for trusted HTTP caller with base request', () => {
    expect(() => assertSpawnAllowed(makeCtx(), baseReq)).not.toThrow()
  })

  it('denies when hasSpawnPermission is false', () => {
    let err: unknown
    try {
      assertSpawnAllowed(makeCtx({ hasSpawnPermission: false }), baseReq)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SpawnPermissionError)
    expect((err as SpawnPermissionError).required).toBe('spawn_permission')
  })

  it('denies MCP caller without benevolent trust', () => {
    const ctx = makeCtx({ kind: 'mcp', trustLevel: 'trusted', cwd: '/mcp/app' })
    let err: unknown
    try {
      assertSpawnAllowed(ctx, baseReq)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SpawnPermissionError)
    expect((err as SpawnPermissionError).required).toBe('benevolent')
  })

  it('passes MCP caller with benevolent trust', () => {
    const ctx = makeCtx({ kind: 'mcp', trustLevel: 'benevolent', cwd: '/mcp/app' })
    expect(() => assertSpawnAllowed(ctx, baseReq)).not.toThrow()
  })

  it('denies bypassPermissions for non-benevolent caller', () => {
    const req: SpawnRequest = { ...baseReq, permissionMode: 'bypassPermissions' }
    let err: unknown
    try {
      assertSpawnAllowed(makeCtx({ trustLevel: 'trusted' }), req)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SpawnPermissionError)
    expect((err as SpawnPermissionError).field).toBe('permissionMode')
    expect((err as SpawnPermissionError).required).toBe('benevolent')
  })

  it('passes bypassPermissions for benevolent caller', () => {
    const req: SpawnRequest = { ...baseReq, permissionMode: 'bypassPermissions' }
    expect(() => assertSpawnAllowed(makeCtx({ trustLevel: 'benevolent' }), req)).not.toThrow()
  })

  it('allows non-sensitive env override for trusted caller', () => {
    const req: SpawnRequest = { ...baseReq, env: { MY_VAR: 'hello' } }
    expect(() => assertSpawnAllowed(makeCtx(), req)).not.toThrow()
  })

  it('denies sensitive env override (ANTHROPIC_API_KEY) for trusted caller', () => {
    const req: SpawnRequest = { ...baseReq, env: { ANTHROPIC_API_KEY: 'sk-xxx' } }
    let err: unknown
    try {
      assertSpawnAllowed(makeCtx({ trustLevel: 'trusted' }), req)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SpawnPermissionError)
    expect((err as SpawnPermissionError).field).toBe('env')
    expect((err as SpawnPermissionError).required).toBe('benevolent')
  })

  it('denies sensitive env override (PATH) for trusted caller', () => {
    const req: SpawnRequest = { ...baseReq, env: { PATH: '/evil/bin' } }
    expect(() => assertSpawnAllowed(makeCtx({ trustLevel: 'trusted' }), req)).toThrow(SpawnPermissionError)
  })

  it('allows sensitive env override for benevolent caller', () => {
    const req: SpawnRequest = { ...baseReq, env: { ANTHROPIC_API_KEY: 'sk-xxx' } }
    expect(() => assertSpawnAllowed(makeCtx({ trustLevel: 'benevolent' }), req)).not.toThrow()
  })

  it('denies untrusted caller even at base level (via bypass)', () => {
    const req: SpawnRequest = { ...baseReq, permissionMode: 'bypassPermissions' }
    const levels: TrustLevel[] = ['untrusted', 'trusted']
    for (const lvl of levels) {
      expect(() => assertSpawnAllowed(makeCtx({ trustLevel: lvl }), req)).toThrow(SpawnPermissionError)
    }
  })
})

describe('mapProjectTrust', () => {
  it('maps benevolent -> benevolent', () => {
    expect(mapProjectTrust('benevolent')).toBe('benevolent')
  })

  it('maps default -> trusted', () => {
    expect(mapProjectTrust('default')).toBe('trusted')
  })

  it('maps open -> trusted', () => {
    expect(mapProjectTrust('open')).toBe('trusted')
  })

  it('maps undefined -> trusted', () => {
    expect(mapProjectTrust(undefined)).toBe('trusted')
  })
})
