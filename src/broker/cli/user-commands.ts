import { addUserGrant, createInvite, getAllUsers, removeUserGrant, revokeUser, unrevokeUser } from '../auth'
import type { UserGrant } from '../permissions'
import type { ParsedArgs } from './parse-args'
import { notifyServer, parseGrants, parsePermissionItems } from './shared'

function requireName(name: string): void {
  if (!name) {
    console.error('ERROR: --name is required')
    process.exit(1)
  }
}

export function handleCreateInvite(args: ParsedArgs): void {
  requireName(args.name)

  const grants =
    args.grantArgs.length > 0 ? parseGrants(args.grantArgs, args.notBeforeArg, args.notAfterArg) : undefined
  const grantLabel = grants
    ? grants
        .map(g => `${g.scope || g.legacyCwd || '*'}: ${[...(g.roles || []), ...(g.permissions || [])].join(', ')}`)
        .join('\n           ')
    : '* (admin -- full access)'

  try {
    const invite = createInvite(args.name, grants)
    const inviteUrl = `${args.baseUrl}/#/invite/${invite.token}`

    console.log(`
  PASSKEY INVITE CREATED

  Name:    ${args.name}
  Grants:  ${grantLabel}
  Expires: ${new Date(invite.expiresAt).toLocaleString()}

  Share this link (one-time use, 30 min expiry):
  ${inviteUrl}
`)
    notifyServer(args.cacheDir)
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`)
    process.exit(1)
  }
}

export function handleListUsers(): void {
  const users = getAllUsers()
  if (users.length === 0) {
    console.log('No registered users.')
    return
  }

  for (const user of users) {
    const status = user.revoked ? 'REVOKED' : 'ACTIVE'
    const keys = user.credentials.length
    const lastUsed = user.lastUsedAt ? new Date(user.lastUsedAt).toLocaleString() : 'never'
    const grants = (user.grants || [])
      .map(g => {
        const parts = [...(g.roles || []), ...(g.permissions || [])]
        let label = `${g.scope || g.legacyCwd || '*'}: ${parts.join(', ')}`
        if (g.notBefore) label += ` [from ${new Date(g.notBefore).toLocaleDateString()}]`
        if (g.notAfter) label += ` [until ${new Date(g.notAfter).toLocaleDateString()}]`
        return label
      })
      .join('\n           ')

    console.log(`  ${user.name} (${status}, ${keys} key${keys !== 1 ? 's' : ''}, last: ${lastUsed})`)
    console.log(`    grants: ${grants || '(none)'}`)
    console.log()
  }
}

export function handleGrant(args: ParsedArgs): void {
  requireName(args.name)
  if (!args.cwdArg) {
    console.error('ERROR: --scope is required')
    process.exit(1)
  }
  if (!args.permissionsArg) {
    console.error('ERROR: --permissions is required')
    process.exit(1)
  }

  const { roles, permissions: perms } = parsePermissionItems(args.permissionsArg)
  const items = args.permissionsArg.split(',').map(p => p.trim())
  const grant: UserGrant = {
    scope: args.cwdArg,
    ...(roles && roles.length > 0 && { roles }),
    ...(perms && perms.length > 0 && { permissions: perms }),
    ...(args.notBeforeArg && { notBefore: new Date(args.notBeforeArg).getTime() }),
    ...(args.notAfterArg && { notAfter: new Date(args.notAfterArg).getTime() }),
  }
  if (addUserGrant(args.name, grant)) {
    console.log(`Added grant: ${args.cwdArg} -> ${items.join(', ')} for "${args.name}"`)
    notifyServer(args.cacheDir)
  } else {
    console.error(`ERROR: User "${args.name}" not found.`)
    process.exit(1)
  }
}

export function handleRevokeGrant(args: ParsedArgs): void {
  requireName(args.name)
  if (!args.cwdArg) {
    console.error('ERROR: --scope is required')
    process.exit(1)
  }
  if (removeUserGrant(args.name, args.cwdArg)) {
    console.log(`Removed grant for scope "${args.cwdArg}" from "${args.name}"`)
    notifyServer(args.cacheDir)
  } else {
    console.error(`ERROR: User "${args.name}" not found or no grant for that scope.`)
    process.exit(1)
  }
}

export function handleRevoke(args: ParsedArgs): void {
  requireName(args.name)
  if (revokeUser(args.name)) {
    console.log(`Revoked user "${args.name}" - all sessions terminated.`)
    notifyServer(args.cacheDir)
  } else {
    console.error(`ERROR: User "${args.name}" not found.`)
    process.exit(1)
  }
}

export function handleUnrevoke(args: ParsedArgs): void {
  requireName(args.name)
  if (unrevokeUser(args.name)) {
    console.log(`Restored user "${args.name}" - they can authenticate again.`)
    notifyServer(args.cacheDir)
  } else {
    console.error(`ERROR: User "${args.name}" not found.`)
    process.exit(1)
  }
}
