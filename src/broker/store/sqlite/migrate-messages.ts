import type { Database } from 'bun:sqlite'

/**
 * Migration: Fix message table column names and add new columns.
 *
 * 1. Rename from_session_id -> from_conversation_id (message_queue + message_log)
 * 2. Rename to_session_id -> to_conversation_id (message_log)
 * 3. Add from_name, target_name columns to message_queue
 * 4. Add from_name, to_name, full_length columns to message_log
 * 5. Migrate data from KV inter-session-log into message_log table
 * 6. Drop stale duplicate indexes from the old session-named schema
 */
export function migrateMessages(db: Database) {
  const cols = db.prepare('PRAGMA table_info(message_queue)').all() as Array<{ name: string }>
  const colNames = new Set(cols.map(c => c.name))

  // Already migrated (fresh DB with new schema)
  if (colNames.has('from_conversation_id')) return

  // Only run if old columns exist
  if (!colNames.has('from_session_id')) return

  db.run('BEGIN TRANSACTION')
  try {
    // Rename columns
    db.run('ALTER TABLE message_queue RENAME COLUMN from_session_id TO from_conversation_id')

    const logCols = db.prepare('PRAGMA table_info(message_log)').all() as Array<{ name: string }>
    const logColNames = new Set(logCols.map(c => c.name))
    if (logColNames.has('from_session_id')) {
      db.run('ALTER TABLE message_log RENAME COLUMN from_session_id TO from_conversation_id')
    }
    if (logColNames.has('to_session_id')) {
      db.run('ALTER TABLE message_log RENAME COLUMN to_session_id TO to_conversation_id')
    }

    // Add new columns to message_queue
    if (!colNames.has('from_name')) {
      db.run('ALTER TABLE message_queue ADD COLUMN from_name TEXT')
    }
    if (!colNames.has('target_name')) {
      db.run('ALTER TABLE message_queue ADD COLUMN target_name TEXT')
    }

    // Add new columns to message_log
    if (!logColNames.has('from_name')) {
      db.run('ALTER TABLE message_log ADD COLUMN from_name TEXT')
    }
    if (!logColNames.has('to_name')) {
      db.run('ALTER TABLE message_log ADD COLUMN to_name TEXT')
    }
    if (!logColNames.has('full_length')) {
      db.run('ALTER TABLE message_log ADD COLUMN full_length INTEGER')
    }

    // Drop stale session-named indexes (created by old schema.ts)
    db.run('DROP INDEX IF EXISTS idx_transcript_session')
    db.run('DROP INDEX IF EXISTS idx_transcript_session_seq')
    db.run('DROP INDEX IF EXISTS idx_transcript_session_agent')
    db.run('DROP INDEX IF EXISTS idx_events_session')
    db.run('DROP INDEX IF EXISTS idx_events_type')
    db.run('DROP INDEX IF EXISTS idx_tasks_session')
    db.run('DROP INDEX IF EXISTS idx_tasks_kind')
    db.run('DROP INDEX IF EXISTS idx_shares_session')

    // Migrate inter-session-log from KV to message_log table
    migrateKvLogEntries(db)

    db.run('COMMIT')
  } catch (e) {
    db.run('ROLLBACK')
    throw e
  }
}

function migrateKvLogEntries(db: Database) {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'inter-session-log'").get() as { value: string } | null
  if (!row) return

  let entries: Array<Record<string, unknown>>
  try {
    entries = JSON.parse(row.value)
    if (!Array.isArray(entries)) return
  } catch {
    return
  }

  const stmt = db.prepare(`
    INSERT INTO message_log (from_scope, to_scope, from_conversation_id, to_conversation_id, from_name, to_name, content, intent, conversation_id, full_length, created_at)
    VALUES ($fromScope, $toScope, $fromConversationId, $toConversationId, $fromName, $toName, $content, $intent, $conversationId, $fullLength, $createdAt)
  `)

  for (const entry of entries) {
    const from = entry.from as Record<string, string> | undefined
    const to = entry.to as Record<string, string> | undefined
    if (!from || !to) continue

    stmt.run({
      fromScope: from.project || from.cwd || '',
      toScope: to.project || to.cwd || '',
      fromConversationId: from.conversationId || null,
      toConversationId: to.conversationId || null,
      fromName: from.name || null,
      toName: to.name || null,
      content: (entry.preview as string) || null,
      intent: (entry.intent as string) || null,
      conversationId: (entry.conversationId as string) || null,
      fullLength: (entry.fullLength as number) || null,
      createdAt: (entry.ts as number) || Date.now(),
    })
  }

  // Remove the KV entry now that data lives in the table
  db.run("DELETE FROM kv WHERE key = 'inter-session-log'")
}
