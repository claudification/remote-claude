import type { Database } from 'bun:sqlite'
import { DuplicateEntry } from '../errors'
import type { ShareCreate, ShareRecord, ShareStore } from '../types'

type Row = Record<string, string | number | bigint | boolean | null>

function rowToShare(row: Row): ShareRecord {
  return {
    token: row.token as string,
    sessionId: row.session_id as string,
    permissions: JSON.parse(row.permissions as string),
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number,
    viewerCount: row.viewer_count as number,
  }
}

export function createSqliteShareStore(db: Database): ShareStore {
  const stmtGet = db.prepare('SELECT * FROM shares WHERE token = $token')
  const stmtInsert = db.prepare(`
    INSERT INTO shares (token, session_id, permissions, created_at, expires_at, viewer_count)
    VALUES ($token, $sessionId, $permissions, $createdAt, $expiresAt, 0)
  `)
  const stmtForConversation = db.prepare('SELECT * FROM shares WHERE session_id = $sessionId')
  const stmtIncrement = db.prepare('UPDATE shares SET viewer_count = viewer_count + 1 WHERE token = $token')
  const stmtDelete = db.prepare('DELETE FROM shares WHERE token = $token')
  const stmtDeleteExpired = db.prepare('DELETE FROM shares WHERE expires_at <= $now')

  return {
    create(input: ShareCreate) {
      const existing = stmtGet.get({ token: input.token })
      if (existing) throw new DuplicateEntry(`Share already exists: ${input.token}`)

      const now = Date.now()
      stmtInsert.run({
        token: input.token,
        sessionId: input.sessionId,
        permissions: JSON.stringify(input.permissions),
        createdAt: now,
        expiresAt: input.expiresAt,
      })
      return {
        token: input.token,
        sessionId: input.sessionId,
        permissions: input.permissions,
        createdAt: now,
        expiresAt: input.expiresAt,
        viewerCount: 0,
      }
    },

    get(token) {
      const row = stmtGet.get({ token }) as Row | null
      return row ? rowToShare(row) : null
    },

    getForConversation(sessionId) {
      const rows = stmtForConversation.all({ sessionId }) as Row[]
      return rows.map(rowToShare)
    },

    incrementViewerCount(token) {
      stmtIncrement.run({ token })
    },

    delete(token) {
      const result = stmtDelete.run({ token })
      return result.changes > 0
    },

    deleteExpired() {
      const result = stmtDeleteExpired.run({ now: Date.now() })
      return result.changes
    },
  }
}
