import type { Database } from 'bun:sqlite'

export function createSchema(db: Database) {
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  db.run('PRAGMA synchronous = NORMAL')

  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
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
  db.run('CREATE INDEX IF NOT EXISTS idx_conversations_scope ON conversations(scope)')
  db.run('CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status)')
  db.run('CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at)')

  db.run(`
    CREATE TABLE IF NOT EXISTS transcript_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      sync_epoch TEXT NOT NULL,
      type TEXT NOT NULL,
      subtype TEXT,
      agent_id TEXT,
      uuid TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL,
      UNIQUE(conversation_id, uuid)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_transcript_conversation ON transcript_entries(conversation_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_transcript_conversation_seq ON transcript_entries(conversation_id, seq)')
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_transcript_conversation_agent ON transcript_entries(conversation_id, agent_id)',
  )
  db.run('CREATE INDEX IF NOT EXISTS idx_transcript_timestamp ON transcript_entries(timestamp)')

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
      content,
      content=transcript_entries,
      content_rowid=id,
      tokenize='porter unicode61'
    )
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS transcript_fts_ai AFTER INSERT ON transcript_entries BEGIN
      INSERT INTO transcript_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS transcript_fts_ad AFTER DELETE ON transcript_entries BEGIN
      INSERT INTO transcript_fts(transcript_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS transcript_fts_au AFTER UPDATE ON transcript_entries BEGIN
      INSERT INTO transcript_fts(transcript_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO transcript_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)

  // Backfill: if FTS index is empty but transcript_entries has data, rebuild.
  // Uses transcript_fts_docsize (one row per indexed doc) as the emptiness probe.
  const indexed = db.prepare('SELECT COUNT(*) AS cnt FROM transcript_fts_docsize').get() as { cnt: number }
  const tx = db.prepare('SELECT COUNT(*) AS cnt FROM transcript_entries').get() as { cnt: number }
  if (indexed.cnt === 0 && tx.cnt > 0) {
    const start = Date.now()
    db.run("INSERT INTO transcript_fts(transcript_fts) VALUES('rebuild')")
    const ms = Date.now() - start
    console.error(
      `[fts] backfilled ${tx.cnt} transcript entries in ${ms}ms (${Math.round(tx.cnt / Math.max(ms, 1))} entries/ms)`,
    )
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_events_conversation ON events(conversation_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_events_conversation_type ON events(conversation_id, type)')

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
      from_conversation_id TEXT,
      from_name TEXT,
      target_name TEXT,
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
      from_conversation_id TEXT,
      to_conversation_id TEXT,
      from_name TEXT,
      to_name TEXT,
      content TEXT,
      intent TEXT,
      conversation_id TEXT,
      full_length INTEGER,
      created_at INTEGER NOT NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_message_log_from ON message_log(from_scope)')
  db.run('CREATE INDEX IF NOT EXISTS idx_message_log_to ON message_log(to_scope)')
  db.run('CREATE INDEX IF NOT EXISTS idx_message_log_conv ON message_log(conversation_id)')

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      name TEXT,
      description TEXT,
      priority INTEGER,
      order_index INTEGER,
      blocked_by TEXT,
      blocks TEXT,
      owner TEXT,
      data TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      completed_at INTEGER,
      archived_at INTEGER,
      PRIMARY KEY(conversation_id, id)
    )
  `)
  // ALTER ADD COLUMN for upgrades from the v0 shape (id/conv/kind/status/name/data/created_at/updated_at).
  // SQLite ALTER ADD COLUMN is idempotent only if you guard it -- check column list first.
  const taskCols = new Set((db.prepare("PRAGMA table_info('tasks')").all() as Array<{ name: string }>).map(r => r.name))
  for (const [col, ddl] of [
    ['description', 'description TEXT'],
    ['priority', 'priority INTEGER'],
    ['order_index', 'order_index INTEGER'],
    ['blocked_by', 'blocked_by TEXT'],
    ['blocks', 'blocks TEXT'],
    ['owner', 'owner TEXT'],
    ['completed_at', 'completed_at INTEGER'],
    ['archived_at', 'archived_at INTEGER'],
  ] as const) {
    if (!taskCols.has(col)) db.run(`ALTER TABLE tasks ADD COLUMN ${ddl}`)
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_conversation_kind ON tasks(conversation_id, kind)')
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_conversation_active ON tasks(conversation_id) WHERE archived_at IS NULL')
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_archived_at ON tasks(archived_at) WHERE archived_at IS NOT NULL')

  db.run(`
    CREATE TABLE IF NOT EXISTS shares (
      token TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      permissions TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      viewer_count INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_shares_conversation ON shares(conversation_id)')
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
      conversation_id TEXT NOT NULL,
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
