import type { Database } from 'bun:sqlite'
import type { TaskRecord, TaskStore } from '../types'

function rowToTask(row: Record<string, string | number | null>): TaskRecord {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    kind: row.kind as TaskRecord['kind'],
    status: row.status as string,
    name: (row.name as string) ?? undefined,
    data: row.data ? JSON.parse(row.data as string) : undefined,
    createdAt: row.created_at as number,
    updatedAt: (row.updated_at as number) ?? undefined,
  }
}

export function createSqliteTaskStore(db: Database): TaskStore {
  const stmtUpsert = db.prepare(`
    INSERT INTO tasks (id, session_id, kind, status, name, data, created_at, updated_at)
    VALUES ($id, $sessionId, $kind, $status, $name, $data, $createdAt, $updatedAt)
    ON CONFLICT(session_id, id) DO UPDATE SET
      kind = $kind, status = $status, name = $name, data = $data, updated_at = $updatedAt
  `)
  const stmtForConversation = db.prepare('SELECT * FROM tasks WHERE session_id = $sessionId')
  const stmtForSessionKind = db.prepare('SELECT * FROM tasks WHERE session_id = $sessionId AND kind = $kind')
  const stmtDelete = db.prepare('DELETE FROM tasks WHERE session_id = $sessionId AND id = $id')
  const stmtDeleteAll = db.prepare('DELETE FROM tasks WHERE session_id = $sessionId')

  return {
    upsert(sessionId, task) {
      stmtUpsert.run({
        id: task.id,
        sessionId,
        kind: task.kind,
        status: task.status,
        name: task.name ?? null,
        data: task.data ? JSON.stringify(task.data) : null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt ?? null,
      })
    },

    getForConversation(sessionId, kind?) {
      if (kind) {
        const rows = stmtForSessionKind.all({ sessionId, kind }) as Record<string, string | number | null>[]
        return rows.map(rowToTask)
      }
      const rows = stmtForConversation.all({ sessionId }) as Record<string, string | number | null>[]
      return rows.map(rowToTask)
    },

    delete(sessionId, taskId) {
      const result = stmtDelete.run({ sessionId, id: taskId })
      return result.changes > 0
    },

    deleteForConversation(sessionId) {
      const result = stmtDeleteAll.run({ sessionId })
      return result.changes
    },
  }
}
