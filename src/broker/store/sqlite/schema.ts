import type { Database } from 'bun:sqlite'

export function createSchema(db: Database) {
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  db.run('PRAGMA synchronous = NORMAL')

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      agent_version TEXT,
      title TEXT,
      summary TEXT,
      label TEXT,
      icon TEXT,
      color TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      model TEXT,
      created_at INTEGER NOT NULL,
      ended_at INTEGER,
      last_activity INTEGER,
      meta TEXT,
      stats TEXT
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_sessions_scope ON sessions(scope)')
  db.run('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)')
  db.run('CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at)')

  db.run(`
    CREATE TABLE IF NOT EXISTS transcript_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      session_seq INTEGER NOT NULL,
      sync_epoch TEXT NOT NULL,
      type TEXT NOT NULL,
      subtype TEXT,
      agent_id TEXT,
      uuid TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL,
      UNIQUE(session_id, uuid)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript_entries(session_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_transcript_session_seq ON transcript_entries(session_id, session_seq)')
  db.run('CREATE INDEX IF NOT EXISTS idx_transcript_session_agent ON transcript_entries(session_id, agent_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_transcript_timestamp ON transcript_entries(timestamp)')

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_events_type ON events(session_id, type)')

  db.run(`
    CREATE TABLE IF NOT EXISTS scope_links (
      scope_a TEXT NOT NULL,
      scope_b TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      PRIMARY KEY(scope_a, scope_b)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_scope_links_a ON scope_links(scope_a)')
  db.run('CREATE INDEX IF NOT EXISTS idx_scope_links_b ON scope_links(scope_b)')

  db.run(`
    CREATE TABLE IF NOT EXISTS address_book (
      owner_scope TEXT NOT NULL,
      slug TEXT NOT NULL,
      target_scope TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used INTEGER,
      PRIMARY KEY(owner_scope, slug)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_address_book_target ON address_book(target_scope)')

  db.run(`
    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_scope TEXT NOT NULL,
      to_scope TEXT NOT NULL,
      from_session_id TEXT,
      content TEXT NOT NULL,
      intent TEXT,
      conversation_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_message_queue_to ON message_queue(to_scope)')
  db.run('CREATE INDEX IF NOT EXISTS idx_message_queue_expires ON message_queue(expires_at)')

  db.run(`
    CREATE TABLE IF NOT EXISTS message_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_scope TEXT NOT NULL,
      to_scope TEXT NOT NULL,
      from_session_id TEXT,
      to_session_id TEXT,
      content TEXT,
      intent TEXT,
      conversation_id TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_message_log_from ON message_log(from_scope)')
  db.run('CREATE INDEX IF NOT EXISTS idx_message_log_to ON message_log(to_scope)')
  db.run('CREATE INDEX IF NOT EXISTS idx_message_log_conv ON message_log(conversation_id)')

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      name TEXT,
      data TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      PRIMARY KEY(session_id, id)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(session_id, kind)')

  db.run(`
    CREATE TABLE IF NOT EXISTS shares (
      token TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      permissions TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      viewer_count INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_shares_session ON shares(session_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at)')

  db.run(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      project_uri TEXT NOT NULL DEFAULT '',
      account TEXT NOT NULL DEFAULT '',
      org_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      exact_cost INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns(timestamp)')
  db.run('CREATE INDEX IF NOT EXISTS idx_turns_account ON turns(account)')
  db.run('CREATE INDEX IF NOT EXISTS idx_turns_project_uri ON turns(project_uri)')

  db.run(`
    CREATE TABLE IF NOT EXISTS hourly_stats (
      hour TEXT NOT NULL,
      account TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      project_uri TEXT NOT NULL DEFAULT '',
      turn_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (hour, account, model, project_uri)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_hourly_hour ON hourly_stats(hour)')
  db.run('CREATE INDEX IF NOT EXISTS idx_hourly_project_uri ON hourly_stats(project_uri)')
}
