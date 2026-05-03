import type { Database } from 'bun:sqlite'
import type { EventInput, EventRecord, EventStore } from '../types'

type Params = Record<string, string | number | bigint | boolean | null>

function rowToEvent(row: Params): EventRecord {
  return {
    id: row.id as number,
    ccSessionId: row.session_id as string,
    type: row.type as string,
    data: row.data ? JSON.parse(row.data as string) : undefined,
    createdAt: row.created_at as number,
  }
}

export function createSqliteEventStore(db: Database): EventStore {
  const stmtInsert = db.prepare(`
    INSERT INTO events (session_id, type, data, created_at)
    VALUES ($sessionId, $type, $data, $createdAt)
  `)

  return {
    append(ccSessionId, event: EventInput) {
      stmtInsert.run({
        sessionId: ccSessionId,
        type: event.type,
        data: event.data ? JSON.stringify(event.data) : null,
        createdAt: Date.now(),
      })
    },

    getForConversation(ccSessionId, opts) {
      let sql = 'SELECT * FROM events WHERE session_id = $sessionId'
      const params: Params = { sessionId: ccSessionId }

      if (opts?.types?.length) {
        const placeholders = opts.types.map((_, i) => `$type${i}`)
        sql += ` AND type IN (${placeholders.join(', ')})`
        for (let i = 0; i < opts.types.length; i++) {
          params[`type${i}`] = opts.types[i]
        }
      }

      if (opts?.afterId != null) {
        sql += ' AND id > $afterId'
        params.afterId = opts.afterId
      }

      sql += ' ORDER BY id ASC'

      if (opts?.limit) {
        const allRows = db.prepare(sql).all(params) as Params[]
        return allRows.slice(-opts.limit).map(rowToEvent)
      }

      const rows = db.prepare(sql).all(params) as Params[]
      return rows.map(rowToEvent)
    },

    pruneOlderThan(cutoffMs) {
      const result = db.prepare('DELETE FROM events WHERE created_at < $cutoff').run({ cutoff: cutoffMs })
      return result.changes
    },
  }
}
