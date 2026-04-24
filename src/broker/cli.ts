#!/usr/bin/env bun

import { checkBunVersion } from '../shared/bun-version'

checkBunVersion()

/**
 * Broker CLI - Passkey management
 *
 * Commands:
 *   create-invite --name <name>   Create a one-time passkey invite link
 *   list-users                     List all registered passkey users
 *   revoke --name <name>          Revoke a user's access
 *   unrevoke --name <name>        Restore a revoked user's access
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addUserGrant,
  createInvite,
  getAllUsers,
  getUser,
  initAuth,
  removeCredential,
  removeUserGrant,
  revokeUser,
  type ServerRole,
  setServerRoles,
  unrevokeUser,
} from './auth'
import { addAllowedRoot, addPathMapping, resolveInJail } from './path-jail'
import type { UserGrant } from './permissions'
import { createSentinelRegistry, isValidSentinelAlias } from './sentinel-registry'
import { runMigrateCli } from './store/migrate-cli'
import { parseDbName, runQueryCli } from './store/query-cli'

/** Send SIGHUP to running server so it reloads auth state from disk */
function notifyServer(cacheDir: string): void {
  const pidFile = join(cacheDir, 'broker.pid')
  try {
    if (!existsSync(pidFile)) {
      console.log('Note: No running server found - changes saved to disk.')
      return
    }
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
    process.kill(pid, 'SIGHUP')
    console.log(`Server notified (SIGHUP -> PID ${pid})`)
  } catch {
    console.log('Note: Could not signal server - changes saved to disk, server will pick them up on restart.')
  }
}

// Docker container uses /data/cache; detect it automatically
const DEFAULT_CACHE_DIR = existsSync('/data/cache')
  ? '/data/cache'
  : join(process.env.HOME || process.env.USERPROFILE || '/root', '.cache', 'broker')

