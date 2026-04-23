import { describe, expect, test } from 'bun:test'
import {
  allGrantsExpired,
  cwdToScope,
  hasAnyCwdAccess,
  hasAnyProjectAccess,
  hasPermissionAnyCwd,
  resolvePermissionFlags,
  resolvePermissions,
  type UserGrant,
} from './permissions'

describe('cwdToScope', () => {
  test('wildcard stays wildcard', () => {
    expect(cwdToScope('*')).toBe('*')
  })

  test('bare path becomes claude:// URI', () => {
    expect(cwdToScope('/Users/jonas/projects/foo')).toBe('claude:///Users/jonas/projects/foo')
  })

  test('glob path becomes claude:// URI with glob', () => {
    expect(cwdToScope('/Users/jonas/projects/*')).toBe('claude:///Users/jonas/projects/*')
  })
})

describe('resolvePermissions with scope-based grants', () => {
  test('scope: "*" matches everything', () => {
    const grants: UserGrant[] = [{ scope: '*', roles: ['admin'] }]
    const { isAdmin } = resolvePermissions(grants, '/any/path')
    expect(isAdmin).toBe(true)
  })

  test('scope: "claude:*" matches all claude:// URIs', () => {
    const grants: UserGrant[] = [{ scope: 'claude:*', permissions: ['chat'] }]
    const { permissions } = resolvePermissions(grants, 'claude:///Users/jonas/projects/foo')
    expect(permissions.has('chat')).toBe(true)
  })

  test('scope: "claude:///path/*" matches sub-paths', () => {
    const grants: UserGrant[] = [{ scope: 'claude:///Users/jonas/projects/*', permissions: ['chat'] }]

    const match = resolvePermissions(grants, 'claude:///Users/jonas/projects/foo')
    expect(match.permissions.has('chat')).toBe(true)

    const noMatch = resolvePermissions(grants, 'claude:///other/path')
    expect(noMatch.permissions.has('chat')).toBe(false)
  })

  test('exact scope match', () => {
    const grants: UserGrant[] = [{ scope: 'claude:///Users/jonas/projects/foo', permissions: ['terminal'] }]

    const match = resolvePermissions(grants, 'claude:///Users/jonas/projects/foo')
    expect(match.permissions.has('terminal')).toBe(true)

    const noMatch = resolvePermissions(grants, 'claude:///Users/jonas/projects/bar')
    expect(noMatch.permissions.has('terminal')).toBe(false)
  })
})

describe('resolvePermissions with legacy cwd grants', () => {
  test('cwd: "*" auto-upgrades and matches all', () => {
    const grants: UserGrant[] = [{ cwd: '*', roles: ['admin'] }]
    const { isAdmin, permissions } = resolvePermissions(grants, '/Users/jonas/projects/foo')
    expect(isAdmin).toBe(true)
    expect(permissions.has('chat')).toBe(true)
  })

  test('cwd: "/path" auto-upgrades to scope and matches bare CWD input', () => {
    const grants: UserGrant[] = [{ cwd: '/Users/jonas/projects/foo', permissions: ['chat'] }]
    const { permissions } = resolvePermissions(grants, '/Users/jonas/projects/foo')
    expect(permissions.has('chat')).toBe(true)
  })

  test('cwd: "/path" auto-upgrades and matches project URI input', () => {
    const grants: UserGrant[] = [{ cwd: '/Users/jonas/projects/foo', permissions: ['chat'] }]
    const { permissions } = resolvePermissions(grants, 'claude:///Users/jonas/projects/foo')
    expect(permissions.has('chat')).toBe(true)
  })

  test('cwd: "/path/*" auto-upgrades glob and matches sub-paths', () => {
    const grants: UserGrant[] = [{ cwd: '/Users/jonas/projects/*', permissions: ['files'] }]

    const match = resolvePermissions(grants, '/Users/jonas/projects/bar')
    expect(match.permissions.has('files')).toBe(true)

    const noMatch = resolvePermissions(grants, '/other/path')
    expect(noMatch.permissions.has('files')).toBe(false)
  })

  test('no regression: admin with cwd: "*" has full access', () => {
    const grants: UserGrant[] = [{ cwd: '*', roles: ['admin'] }]
    const { isAdmin, permissions } = resolvePermissions(grants, '/anything')
    expect(isAdmin).toBe(true)
    expect(permissions.has('chat')).toBe(true)
    expect(permissions.has('terminal')).toBe(true)
    expect(permissions.has('files')).toBe(true)
    expect(permissions.has('spawn')).toBe(true)
    expect(permissions.has('settings')).toBe(true)
    expect(permissions.has('voice')).toBe(true)
    expect(permissions.has('notifications')).toBe(true)
  })
})

