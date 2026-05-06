import type { Database } from 'bun:sqlite'
import type { EnqueueMessage, MessageLogEntry, MessageStore, QueuedMessage } from '../types'

type Params = Record<string, string | number | bigint | boolean | null>

export function createSqliteMessageStore(db: Database): MessageStore {
  const stmtEnqueue = db.prepare(`
    INSERT INTO message_queue (from_scope, to_scope, from_conversation_id, content, intent, conversation_id, created_at, expires_at)
    VALUES ($fromScope, $toScope, $fromSessionId, $content, $intent, $conversationId, $createdAt, $expiresAt)
  `)

  const stmtDequeue = db.prepare(
    'SELECT * FROM message_queue WHERE to_scope = $toScope AND expires_at > $now ORDER BY id ASC',
  )
  const stmtDeleteDequeued = db.prepare('DELETE FROM message_queue WHERE to_scope = $toScope AND expires_at > $now')

  const stmtLogInsert = db.prepare(`
    INSERT INTO message_log (from_scope, to_scope, from_conversation_id, to_conversation_id, content, intent, conversation_id, created_at)
    VALUES ($fromScope, $toScope, $fromSessionId, $toSessionId, $content, $intent, $conversationId, $createdAt)
  `)

  const stmtPruneExpired = db.prepare('DELETE FROM message_queue WHERE expires_at <= $now')

  return {
    enqueue(msg: EnqueueMessage) {
      stmtEnqueue.run({
        fromScope: msg.fromScope,
        toScope: msg.toScope,
        fromSessionId: msg.fromSessionId ?? null,
        content: msg.content,
        intent: msg.intent ?? null,
        conversationId: msg.conversationId ?? null,
        createdAt: Date.now(),
        expiresAt: msg.expiresAt,
      })
    },

    dequeueFor(scope) {
      const now = Date.now()
      const doDequeue = db.transaction(() => {
        const rows = stmtDequeue.all({ toScope: scope, now }) as Params[]
        stmtDeleteDequeued.run({ toScope: scope, now })
        return rows.map(
          (row): QueuedMessage => ({
            id: row.id as number,
            fromScope: row.from_scope as string,
            toScope: row.to_scope as string,
            fromSessionId: (row.from_conversation_id as string) ?? undefined,
            content: row.content as string,
            intent: (row.intent as string) ?? undefined,
            conversationId: (row.conversation_id as string) ?? undefined,
            createdAt: row.created_at as number,
          }),
        )
      })
      return doDequeue()
    },

    log(entry: MessageLogEntry) {
      stmtLogInsert.run({
        fromScope: entry.fromScope,
        toScope: entry.toScope,
        fromSessionId: entry.fromSessionId ?? null,
        toSessionId: entry.toSessionId ?? null,
        content: entry.content ?? null,
        intent: entry.intent ?? null,
        conversationId: entry.conversationId ?? null,
        createdAt: entry.createdAt,
      })
    },

    queryLog(opts) {
      let sql = 'SELECT * FROM message_log WHERE 1=1'
      const params: Params = {}

      if (opts?.scope) {
        sql += ' AND (from_scope = $scope OR to_scope = $scope)'
        params.scope = opts.scope
      }
      if (opts?.conversationId) {
        sql += ' AND conversation_id = $conversationId'
        params.conversationId = opts.conversationId
      }
      if (opts?.afterId != null) {
        sql += ' AND id > $afterId'
        params.afterId = opts.afterId
      }

      sql += ' ORDER BY created_at DESC'

      if (opts?.limit) {
        sql += ' LIMIT $limit'
        params.limit = opts.limit
      }

      const rows = db.prepare(sql).all(params) as Params[]
      return rows.map(
        (row): MessageLogEntry => ({
          id: row.id as number,
          fromScope: row.from_scope as string,
          toScope: row.to_scope as string,
          fromSessionId: (row.from_conversation_id as string) ?? undefined,
          toSessionId: (row.to_conversation_id as string) ?? undefined,
          content: (row.content as string) ?? undefined,
          intent: (row.intent as string) ?? undefined,
          conversationId: (row.conversation_id as string) ?? undefined,
          createdAt: row.created_at as number,
        }),
      )
    },

    pruneExpired() {
      const result = stmtPruneExpired.run({ now: Date.now() })
      return result.changes
    },
  }
}
