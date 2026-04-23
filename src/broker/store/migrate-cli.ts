import { homedir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './index'
import { dryRunScan, migrateFromLegacy } from './migrate'

export function runMigrateCli(args: { cacheDir?: string; dataDir?: string; dryRun?: boolean }): void {
  const cacheDir = args.cacheDir || join(homedir(), '.cache', 'broker')
  const dataDir = args.dataDir || cacheDir

  console.log(`Source:  ${cacheDir}`)
  console.log(`Target:  ${join(dataDir, 'store.db')}`)
  console.log()

  if (args.dryRun) {
    console.log('=== DRY RUN ===')
    console.log()
    const scan = dryRunScan(cacheDir)
    let anyFound = false

    for (const [name, info] of Object.entries(scan.files)) {
      if (!info.exists) continue
      anyFound = true
      const countStr = info.entries !== undefined ? ` (${info.entries} entries)` : ''
      console.log(`  [found] ${name}${countStr}`)
    }

    if (!anyFound) {
      console.log('  No legacy files found.')
    }

    console.log()
    console.log('No changes made.')
    return
  }

  const store = createStore({ type: 'sqlite', dataDir })
  store.init()

  try {
    const result = migrateFromLegacy(store, cacheDir)

    console.log('=== Migration Complete ===')
    console.log()

    const { counts } = result
    if (counts.sessions > 0) console.log(`  Sessions:            ${counts.sessions}`)
    if (counts.transcripts > 0)
      console.log(`  Transcripts:         ${counts.transcripts} files, ${counts.transcriptEntries} entries`)
    if (counts.globalSettings > 0) console.log(`  Global settings:     migrated`)
    if (counts.projectSettings > 0) console.log(`  Project settings:    migrated`)
    if (counts.sessionOrder > 0) console.log(`  Session order:       migrated`)
    if (counts.shares > 0) console.log(`  Shares:              ${counts.shares}`)
    if (counts.addressBook > 0) console.log(`  Address book:        ${counts.addressBook} entries`)
    if (counts.projectLinks > 0) console.log(`  Project links:       ${counts.projectLinks}`)
    if (counts.messageQueue > 0) console.log(`  Message queue:       ${counts.messageQueue}`)
    if (counts.interSessionLog > 0) console.log(`  Inter-session log:   ${counts.interSessionLog} entries`)

    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    if (total === 0) {
      console.log('  No data found to migrate.')
    }

    if (result.warnings.length > 0) {
      console.log()
      console.log(`Warnings (${result.warnings.length}):`)
      for (const w of result.warnings) {
        console.log(`  ! ${w}`)
      }
    }

    if (result.errors.length > 0) {
      console.log()
      console.log(`Errors (${result.errors.length}):`)
      for (const e of result.errors) {
        console.log(`  X ${e}`)
      }
    }

    console.log()
    console.log('Legacy files NOT deleted. Remove them manually after verifying the migration.')
  } finally {
    store.close()
  }
}