describe('resolvePermissions accepts both bare CWD and project URI', () => {
  const grants: UserGrant[] = [{ scope: 'claude:///Users/jonas/projects/foo', permissions: ['chat'] }]

  test('bare CWD input matches', () => {
    const { permissions } = resolvePermissions(grants, '/Users/jonas/projects/foo')
    expect(permissions.has('chat')).toBe(true)
  })

  test('project URI input matches', () => {
    const { permissions } = resolvePermissions(grants, 'claude:///Users/jonas/projects/foo')
    expect(permissions.has('chat')).toBe(true)
  })

  test('mismatched path does not match', () => {
    const { permissions } = resolvePermissions(grants, '/Users/jonas/projects/bar')
    expect(permissions.has('chat')).toBe(false)
  })
})

describe('scope takes precedence over cwd', () => {
  test('grant with both scope and cwd uses scope', () => {
    const grants: UserGrant[] = [
      { cwd: '/wrong/path', scope: 'claude:///Users/jonas/projects/foo', permissions: ['chat'] },
    ]
    const match = resolvePermissions(grants, '/Users/jonas/projects/foo')
    expect(match.permissions.has('chat')).toBe(true)

    const noMatch = resolvePermissions(grants, '/wrong/path')
    expect(noMatch.permissions.has('chat')).toBe(false)
  })
})

describe('resolvePermissionFlags', () => {
  test('works with project URI', () => {
    const grants: UserGrant[] = [{ scope: '*', roles: ['admin'] }]
    const flags = resolvePermissionFlags(grants, 'claude:///Users/jonas/projects/foo')
    expect(flags.canAdmin).toBe(true)
    expect(flags.canChat).toBe(true)
  })
})

describe('hasAnyProjectAccess', () => {
  test('matches with scope grant', () => {
    const grants: UserGrant[] = [{ scope: 'claude:///Users/jonas/projects/*', permissions: ['chat'] }]
    expect(hasAnyProjectAccess(grants, 'claude:///Users/jonas/projects/foo')).toBe(true)
    expect(hasAnyProjectAccess(grants, '/Users/jonas/projects/foo')).toBe(true)
    expect(hasAnyProjectAccess(grants, '/other/path')).toBe(false)
  })

  test('backward compat alias works', () => {
    const grants: UserGrant[] = [{ cwd: '*', roles: ['admin'] }]
    expect(hasAnyCwdAccess(grants, '/anything')).toBe(true)
  })
})

describe('hasPermissionAnyCwd with scope grants', () => {
  test('finds permission regardless of scope', () => {
    const grants: UserGrant[] = [{ scope: 'claude:///specific/path', permissions: ['files'] }]
    expect(hasPermissionAnyCwd(grants, 'files')).toBe(true)
    expect(hasPermissionAnyCwd(grants, 'chat')).toBe(false)
  })
})

describe('allGrantsExpired', () => {
  test('works with scope grants', () => {
    const past = Date.now() - 1000
    const grants: UserGrant[] = [{ scope: '*', roles: ['admin'], notAfter: past }]
    expect(allGrantsExpired(grants)).toBe(true)
  })
})

describe('time-bound grants', () => {
  test('expired grant is inactive', () => {
    const grants: UserGrant[] = [{ scope: '*', roles: ['admin'], notAfter: Date.now() - 1000 }]
    const { isAdmin } = resolvePermissions(grants, '/any')
    expect(isAdmin).toBe(false)
  })

  test('future grant is inactive', () => {
    const grants: UserGrant[] = [{ scope: '*', roles: ['admin'], notBefore: Date.now() + 100000 }]
    const { isAdmin } = resolvePermissions(grants, '/any')
    expect(isAdmin).toBe(false)
  })
})
