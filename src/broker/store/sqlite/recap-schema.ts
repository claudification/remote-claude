import type { Database } from 'bun:sqlite'

export function createRecapSchema(db: Database) {
  createRecapsTable(db)
  createRecapLogsTable(db)
  createRecapChunksTable(db)
  createRecapTagsTable(db)
  createRecapsFtsTable(db)
}

function createRecapsTable(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS recaps (
      id              TEXT PRIMARY KEY,
      project_uri     TEXT NOT NULL,
      period_label    TEXT NOT NULL,
      period_start    INTEGER NOT NULL,
      period_end      INTEGER NOT NULL,
      time_zone       TEXT NOT NULL,
      status          TEXT NOT NULL,
      progress        INTEGER NOT NULL DEFAULT 0,
      phase           TEXT,
      model           TEXT,
      input_chars     INTEGER NOT NULL DEFAULT 0,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      llm_cost_usd    REAL NOT NULL DEFAULT 0,
      markdown        TEXT,
      title           TEXT,
      subtitle        TEXT,
      error           TEXT,
      created_at      INTEGER NOT NULL,
      created_by      TEXT,
      started_at      INTEGER,
      completed_at    INTEGER,
      dismissed_at    INTEGER,
      signals_json    TEXT NOT NULL,
      signals_hash    TEXT NOT NULL,
      input_hash      TEXT,
      metadata_json   TEXT
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_recaps_project ON recaps(project_uri, created_at DESC)')
  db.run('CREATE INDEX IF NOT EXISTS idx_recaps_status ON recaps(status)')
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_recaps_active ON recaps(status) WHERE status IN ('queued','gathering','rendering')",
  )
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_recaps_cache_lookup ON recaps(project_uri, period_start, period_end, signals_hash, status, completed_at)',
  )
  db.run('CREATE INDEX IF NOT EXISTS idx_recaps_input_hash ON recaps(input_hash) WHERE input_hash IS NOT NULL')
}

function createRecapLogsTable(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS recap_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      recap_id    TEXT NOT NULL,
      timestamp   INTEGER NOT NULL,
      level       TEXT NOT NULL,
      phase       TEXT NOT NULL,
      message     TEXT NOT NULL,
      data_json   TEXT
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_recap_logs_recap ON recap_logs(recap_id, timestamp)')
}

function createRecapChunksTable(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS recap_chunks (
      id            TEXT PRIMARY KEY,
      parent_id     TEXT NOT NULL REFERENCES recaps(id) ON DELETE CASCADE,
      chunk_kind    TEXT NOT NULL,
      chunk_start   INTEGER NOT NULL,
      chunk_end     INTEGER NOT NULL,
      markdown      TEXT NOT NULL,
      input_chars   INTEGER NOT NULL,
      input_tokens  INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_usd      REAL NOT NULL DEFAULT 0,
      model         TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_recap_chunks_parent ON recap_chunks(parent_id, chunk_start)')
}

function createRecapTagsTable(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS recap_tags (
      recap_id  TEXT NOT NULL,
      tag       TEXT NOT NULL,
      kind      TEXT NOT NULL,
      PRIMARY KEY (recap_id, tag, kind)
    )
  `)
  db.run('CREATE INDEX IF NOT EXISTS idx_recap_tags_tag ON recap_tags(tag)')
  db.run('CREATE INDEX IF NOT EXISTS idx_recap_tags_kind_tag ON recap_tags(kind, tag)')
}

// No triggers -- explicit sync from app code on markRecapDone (json_extract
// can't join JSON arrays from metadata_json, so we do it in JS instead).
function createRecapsFtsTable(db: Database) {
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS recaps_fts USING fts5(
      recap_id UNINDEXED,
      project_uri UNINDEXED,
      title,
      subtitle,
      keywords,
      goals,
      discoveries,
      side_effects,
      body,
      tokenize = 'porter unicode61'
    )
  `)
}
