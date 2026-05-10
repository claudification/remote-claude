#!/usr/bin/env bun

import { checkBunVersion } from '../shared/bun-version'

checkBunVersion()

import { existsSync } from 'node:fs'
import { initAuth } from './auth'
import { handleBackup } from './cli/backup-commands'
import { type ParsedArgs, parseArgs } from './cli/parse-args'
import { handleDeletePasskey, handleListPasskeys } from './cli/passkey-commands'
import { handleRemoveRole, handleSetRole } from './cli/role-commands'
import { handleGateway } from './cli/gateway-commands'
import { handleSentinel } from './cli/sentinel-commands'
import { DEFAULT_CACHE_DIR, printUsage } from './cli/shared'
import {
  handleCreateInvite,
  handleGrant,
  handleListUsers,
  handleRevoke,
  handleRevokeGrant,
  handleUnrevoke,
} from './cli/user-commands'
import { addAllowedRoot, addPathMapping, resolveInJail } from './path-jail'
import { runMigrateCli } from './store/migrate-cli'
import { parseDbName, runQueryCli } from './store/query-cli'

function handleResolvePath(args: ParsedArgs): void {
  for (const root of args.allowRoots) addAllowedRoot(root)
  for (const { from, to } of args.pathMapArgs) addPathMapping(from, to)

  if (!args.testPath) {
    console.error('ERROR: provide a path to resolve')
    process.exit(1)
  }

  const result = resolveInJail(args.testPath)
  console.log(`Input:    ${args.testPath}`)
  console.log(`Resolved: ${result || 'DENIED'}`)
  if (result) {
    const exists = existsSync(result)
    console.log(`Exists:   ${exists ? 'YES' : 'NO'}`)
  }
  process.exit(result ? 0 : 1)
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2)
  if (rawArgs.length === 0 || rawArgs.includes('-h') || rawArgs.includes('--help')) {
    printUsage()
    process.exit(0)
  }

  const args = parseArgs(rawArgs, DEFAULT_CACHE_DIR)

  if (args.command === 'migrate') {
    runMigrateCli({ cacheDir: args.cacheDir, dataDir: args.dataDir || undefined, dryRun: args.dryRun })
    process.exit(0)
  }

  if (args.command === 'query') {
    if (!args.queryArg) {
      console.error('ERROR: provide a SQL string, e.g. broker-cli query "SELECT COUNT(*) FROM turns"')
      process.exit(1)
    }
    runQueryCli({
      cacheDir: args.cacheDir,
      dbName: parseDbName(args.dbArg || undefined),
      sql: args.queryArg,
      json: args.jsonFlag,
    })
    process.exit(0)
  }

  if (args.command === 'backup') {
    await handleBackup(args)
    process.exit(0)
  }

  if (args.command === 'resolve-path') {
    handleResolvePath(args)
    return
  }

  initAuth({ cacheDir: args.cacheDir, skipTimers: true })

  switch (args.command) {
    case 'create-invite':
      handleCreateInvite(args)
      break
    case 'list-users':
      handleListUsers()
      break
    case 'grant':
      handleGrant(args)
      break
    case 'revoke-grant':
      handleRevokeGrant(args)
      break
    case 'revoke':
      handleRevoke(args)
      break
    case 'unrevoke':
      handleUnrevoke(args)
      break
    case 'set-role':
      handleSetRole(args)
      break
    case 'remove-role':
      handleRemoveRole(args)
      break
    case 'list-passkeys':
      handleListPasskeys(args)
      break
    case 'delete-passkey':
      handleDeletePasskey(args)
      break
    case 'sentinel':
      handleSentinel(args)
      break
    case 'gateway':
      handleGateway(args)
      break
    default:
      console.error(`Unknown command: ${args.command}`)
      printUsage()
      process.exit(1)
  }
}

main().catch(err => {
  console.error(`ERROR: ${err.message}`)
  process.exit(1)
})