function printUsage(): void {
  console.log(`
broker-cli - User & passkey management for Claudwerk Broker

COMMANDS:
  create-invite --name <name> [--grant "scope:perm,perm"]  Create invite with grants
  list-users                                                List all users with grants
  revoke --name <name>                                     Revoke a user's access
  unrevoke --name <name>                                   Restore a revoked user
  grant --name <name> --scope <scope> --permissions <p,p>  Add grant to user
  revoke-grant --name <name> --scope <scope>               Remove grant from user
  set-role --name <name> --role <role>                     Add a server role
  remove-role --name <name> --role <role>                  Remove a server role
  list-passkeys --name <name>                               List passkeys for a user
  delete-passkey --name <name> --credential-id <id>        Delete a passkey (kills sessions)
  migrate [--cache-dir <dir>] [--data-dir <dir>] [--dry-run]  Migrate legacy JSON to SQLite
  query [--db <name>] [--json] "SQL"                        Read-only SQL against store/analytics/projects
  resolve-path <path>                                       Debug: test path jail resolution

SENTINEL COMMANDS:
  sentinel create --alias <alias> [--color <hex>]          Create sentinel with per-host secret
  sentinel list                                             List all registered sentinels
  sentinel set-default --alias <alias>                      Set default sentinel
  sentinel revoke --alias <alias>                           Revoke sentinel secret

GRANT FORMAT:
  --grant "scope:permission,permission"   (repeatable)
  --grant "/Users/jonas/projects/foo:chat"
  --grant "*:admin"                        (admin for all projects)

  Omit --grant for admin access (default).

  Time bounds (optional, for grant command):
  --not-before "2026-04-01"                Grant active from this date
  --not-after "2026-06-30"                 Grant expires after this date

PERMISSIONS:
  admin, chat, chat:read, terminal, terminal:read,
  files, files:read, spawn, settings, voice

SERVER ROLES:
  user-editor                              Can manage users via API/dashboard

OPTIONS:
  --cache-dir <dir>    Auth storage directory (default: ~/.cache/broker)
  --url <url>          Broker URL for invite links (default: http://localhost:9999)
  -h, --help           Show this help
`)
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printUsage()
    process.exit(0)
  }

  let cacheDir = DEFAULT_CACHE_DIR
  let dataDir = ''
  let baseUrl = 'http://localhost:9999'
  let name = ''
  let command = ''
  let subCommand = ''
  let aliasArg = ''
  let colorArg = ''
  let cwdArg = ''
  let permissionsArg = ''
  let roleArg = ''
  let credentialIdArg = ''
  let notBeforeArg = ''
  let notAfterArg = ''
  let dryRun = false
  let dbArg = ''
  let jsonFlag = false
  let queryArg = ''
  const grantArgs: string[] = []
  const allowRoots: string[] = []
  const pathMapArgs: Array<{ from: string; to: string }> = []
  let testPath = ''

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--cache-dir') {
      cacheDir = args[++i]
    } else if (arg === '--data-dir') {
      dataDir = args[++i]
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--url') {
      baseUrl = args[++i]
    } else if (arg === '--name') {
      name = args[++i]
    } else if (arg === '--grant') {
      grantArgs.push(args[++i])
    } else if (arg === '--scope' || arg === '--cwd') {
      cwdArg = args[++i]
    } else if (arg === '--permissions') {
      permissionsArg = args[++i]
    } else if (arg === '--role') {
      roleArg = args[++i]
    } else if (arg === '--alias') {
      aliasArg = args[++i]
    } else if (arg === '--color') {
      colorArg = args[++i]
    } else if (arg === '--credential-id') {
      credentialIdArg = args[++i]
    } else if (arg === '--not-before') {
      notBeforeArg = args[++i]
    } else if (arg === '--not-after') {
      notAfterArg = args[++i]
    } else if (arg === '--allow-root') {
      allowRoots.push(args[++i])
    } else if (arg === '--path-map') {
      const mapping = args[++i]
      const sep = mapping.indexOf(':')
      if (sep > 0) {
        pathMapArgs.push({ from: mapping.slice(0, sep), to: mapping.slice(sep + 1) })
      }
    } else if (arg === '--db') {
      dbArg = args[++i]
    } else if (arg === '--json') {
      jsonFlag = true
    } else if (!arg.startsWith('-')) {
      if (command === 'resolve-path' && !testPath) {
        testPath = arg
      } else if (command === 'query' && !queryArg) {
        queryArg = arg
      } else if (command === 'sentinel' && !subCommand) {
        subCommand = arg
      } else {
        command = arg
      }
    }
  }

  const KNOWN_ROLES = new Set(['admin'])

  /** Parse --grant "scope:role_or_perm,role_or_perm" into UserGrant[], applying time bounds if set */
  function parseGrants(grantStrs: string[]): UserGrant[] {
    return grantStrs.map(s => {
      const colonIdx = s.indexOf(':')
      if (colonIdx <= 0) {
        console.error(`Invalid grant format: "${s}" (expected "scope:permission,permission")`)
        process.exit(1)
      }
      const scope = s.slice(0, colonIdx)
      const items = s
        .slice(colonIdx + 1)
        .split(',')
        .map(p => p.trim())
      const roles = items.filter(i => KNOWN_ROLES.has(i)) as UserGrant['roles']
      const permissions = items.filter(i => !KNOWN_ROLES.has(i)) as UserGrant['permissions']
      return {
        scope,
        ...(roles && roles.length > 0 && { roles }),
        ...(permissions && permissions.length > 0 && { permissions }),
        ...(notBeforeArg && { notBefore: new Date(notBeforeArg).getTime() }),
        ...(notAfterArg && { notAfter: new Date(notAfterArg).getTime() }),
      }
    })
  }

  // migrate doesn't need auth
  if (command === 'migrate') {
    runMigrateCli({ cacheDir, dataDir: dataDir || undefined, dryRun })
    process.exit(0)
  }

  // query doesn't need auth (readonly SQL)
  if (command === 'query') {
    if (!queryArg) {
      console.error('ERROR: provide a SQL string, e.g. broker-cli query "SELECT COUNT(*) FROM turns"')
      process.exit(1)
    }
    runQueryCli({ cacheDir, dbName: parseDbName(dbArg || undefined), sql: queryArg, json: jsonFlag })
    process.exit(0)
  }

  // resolve-path doesn't need auth
  if (command === 'resolve-path') {
    for (const root of allowRoots) addAllowedRoot(root)
    for (const { from, to } of pathMapArgs) addPathMapping(from, to)

    if (!testPath) {
      console.error('ERROR: provide a path to resolve')
      process.exit(1)
    }

    const result = resolveInJail(testPath)
    console.log(`Input:    ${testPath}`)
    console.log(`Resolved: ${result || 'DENIED'}`)
    if (result) {
      const exists = existsSync(result)
      console.log(`Exists:   ${exists ? 'YES' : 'NO'}`)
    }
    process.exit(result ? 0 : 1)
  }

  // Init auth (loads state from disk, skip timers so CLI doesn't hang)
  initAuth({ cacheDir, skipTimers: true })

  switch (command) {
    case 'create-invite': {
      if (!name) {
        console.error('ERROR: --name is required')
        process.exit(1)
      }

      const grants = grantArgs.length > 0 ? parseGrants(grantArgs) : undefined
      const grantLabel = grants
        ? grants
            .map(g => `${g.scope || g.legacyCwd || '*'}: ${[...(g.roles || []), ...(g.permissions || [])].join(', ')}`)
            .join('\n           ')
        : '* (admin -- full access)'

      try {
        const invite = createInvite(name, grants)
        const inviteUrl = `${baseUrl}/#/invite/${invite.token}`

        console.log(`
  PASSKEY INVITE CREATED

  Name:    ${name}
  Grants:  ${grantLabel}
  Expires: ${new Date(invite.expiresAt).toLocaleString()}

  Share this link (one-time use, 30 min expiry):
  ${inviteUrl}
`)
        notifyServer(cacheDir)
      } catch (err) {
        console.error(`ERROR: ${(err as Error).message}`)
        process.exit(1)
      }
      break
    }

    case 'list-users': {
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
      break
    }

    case 'grant': {
      if (!name) {
        console.error('ERROR: --name is required')
        process.exit(1)
      }
      if (!cwdArg) {
        console.error('ERROR: --scope is required')
        process.exit(1)
      }
      if (!permissionsArg) {
        console.error('ERROR: --permissions is required')
        process.exit(1)
      }
      const items = permissionsArg.split(',').map(p => p.trim())
      const roles = items.filter(i => KNOWN_ROLES.has(i)) as UserGrant['roles']
      const perms = items.filter(i => !KNOWN_ROLES.has(i)) as UserGrant['permissions']
      const grant: UserGrant = {
        scope: cwdArg,
        ...(roles && roles.length > 0 && { roles }),
        ...(perms && perms.length > 0 && { permissions: perms }),
        ...(notBeforeArg && { notBefore: new Date(notBeforeArg).getTime() }),
        ...(notAfterArg && { notAfter: new Date(notAfterArg).getTime() }),
      }
      if (addUserGrant(name, grant)) {
        console.log(`Added grant: ${cwdArg} -> ${items.join(', ')} for "${name}"`)
        notifyServer(cacheDir)
      } else {
        console.error(`ERROR: User "${name}" not found.`)
        process.exit(1)
      }
      break
    }

    case 'revoke-grant': {
      if (!name) {
        console.error('ERROR: --name is required')
        process.exit(1)
      }
      if (!cwdArg) {
        console.error('ERROR: --scope is required')
        process.exit(1)
      }
      if (removeUserGrant(name, cwdArg)) {
        console.log(`Removed grant for scope "${cwdArg}" from "${name}"`)
        notifyServer(cacheDir)
      } else {
        console.error(`ERROR: User "${name}" not found or no grant for that scope.`)
        process.exit(1)
      }
      break
    }

    case 'revoke': {
      if (!name) {
        console.error('ERROR: --name is required')
        process.exit(1)
      }
      if (revokeUser(name)) {
        console.log(`Revoked user "${name}" - all sessions terminated.`)
        notifyServer(cacheDir)
      } else {
        console.error(`ERROR: User "${name}" not found.`)
        process.exit(1)
      }
      break
    }

    case 'unrevoke': {
      if (!name) {
        console.error('ERROR: --name is required')
        process.exit(1)
      }
      if (unrevokeUser(name)) {
        console.log(`Restored user "${name}" - they can authenticate again.`)
        notifyServer(cacheDir)
      } else {
        console.error(`ERROR: User "${name}" not found.`)
        process.exit(1)
      }
      break
    }

    case 'set-role': {
      if (!name) {
        console.error('ERROR: --name is required')
        process.exit(1)
      }
      if (!roleArg) {
        console.error('ERROR: --role is required')
        process.exit(1)
      }
      const user = getUser(name)
      if (!user) {
        console.error(`ERROR: User "${name}" not found.`)
        process.exit(1)
      }
      const currentRoles = user.serverRoles || []
      if (currentRoles.includes(roleArg as ServerRole)) {
        console.log(`User "${name}" already has role "${roleArg}"`)
        break
      }
      const newRoles = [...currentRoles, roleArg as ServerRole]
      setServerRoles(name, newRoles)
      console.log(`Added role "${roleArg}" to "${name}" (roles: ${newRoles.join(', ')})`)
      notifyServer(cacheDir)
      break
    }

    case 'remove-role': {
      if (!name) {
        console.error('ERROR: --name is required')
        process.exit(1)
      }
      if (!roleArg) {
        console.error('ERROR: --role is required')
        process.exit(1)
      }
      const user = getUser(name)
      if (!user) {
        console.error(`ERROR: User "${name}" not found.`)
        process.exit(1)
      }
      const currentRoles = user.serverRoles || []
      if (!currentRoles.includes(roleArg as ServerRole)) {
        console.error(`User "${name}" does not have role "${roleArg}"`)
        process.exit(1)
      }
      const newRoles = currentRoles.filter(r => r !== roleArg)
      setServerRoles(name, newRoles)
      console.log(
        `Removed role "${roleArg}" from "${name}"${newRoles.length ? ` (remaining: ${newRoles.join(', ')})` : ''}`,
      )
      notifyServer(cacheDir)
      break
    }

    case 'list-passkeys': {
      if (!name) {
        console.error('ERROR: --name is required')
        process.exit(1)
      }
      const user = getUser(name)
      if (!user) {
        console.error(`ERROR: User "${name}" not found.`)
        process.exit(1)
      }
      if (user.credentials.length === 0) {
        console.log(`User "${name}" has no passkeys.`)
        break
      }
      console.log(`Passkeys for "${name}" (${user.credentials.length}):`)
      for (const cred of user.credentials) {
        const registered = new Date(cred.registeredAt).toLocaleString()
        const transports = cred.transports?.join(', ') || 'unknown'
        console.log(`  ID: ${cred.credentialId}`)
        console.log(`    registered: ${registered}, counter: ${cred.counter}, transports: ${transports}`)
      }
      break
    }

    case 'delete-passkey': {
      if (!name) {
        console.error('ERROR: --name is required')
        process.exit(1)
      }
      if (!credentialIdArg) {
        console.error('ERROR: --credential-id is required')
        process.exit(1)
      }
      const result = removeCredential(name, credentialIdArg)
      if (result === 'user_not_found') {
        console.error(`ERROR: User "${name}" not found.`)
        process.exit(1)
      } else if (result === 'not_found') {
        console.error(`ERROR: Credential not found for user "${name}".`)
        process.exit(1)
      } else if (result === 'removed_and_revoked') {
        console.log(`Passkey deleted. This was "${name}"'s last passkey - user has been REVOKED.`)
        console.log('All active sessions terminated.')
      } else {
        console.log(`Passkey deleted for "${name}". All active sessions terminated.`)
      }
      notifyServer(cacheDir)
      break
    }

    case 'sentinel': {
      const registry = createSentinelRegistry(cacheDir)

      switch (subCommand) {
        case 'create': {
          if (!aliasArg) {
            console.error('ERROR: --alias is required')
            process.exit(1)
          }
          const alias = aliasArg.trim().toLowerCase()
          if (!isValidSentinelAlias(alias)) {
            console.error('ERROR: Invalid alias (lowercase alphanumeric + hyphens, 1-63 chars)')
            process.exit(1)
          }
          const existing = registry.findByAlias(alias)
          if (existing) {
            console.error(`ERROR: Alias "${alias}" already exists`)
            process.exit(1)
          }
          const record = registry.create({ alias, color: colorArg || undefined, generateSecret: true })
          console.log(`
  SENTINEL CREATED

  ID:      ${record.sentinelId}
  Alias:   ${record.aliases[0]}
  Default: ${record.isDefault}
  Secret:  ${record.rawSecret}

  Configure the sentinel with:
    export CLAUDWERK_SENTINEL_SECRET=${record.rawSecret}
    export CLAUDWERK_BROKER=wss://<your-broker-host>

  Or pass via CLI flag:
    sentinel --secret ${record.rawSecret}
`)
          notifyServer(cacheDir)
          break
        }

        case 'list': {
          const all = registry.getAll()
          if (all.size === 0) {
            console.log('No registered sentinels.')
            break
          }
          console.log(`\n  Sentinels (${all.size}):`)
          for (const [id, record] of all) {
            const def = record.isDefault ? ' DEFAULT' : ''
            const color = record.color ? ` color=${record.color}` : ''
            console.log(`  ${record.aliases[0]} (${id.slice(0, 8)}...)${def}${color}`)
            console.log(`    created: ${new Date(record.createdAt).toLocaleString()}`)
          }
          console.log()
          break
        }

        case 'set-default': {
          if (!aliasArg) {
            console.error('ERROR: --alias is required')
            process.exit(1)
          }
          const found = registry.findByAlias(aliasArg)
          if (!found) {
            console.error(`ERROR: Sentinel "${aliasArg}" not found`)
            process.exit(1)
          }
          registry.setDefault(found.sentinelId)
          console.log(`Default sentinel set to "${aliasArg}"`)
          notifyServer(cacheDir)
          break
        }

        case 'revoke': {
          if (!aliasArg) {
            console.error('ERROR: --alias is required')
            process.exit(1)
          }
          const found = registry.findByAlias(aliasArg)
          if (!found) {
            console.error(`ERROR: Sentinel "${aliasArg}" not found`)
            process.exit(1)
          }
          registry.remove(found.sentinelId)
          console.log(`Sentinel "${aliasArg}" revoked. Secret invalidated.`)
          notifyServer(cacheDir)
          break
        }

        default:
          console.error(`Unknown sentinel subcommand: ${subCommand || '(none)'}`)
          console.error('Available: create, list, set-default, revoke')
          process.exit(1)
      }
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
      printUsage()
      process.exit(1)
  }
}

main()
