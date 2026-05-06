import type { Database } from 'bun:sqlite'
import type { EnqueueMessage, MessageLogEntry, MessageStore, QueuedMessage } from '../types'

type Params = Record<string, string | number | bigint | boolean | null>

export function createSqliteMessageStore(db: Database): MessageStore {
  const stmtEnqueue = db.prepare(`
    INSERT INTO message_queue (from_scope, to_scope, from_conversation_id, from_name, target_name, content, intent, conversation_id, created_at, expires_at)
    VALUES ($fromScope, $toScope, $fromConversationId, $fromName, $targetName, $content, $intent, $conversationId, $createdAt, $expiresAt)
  `)

  const stmtDequeue = db.prepare(
    'SELECT * FROM message_queue WHERE to_scope = $toScope AND expires_at > $now ORDER BY id ASC',
  )
  const stmtDequeueFiltered = db.prepare(
    'SELECT * FROM message_queue WHERE to_scope = $toScope AND expires_at > $now AND (target_name IS NULL OR target_name = $targetName) ORDER BY id ASC',
  )
  const stmtDeleteDequeued = db.prepare('DELETE FROM message_queue WHERE to_scope = $toScope AND expires_at > $now')
  const stmtDeleteDequeuedFiltered = db.prepare(
    'DELETE FROM message_queue WHERE to_scope = $toScope AND expires_at > $now AND (target_name IS NULL OR target_name = $targetName)',
  )

  const stmtCountFor = db.prepare(
    'SELECT count(*) as cnt FROM message_queue WHERE to_scope = $toScope AND expires_at > $now',
  )

  const stmtLogInsert = db.prepare(`
    INSERT INTO message_log (from_scope, to_scope, from_conversation_id, to_conversation_id, from_name, to_name, content, intent, conversation_id, full_length, created_at)
    VALUES ($fromScope, $toScope, $fromConversationId, $toConversationId, $fromName, $toName, $content, $intent, $conversationId, $fullLength, $createdAt)
  `)

  const stmtPruneExpired = db.prepare('DELETE FROM message_queue WHERE expires_at <= $now')
  const stmtPurgeLog = db.prepare(`
    DELETE FROM message_log WHERE
      (from_scope = $scopeA AND to_scope = $scopeB) OR
      (from_scope = $scopeB AND to_scope = $scopeA)
  `)

  function mapQueueRow(row: Params): QueuedMessage {
    return {
      id: row.id as number,
      fromScope: row.from_scope as string,
      toScope: row.to_scope as string,
      fromConversationId: (row.from_conversation_id as string) ?? undefined,
      fromName: (row.from_name as string) ?? undefined,
      targetName: (row.target_name as string) ?? undefined,
      content: row.content as string,
      intent: (row.intent as string) ?? undefined,
      conversationId: (row.conversation_id as string) ?? undefined,
      createdAt: row.created_at as number,
    }
  }

  function mapLogRow(row: Params): MessageLogEntry {
    return {
      id: row.id as number,
      fromScope: row.from_scope as string,
      toScope: row.to_scope as string,
      fromConversationId: (row.from_conversation_id as string) ?? undefined,
      toConversationId: (row.to_conversation_id as string) ?? undefined,
      fromName: (row.from_name as string) ?? undefined,
      toName: (row.to_name as string) ?? undefined,
      content: (row.content as string) ?? undefined,
      intent: (row.intent as string) ?? undefined,
      conversationId: (row.conversation_id as string) ?? undefined,
      fullLength: (row.full_length as number) ?? undefined,
      createdAt: row.created_at as number,
    }
  }

  return {
    enqueue(msg: EnqueueMessage) {
      stmtEnqueue.run({
        fromScope: msg.fromScope,
        toScope: msg.toScope,
        fromConversationId: msg.fromConversationId ?? null,
        fromName: msg.fromName ?? null,
        targetName: msg.targetName ?? null,
        content: msg.content,
        intent: msg.intent ?? null,
        conversationId: msg.conversationId ?? null,
        createdAt: Date.now(),
        expiresAt: msg.expiresAt,
      })
    },

    dequeueFor(scope, targetName?) {
      const now = Date.now()
      const doDequeue = db.transaction(() => {
        let rows: Params[]
        if (targetName) {
          rows = stmtDequeueFiltered.all({ toScope: scope, now, targetName }) as Params[]
          stmtDeleteDequeuedFiltered.run({ toScope: scope, now, targetName })
        } else {
          rows = stmtDequeue.all({ toScope: scope, now }) as Params[]
          stmtDeleteDequeued.run({ toScope: scope, now })
        }
        return rows.map(mapQueueRow)
      })
      return doDequeue()
    },

    countFor(scope) {
      const row = stmtCountFor.get({ toScope: scope, now: Date.now() }) as { cnt: number }
      return row.cnt
    },

    log(entry: MessageLogEntry) {
      stmtLogInsert.run({
        fromScope: entry.fromScope,
        toScope: entry.toScope,
        fromConversationId: entry.fromConversationId ?? null,
        toConversationId: entry.toConversationId ?? null,
        fromName: entry.fromName ?? null,
        toName: entry.toName ?? null,
        content: entry.content ?? null,
        intent: entry.intent ?? null,
        conversationId: entry.conversationId ?? null,
        fullLength: entry.fullLength ?? null,
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
      if (opts?.before != null) {
        sql += ' AND created_at < $before'
        params.before = opts.before
      }

      sql += ' ORDER BY created_at DESC'

      if (opts?.limit) {
        sql += ' LIMIT $limit'
        params.limit = opts.limit
      }

      const rows = db.prepare(sql).all(params) as Params[]
      return rows.map(mapLogRow)
    },

    purgeLog(scopeA, scopeB) {
      const result = stmtPurgeLog.run({ scopeA, scopeB })
      return result.changes
    },

    compactLog(retentionMs, maxEntries) {
      const cutoff = Date.now() - retentionMs
      let result = db.prepare('DELETE FROM message_log WHERE created_at < $cutoff').run({ cutoff })
      let removed = result.changes

      const count = (db.prepare('SELECT count(*) as cnt FROM message_log').get() as { cnt: number }).cnt
      if (count > maxEntries) {
        const excess = count - maxEntries
        result = db
          .prepare(
            'DELETE FROM message_log WHERE id IN (SELECT id FROM message_log ORDER BY created_at ASC LIMIT $excess)',
          )
          .run({ excess })
        removed += result.changes
      }

      return removed
    },

    pruneExpired() {
      const result = stmtPruneExpired.run({ now: Date.now() })
      return result.changes
    },
  }
}
