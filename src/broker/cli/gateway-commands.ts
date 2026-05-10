import { createGatewayRegistry, type GatewayRegistry, isValidGatewayAlias } from '../gateway-registry'
import type { ParsedArgs } from './parse-args'
import { notifyServer } from './shared'

function handleCreate(args: ParsedArgs, registry: GatewayRegistry): void {
  if (!args.aliasArg) {
    console.error('ERROR: --alias is required')
    process.exit(1)
  }
  const alias = args.aliasArg.trim().toLowerCase()
  if (!isValidGatewayAlias(alias)) {
    console.error('ERROR: Invalid alias (lowercase alphanumeric + hyphens, 1-63 chars)')
    process.exit(1)
  }
  const existing = registry.findByAlias(alias)
  if (existing) {
    console.error(`ERROR: Alias "${alias}" already exists`)
    process.exit(1)
  }
  const gatewayType = args.typeArg || 'hermes'
  const record = registry.create({ alias, gatewayType, generateSecret: true })
  console.log(`
  GATEWAY CREATED

  ID:      ${record.gatewayId}
  Alias:   ${record.alias}
  Type:    ${record.gatewayType}
  Secret:  ${record.rawSecret}

  Configure the gateway adapter with:
    export CLAUDWERK_ADAPTER_SECRET=${record.rawSecret}
    export CLAUDWERK_BROKER_URL=wss://<your-broker-host>/ws
`)
  notifyServer(args.cacheDir)
}

function handleList(registry: GatewayRegistry): void {
  const all = registry.getAll()
  if (all.size === 0) {
    console.log('No registered gateways.')
    return
  }
  console.log(`\n  Gateways (${all.size}):`)
  for (const [id, record] of all) {
    console.log(`  ${record.alias} (${id.slice(0, 8)}...) type=${record.gatewayType}`)
    console.log(`    created: ${new Date(record.createdAt).toLocaleString()}`)
  }
  console.log()
}

function handleRevoke(args: ParsedArgs, registry: GatewayRegistry): void {
  if (!args.aliasArg) {
    console.error('ERROR: --alias is required')
    process.exit(1)
  }
  const found = registry.findByAlias(args.aliasArg)
  if (!found) {
    console.error(`ERROR: Gateway "${args.aliasArg}" not found`)
    process.exit(1)
  }
  registry.remove(found.gatewayId)
  console.log(`Gateway "${args.aliasArg}" revoked. Secret invalidated.`)
  notifyServer(args.cacheDir)
}

export function handleGateway(args: ParsedArgs): void {
  const registry = createGatewayRegistry(args.cacheDir)

  switch (args.subCommand) {
    case 'create':
      handleCreate(args, registry)
      break
    case 'list':
      handleList(registry)
      break
    case 'revoke':
      handleRevoke(args, registry)
      break
    default:
      console.error(`Unknown gateway subcommand: ${args.subCommand || '(none)'}`)
      console.error('Available: create, list, revoke')
      process.exit(1)
  }
}
