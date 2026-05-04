import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UserGrant } from '../permissions'

export const DEFAULT_CACHE_DIR = existsSync('/data/cache')
  ? '/data/cache'
  : join(process.env.HOME || process.env.USERPROFILE || '/root', '.cache', 'broker')

const KNOWN_ROLES = new Set(['admin'])

export function notifyServer(cacheDir: string): void {
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

export function parseGrants(grantStrs: string[], notBeforeArg: string, notAfterArg: string): UserGrant[] {
  return grantStrs.map((s) => {
    const colonIdx = s.indexOf(':')
    if (colonIdx <= 0) {
      console.error(`Invalid grant format: "${s}" (expected "scope:permission,permission")`)
      process.exit(1)
    }
    const scope = s.slice(0, colonIdx)
    const items = s
      .slice(colonIdx + 1)
      .split(',')
      .map((p) => p.trim())
    const roles = items.filter((i) => KNOWN_ROLES.has(i)) as UserGrant['roles']
    const permissions = items.filter((i) => !KNOWN_ROLES.has(i)) as UserGrant['permissions']
    return {
      scope,
      ...(roles && roles.length > 0 && { roles }),
      ...(permissions && permissions.length > 0 && { permissions }),
      ...(notBeforeArg && { notBefore: new Date(notBeforeArg).getTime() }),
      ...(notAfterArg && { notAfter: new Date(notAfterArg).getTime() }),
    }
  })
}

export function parsePermissionItems(permissionsArg: string): { roles: UserGrant['roles']; permissions: UserGrant['permissions'] } {
  const items = permissionsArg.split(',').map((p) => p.trim())
  const roles = items.filter((i) => KNOWN_ROLES.has(i)) as UserGrant['roles']
  const permissions = items.filter((i) => !KNOWN_ROLES.has(i)) as UserGrant['permissions']
  return { roles, permissions }
}

export function printUsage(): void {
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
