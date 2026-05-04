import { getUser, type ServerRole, setServerRoles } from '../auth'
import type { ParsedArgs } from './parse-args'
import { notifyServer } from './shared'

function requireNameAndRole(args: ParsedArgs): { name: string; role: string } {
  if (!args.name) {
    console.error('ERROR: --name is required')
    process.exit(1)
  }
  if (!args.roleArg) {
    console.error('ERROR: --role is required')
    process.exit(1)
  }
  return { name: args.name, role: args.roleArg }
}

export function handleSetRole(args: ParsedArgs): void {
  const { name, role } = requireNameAndRole(args)
  const user = getUser(name)
  if (!user) {
    console.error(`ERROR: User "${name}" not found.`)
    process.exit(1)
  }
  const currentRoles = user.serverRoles || []
  if (currentRoles.includes(role as ServerRole)) {
    console.log(`User "${name}" already has role "${role}"`)
    return
  }
  const newRoles = [...currentRoles, role as ServerRole]
  setServerRoles(name, newRoles)
  console.log(`Added role "${role}" to "${name}" (roles: ${newRoles.join(', ')})`)
  notifyServer(args.cacheDir)
}

export function handleRemoveRole(args: ParsedArgs): void {
  const { name, role } = requireNameAndRole(args)
  const user = getUser(name)
  if (!user) {
    console.error(`ERROR: User "${name}" not found.`)
    process.exit(1)
  }
  const currentRoles = user.serverRoles || []
  if (!currentRoles.includes(role as ServerRole)) {
    console.error(`User "${name}" does not have role "${role}"`)
    process.exit(1)
  }
  const newRoles = currentRoles.filter((r) => r !== role)
  setServerRoles(name, newRoles)
  console.log(
    `Removed role "${role}" from "${name}"${newRoles.length ? ` (remaining: ${newRoles.join(', ')})` : ''}`,
  )
  notifyServer(args.cacheDir)
}
