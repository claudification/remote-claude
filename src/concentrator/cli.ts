#!/usr/bin/env bun

/**
 * Concentrator CLI - Passkey management
 *
 * Commands:
 *   create-invite --name <name>   Create a one-time passkey invite link
 *   list-users                     List all registered passkey users
 *   revoke --name <name>          Revoke a user's access
 *   unrevoke --name <name>        Restore a revoked user's access
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInvite, getAllUsers, initAuth, revokeUser, unrevokeUser } from './auth'
import { addAllowedRoot, addPathMapping, resolveInJail } from './path-jail'

/** Send SIGHUP to running server so it reloads auth state from disk */
function notifyServer(cacheDir: string): void {
  const pidFile = join(cacheDir, 'concentrator.pid')
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

const DEFAULT_CACHE_DIR = join(process.env.HOME || process.env.USERPROFILE || '/root', '.cache', 'concentrator')

function printUsage(): void {
  console.log(`
concentrator-cli - Passkey management for Claude Concentrator

COMMANDS:
  create-invite --name <name>           Create a one-time invite link (unique name required)
  list-users                             List all passkey users and their status
  revoke --name <name>                  Revoke a user's access
  unrevoke --name <name>                Restore a revoked user
  resolve-path <path>                   Debug: test path jail resolution

OPTIONS:
  --cache-dir <dir>    Auth storage directory (default: ~/.cache/concentrator)
  --url <url>          Concentrator URL for invite links (default: http://localhost:9999)
  --allow-root <dir>   Add allowed root for resolve-path (repeatable)
  --path-map <f>:<t>   Add path mapping for resolve-path (repeatable)
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
  let baseUrl = 'http://localhost:9999'
  let name = ''
  let command = ''
  const allowRoots: string[] = []
  const pathMapArgs: Array<{ from: string; to: string }> = []
  let testPath = ''

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--cache-dir') {
      cacheDir = args[++i]
    } else if (arg === '--url') {
      baseUrl = args[++i]
    } else if (arg === '--name') {
      name = args[++i]
    } else if (arg === '--allow-root') {
      allowRoots.push(args[++i])
    } else if (arg === '--path-map') {
      const mapping = args[++i]
      const sep = mapping.indexOf(':')
      if (sep > 0) {
        pathMapArgs.push({ from: mapping.slice(0, sep), to: mapping.slice(sep + 1) })
      }
    } else if (!arg.startsWith('-')) {
      if (command === 'resolve-path' && !testPath) {
        testPath = arg
      } else {
        command = arg
      }
    }
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

      try {
        const invite = createInvite(name)
        const inviteUrl = `${baseUrl}/#/invite/${invite.token}`

        console.log(`
┌─────────────────────────────────────────────────────────────┐
│  PASSKEY INVITE CREATED                                     │
├─────────────────────────────────────────────────────────────┤
│  Name:    ${name.padEnd(49)}│
│  Expires: ${new Date(invite.expiresAt).toLocaleString().padEnd(49)}│
├─────────────────────────────────────────────────────────────┤
│  Share this link (one-time use, 30 min expiry):             │
│                                                             │
│  ${inviteUrl.padEnd(59)}│
│                                                             │
└─────────────────────────────────────────────────────────────┘
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

      console.log(`
┌────────────────────────────────────────────────────────────────────────┐
│  REGISTERED PASSKEY USERS                                              │
├──────────────────┬──────────┬──────────┬──────────────────────────────┤
│  Name             │  Status   │  Keys     │  Last Used                    │
├──────────────────┼──────────┼──────────┼──────────────────────────────┤`)

      for (const user of users) {
        const status = user.revoked ? 'REVOKED' : 'ACTIVE'
        const statusColor = user.revoked ? status : status
        const keys = String(user.credentials.length)
        const lastUsed = user.lastUsedAt ? new Date(user.lastUsedAt).toLocaleString() : 'never'

        console.log(
          `│  ${user.name.padEnd(16)}│  ${statusColor.padEnd(8)}│  ${keys.padEnd(8)}│  ${lastUsed.padEnd(28)}│`,
        )
      }

      console.log('└──────────────────┴──────────┴──────────┴──────────────────────────────┘')
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

    default:
      console.error(`Unknown command: ${command}`)
      printUsage()
      process.exit(1)
  }
}

main()
