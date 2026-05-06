import type { Database } from 'bun:sqlite'

/**
 * Migration: Rename session_id -> conversation_id, session_seq -> seq
 * in all tables. Uses ALTER TABLE RENAME COLUMN (SQLite 3.25+).
 */
export function migrateSessionColumns(db: Database) {
  // Check if the old `sessions` table exists (needs migration)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").all()
  if (tables.length === 0) {
    return // fresh DB or already migrated
  }

  // Double-check: if conversation_id already exists in transcript_entries, skip
  const cols = db.prepare('PRAGMA table_info(transcript_entries)').all() as Array<{ name: string }>
  if (cols.some(c => c.name === 'conversation_id')) {
    return // already migrated
  }

  db.run('BEGIN TRANSACTION')
  try {
    // Rename the conversations table itself
    db.run('ALTER TABLE sessions RENAME TO conversations')

    // transcript_entries: session_id -> conversation_id, conversation_seq -> seq
    db.run('ALTER TABLE transcript_entries RENAME COLUMN session_id TO conversation_id')
    db.run('ALTER TABLE transcript_entries RENAME COLUMN session_seq TO seq')

    // events: conversation_id -> conversation_id
    db.run('ALTER TABLE events RENAME COLUMN session_id TO conversation_id')

    // tasks: conversation_id -> conversation_id
    db.run('ALTER TABLE tasks RENAME COLUMN session_id TO conversation_id')

    // shares: conversation_id -> conversation_id
    db.run('ALTER TABLE shares RENAME COLUMN session_id TO conversation_id')

    // turns: conversation_id -> conversation_id
    db.run('ALTER TABLE turns RENAME COLUMN session_id TO conversation_id')

    // message_queue + message_log column renames handled by migrate-messages.ts

    // Drop old indexes and recreate with new names
    // (SQLite auto-updates indexes on column rename, but names stay old)
    db.run('DROP INDEX IF EXISTS idx_transcript_session')
    db.run('DROP INDEX IF EXISTS idx_transcript_session_seq')
    db.run('DROP INDEX IF EXISTS idx_transcript_session_agent')
    db.run('DROP INDEX IF EXISTS idx_events_session')
    db.run('DROP INDEX IF EXISTS idx_events_type')
    db.run('DROP INDEX IF EXISTS idx_tasks_session')
    db.run('DROP INDEX IF EXISTS idx_tasks_kind')
    db.run('DROP INDEX IF EXISTS idx_shares_session')
    db.run('DROP INDEX IF EXISTS idx_sessions_scope')
    db.run('DROP INDEX IF EXISTS idx_sessions_status')
    db.run('DROP INDEX IF EXISTS idx_sessions_created_at')

    // Recreate indexes with correct names
    db.run('CREATE INDEX idx_conversations_scope ON conversations(scope)')
    db.run('CREATE INDEX idx_conversations_status ON conversations(status)')
    db.run('CREATE INDEX idx_conversations_created_at ON conversations(created_at)')
    db.run('CREATE INDEX idx_transcript_conversation ON transcript_entries(conversation_id)')
    db.run('CREATE INDEX idx_transcript_conversation_seq ON transcript_entries(conversation_id, seq)')
    db.run('CREATE INDEX idx_transcript_conversation_agent ON transcript_entries(conversation_id, agent_id)')
    db.run('CREATE INDEX idx_events_conversation ON events(conversation_id)')
    db.run('CREATE INDEX idx_events_conversation_type ON events(conversation_id, type)')
    db.run('CREATE INDEX idx_tasks_conversation ON tasks(conversation_id)')
    db.run('CREATE INDEX idx_tasks_conversation_kind ON tasks(conversation_id, kind)')
    db.run('CREATE INDEX idx_shares_conversation ON shares(conversation_id)')

    db.run('COMMIT')
  } catch (e) {
    db.run('ROLLBACK')
    throw e
  }
}
