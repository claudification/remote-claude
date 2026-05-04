import { getUser, removeCredential } from '../auth'
import type { ParsedArgs } from './parse-args'
import { notifyServer } from './shared'

export function handleListPasskeys(args: ParsedArgs): void {
  if (!args.name) {
    console.error('ERROR: --name is required')
    process.exit(1)
  }
  const user = getUser(args.name)
  if (!user) {
    console.error(`ERROR: User "${args.name}" not found.`)
    process.exit(1)
  }
  if (user.credentials.length === 0) {
    console.log(`User "${args.name}" has no passkeys.`)
    return
  }
  console.log(`Passkeys for "${args.name}" (${user.credentials.length}):`)
  for (const cred of user.credentials) {
    const registered = new Date(cred.registeredAt).toLocaleString()
    const transports = cred.transports?.join(', ') || 'unknown'
    console.log(`  ID: ${cred.credentialId}`)
    console.log(`    registered: ${registered}, counter: ${cred.counter}, transports: ${transports}`)
  }
}

export function handleDeletePasskey(args: ParsedArgs): void {
  if (!args.name) {
    console.error('ERROR: --name is required')
    process.exit(1)
  }
  if (!args.credentialIdArg) {
    console.error('ERROR: --credential-id is required')
    process.exit(1)
  }
  const result = removeCredential(args.name, args.credentialIdArg)
  if (result === 'user_not_found') {
    console.error(`ERROR: User "${args.name}" not found.`)
    process.exit(1)
  } else if (result === 'not_found') {
    console.error(`ERROR: Credential not found for user "${args.name}".`)
    process.exit(1)
  } else if (result === 'removed_and_revoked') {
    console.log(`Passkey deleted. This was "${args.name}"'s last passkey - user has been REVOKED.`)
    console.log('All active sessions terminated.')
  } else {
    console.log(`Passkey deleted for "${args.name}". All active sessions terminated.`)
  }
  notifyServer(args.cacheDir)
}
