import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import type { StoreConfig, StoreDriver } from '../types'
import { createSqliteAddressBookStore } from './address-book'
import { createSqliteSessionStore } from './conversations'
import { createSqliteCostStore } from './costs'
import { createSqliteEventStore } from './events'
import { createSqliteKVStore } from './kv'
import { createSqliteMessageStore } from './messages'
import { migrateSessionColumns } from './migrate-session-columns'
import { createSchema } from './schema'
import { createSqliteScopeLinkStore } from './scope-links'
import { createSqliteShareStore } from './shares'
import { createSqliteTaskStore } from './tasks'
import { createSqliteTranscriptStore } from './transcripts'

export function createSqliteDriver(config: StoreConfig): StoreDriver {
  const filename = config.filename ?? join(config.dataDir ?? '.', 'store.db')
  const db = new Database(filename, { strict: true })
  migrateSessionColumns(db)
  createSchema(db)

  return {
    conversations: createSqliteSessionStore(db),
    transcripts: createSqliteTranscriptStore(db),
    events: createSqliteEventStore(db),
    kv: createSqliteKVStore(db),
    messages: createSqliteMessageStore(db),
    shares: createSqliteShareStore(db),
    addressBook: createSqliteAddressBookStore(db),
    scopeLinks: createSqliteScopeLinkStore(db),
    tasks: createSqliteTaskStore(db),
    costs: createSqliteCostStore(db),

    init() {},

    close() {
      db.close()
    },

    compact() {
      db.run('PRAGMA wal_checkpoint(TRUNCATE)')
      db.run('VACUUM')
    },
  }
}
