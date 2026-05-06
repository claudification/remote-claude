import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createBackup, listBackups, restoreBackup } from '../backup'
import type { ParsedArgs } from './parse-args'
import { DEFAULT_BACKUP_DIR } from './shared'

function getDestDir(args: ParsedArgs): string {
  return args.destArg || DEFAULT_BACKUP_DIR
}

async function handleCreate(args: ParsedArgs): Promise<void> {
  const destDir = getDestDir(args)
  const retainHours = args.retainHoursArg ? parseInt(args.retainHoursArg, 10) : 24
  const retainDays = args.retainDaysArg ? parseInt(args.retainDaysArg, 10) : 7

  if (Number.isNaN(retainHours) || retainHours < 1) {
    console.error('ERROR: --retain-hours must be a positive integer')
    process.exit(1)
  }
  if (Number.isNaN(retainDays) || retainDays < 1) {
    console.error('ERROR: --retain-days must be a positive integer')
    process.exit(1)
  }

  await createBackup({
    cacheDir: args.cacheDir,
    destDir,
    includeBlobs: args.includeBlobs,
    retainHours,
    retainDays,
  })
}

function handleList(args: ParsedArgs): void {
  const destDir = getDestDir(args)
  const backups = listBackups(destDir)

  if (backups.length === 0) {
    console.log(`No backups found in ${destDir}`)
    return
  }

  console.log(`\n  Backups in ${destDir} (${backups.length}):\n`)
  const pad = (s: string, n: number) => s.padEnd(n)
  console.log(`  ${pad('FILENAME', 38)} ${pad('SIZE', 12)} TIMESTAMP`)
  console.log(`  ${'─'.repeat(38)} ${'─'.repeat(12)} ${'─'.repeat(20)}`)

  for (const b of backups) {
    const sizeMB = `${(b.size / 1024 / 1024).toFixed(1)} MB`
    const ts = b.timestamp.toISOString().replace('T', ' ').slice(0, 19)
    console.log(`  ${pad(b.filename, 38)} ${pad(sizeMB, 12)} ${ts}`)
  }
  console.log()
}

async function handleRestore(args: ParsedArgs): Promise<void> {
  if (!args.backupArchive) {
    console.error(
      'ERROR: provide archive path, e.g. broker-cli backup restore /data/backups/backup-20260506-120000.tar.gz',
    )
    process.exit(1)
  }

  const archivePath = resolve(args.backupArchive)
  if (!existsSync(archivePath)) {
    console.error(`ERROR: archive not found: ${archivePath}`)
    process.exit(1)
  }

  await restoreBackup(archivePath, args.cacheDir)
}

export async function handleBackup(args: ParsedArgs): Promise<void> {
  switch (args.subCommand) {
    case 'create':
      await handleCreate(args)
      break
    case 'list':
      handleList(args)
      break
    case 'restore':
      await handleRestore(args)
      break
    default:
      console.error(`Unknown backup subcommand: ${args.subCommand || '(none)'}`)
      console.error('Available: create, list, restore')
      process.exit(1)
  }
}
