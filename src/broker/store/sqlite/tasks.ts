import type { Database } from 'bun:sqlite'
import type { TaskQuery, TaskRecord, TaskStore } from '../types'

type Row = Record<string, string | number | null>

function rowToTask(row: Row): TaskRecord {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    kind: row.kind as TaskRecord['kind'],
    status: row.status as string,
    name: (row.name as string) ?? undefined,
    description: (row.description as string) ?? undefined,
    priority: row.priority == null ? undefined : (row.priority as number),
    orderIndex: row.order_index == null ? undefined : (row.order_index as number),
    blockedBy: row.blocked_by ? (JSON.parse(row.blocked_by as string) as string[]) : undefined,
    blocks: row.blocks ? (JSON.parse(row.blocks as string) as string[]) : undefined,
    owner: (row.owner as string) ?? undefined,
    data: row.data ? (JSON.parse(row.data as string) as Record<string, unknown>) : undefined,
    createdAt: row.created_at as number,
    updatedAt: (row.updated_at as number) ?? undefined,
    completedAt: (row.completed_at as number) ?? undefined,
    archivedAt: (row.archived_at as number) ?? undefined,
  }
}

export function createSqliteTaskStore(db: Database): TaskStore {
  const stmtUpsert = db.prepare(`
    INSERT INTO tasks (
      id, conversation_id, kind, status, name, description,
      priority, order_index, blocked_by, blocks, owner, data,
      created_at, updated_at, completed_at, archived_at
    )
    VALUES (
      $id, $conversationId, $kind, $status, $name, $description,
      $priority, $orderIndex, $blockedBy, $blocks, $owner, $data,
      $createdAt, $updatedAt, $completedAt, $archivedAt
    )
    ON CONFLICT(conversation_id, id) DO UPDATE SET
      kind = $kind,
      status = $status,
      name = $name,
      description = $description,
      priority = $priority,
      order_index = $orderIndex,
      blocked_by = $blockedBy,
      blocks = $blocks,
      owner = $owner,
      data = $data,
      updated_at = $updatedAt,
      completed_at = $completedAt,
      archived_at = $archivedAt
  `)
  const stmtDelete = db.prepare('DELETE FROM tasks WHERE conversation_id = $conversationId AND id = $id')
  const stmtDeleteAll = db.prepare('DELETE FROM tasks WHERE conversation_id = $conversationId')
  const stmtPruneArchived = db.prepare('DELETE FROM tasks WHERE archived_at IS NOT NULL AND archived_at < $cutoff')

  return {
    upsert(conversationId, task) {
      stmtUpsert.run({
        id: task.id,
        conversationId,
        kind: task.kind,
        status: task.status,
        name: task.name ?? null,
        description: task.description ?? null,
        priority: task.priority ?? null,
        orderIndex: task.orderIndex ?? null,
        blockedBy: task.blockedBy ? JSON.stringify(task.blockedBy) : null,
        blocks: task.blocks ? JSON.stringify(task.blocks) : null,
        owner: task.owner ?? null,
        data: task.data ? JSON.stringify(task.data) : null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt ?? null,
        completedAt: task.completedAt ?? null,
        archivedAt: task.archivedAt ?? null,
      })
    },

    getForConversation(conversationId, query?: TaskQuery) {
      const where: string[] = ['conversation_id = $conversationId']
      const params: Record<string, string | number> = { conversationId }
      if (query?.kind) {
        where.push('kind = $kind')
        params.kind = query.kind
      }
      if (query?.archived === true) {
        where.push('archived_at IS NOT NULL')
      } else if (query?.archived === false) {
        where.push('archived_at IS NULL')
      }
      if (query?.archivedSince != null) {
        where.push('archived_at >= $archivedSince')
        params.archivedSince = query.archivedSince
      }
      let sql = `SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY COALESCE(order_index, 0), created_at`
      if (query?.limit) {
        sql += ` LIMIT ${Math.max(1, Math.floor(query.limit))}`
      }
      const rows = db.prepare(sql).all(params) as Row[]
      return rows.map(rowToTask)
    },

    delete(conversationId, taskId) {
      const result = stmtDelete.run({ conversationId, id: taskId })
      return result.changes > 0
    },

    deleteForConversation(conversationId) {
      const result = stmtDeleteAll.run({ conversationId })
      return result.changes
    },

    pruneArchivedBefore(cutoffMs) {
      const result = stmtPruneArchived.run({ cutoff: cutoffMs })
      return result.changes
    },
  }
}
