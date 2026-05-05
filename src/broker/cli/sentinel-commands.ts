import { createSentinelRegistry, isValidSentinelAlias, type SentinelRegistry } from '../sentinel-registry'
import type { ParsedArgs } from './parse-args'
import { notifyServer } from './shared'

function handleCreate(args: ParsedArgs, registry: SentinelRegistry): void {
  if (!args.aliasArg) {
    console.error('ERROR: --alias is required')
    process.exit(1)
  }
  const alias = args.aliasArg.trim().toLowerCase()
  if (!isValidSentinelAlias(alias)) {
    console.error('ERROR: Invalid alias (lowercase alphanumeric + hyphens, 1-63 chars)')
    process.exit(1)
  }
  const existing = registry.findByAlias(alias)
  if (existing) {
    console.error(`ERROR: Alias "${alias}" already exists`)
    process.exit(1)
  }
  const record = registry.create({ alias, color: args.colorArg || undefined, generateSecret: true })
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
  notifyServer(args.cacheDir)
}

function handleList(registry: SentinelRegistry): void {
  const all = registry.getAll()
  if (all.size === 0) {
    console.log('No registered sentinels.')
    return
  }
  console.log(`\n  Sentinels (${all.size}):`)
  for (const [id, record] of all) {
    const def = record.isDefault ? ' DEFAULT' : ''
    const color = record.color ? ` color=${record.color}` : ''
    console.log(`  ${record.aliases[0]} (${id.slice(0, 8)}...)${def}${color}`)
    console.log(`    created: ${new Date(record.createdAt).toLocaleString()}`)
  }
  console.log()
}

function handleSetDefault(args: ParsedArgs, registry: SentinelRegistry): void {
  if (!args.aliasArg) {
    console.error('ERROR: --alias is required')
    process.exit(1)
  }
  const found = registry.findByAlias(args.aliasArg)
  if (!found) {
    console.error(`ERROR: Sentinel "${args.aliasArg}" not found`)
    process.exit(1)
  }
  registry.setDefault(found.sentinelId)
  console.log(`Default sentinel set to "${args.aliasArg}"`)
  notifyServer(args.cacheDir)
}

function handleRevoke(args: ParsedArgs, registry: SentinelRegistry): void {
  if (!args.aliasArg) {
    console.error('ERROR: --alias is required')
    process.exit(1)
  }
  const found = registry.findByAlias(args.aliasArg)
  if (!found) {
    console.error(`ERROR: Sentinel "${args.aliasArg}" not found`)
    process.exit(1)
  }
  registry.remove(found.sentinelId)
  console.log(`Sentinel "${args.aliasArg}" revoked. Secret invalidated.`)
  notifyServer(args.cacheDir)
}

export function handleSentinel(args: ParsedArgs): void {
  const registry = createSentinelRegistry(args.cacheDir)

  switch (args.subCommand) {
    case 'create':
      handleCreate(args, registry)
      break
    case 'list':
      handleList(registry)
      break
    case 'set-default':
      handleSetDefault(args, registry)
      break
    case 'revoke':
      handleRevoke(args, registry)
      break
    default:
      console.error(`Unknown sentinel subcommand: ${args.subCommand || '(none)'}`)
      console.error('Available: create, list, set-default, revoke')
      process.exit(1)
  }
}
