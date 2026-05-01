import type { Database } from 'bun:sqlite'
import { DuplicateEntry, SessionNotFound } from '../errors'
import type {
  ConversationCreate,
  ConversationFilter,
  ConversationPatch,
  ConversationRecord,
  ConversationStats,
  ConversationSummaryRecord,
  SessionStore,
} from '../types'

type Params = Record<string, string | number | bigint | boolean | null>

function rowToRecord(row: Params): ConversationRecord {
  return {
    id: row.id as string,
    scope: row.scope as string,
    agentType: row.agent_type as string,
    agentVersion: (row.agent_version as string) ?? undefined,
    title: (row.title as string) ?? undefined,
    summary: (row.summary as string) ?? undefined,
    label: (row.label as string) ?? undefined,
    icon: (row.icon as string) ?? undefined,
    color: (row.color as string) ?? undefined,
    status: row.status as string,
    model: (row.model as string) ?? undefined,
    createdAt: row.created_at as number,
    endedAt: (row.ended_at as number) ?? undefined,
    lastActivity: (row.last_activity as number) ?? undefined,
    meta: row.meta ? JSON.parse(row.meta as string) : undefined,
    stats: row.stats ? JSON.parse(row.stats as string) : undefined,
  }
}

function rowToSummary(row: Params): ConversationSummaryRecord {
  return {
    id: row.id as string,
    scope: row.scope as string,
    agentType: row.agent_type as string,
    status: row.status as string,
    model: (row.model as string) ?? undefined,
    title: (row.title as string) ?? undefined,
    label: (row.label as string) ?? undefined,
    icon: (row.icon as string) ?? undefined,
    color: (row.color as string) ?? undefined,
    createdAt: row.created_at as number,
    endedAt: (row.ended_at as number) ?? undefined,
    lastActivity: (row.last_activity as number) ?? undefined,
  }
}

export function createSqliteSessionStore(db: Database): SessionStore {
  const stmtGet = db.prepare('SELECT * FROM sessions WHERE id = $id')
  const stmtInsert = db.prepare(`
    INSERT INTO sessions (id, scope, agent_type, agent_version, title, model, status, created_at, meta)
    VALUES ($id, $scope, $agentType, $agentVersion, $title, $model, $status, $createdAt, $meta)
  `)
  const stmtDelete = db.prepare('DELETE FROM sessions WHERE id = $id')

  return {
    get(id) {
      const row = stmtGet.get({ id }) as Params | null
      return row ? rowToRecord(row) : null
    },

    create(input: ConversationCreate) {
      const existing = stmtGet.get({ id: input.id })
      if (existing) throw new DuplicateEntry(`Session already exists: ${input.id}`)

      const createdAt = input.createdAt ?? Date.now()
      stmtInsert.run({
        id: input.id,
        scope: input.scope,
        agentType: input.agentType,
        agentVersion: input.agentVersion ?? null,
        title: input.title ?? null,
        model: input.model ?? null,
        status: 'active',
        createdAt,
        meta: input.meta ? JSON.stringify(input.meta) : null,
      })
      return {
        id: input.id,
        scope: input.scope,
        agentType: input.agentType,
        agentVersion: input.agentVersion,
        title: input.title,
        status: 'active',
        model: input.model,
        createdAt,
        meta: input.meta,
      }
    },

    update(id, patch: ConversationPatch) {
      const existing = stmtGet.get({ id })
      if (!existing) throw new SessionNotFound(id)

      const sets: string[] = []
      const params: Params = { id }

      if (patch.status !== undefined) {
        sets.push('status = $status')
        params.status = patch.status
      }
      if (patch.model !== undefined) {
        sets.push('model = $model')
        params.model = patch.model
      }
      if (patch.title !== undefined) {
        sets.push('title = $title')
        params.title = patch.title
      }
      if (patch.summary !== undefined) {
        sets.push('summary = $summary')
        params.summary = patch.summary
      }
      if (patch.label !== undefined) {
        sets.push('label = $label')
        params.label = patch.label
      }
      if (patch.icon !== undefined) {
        sets.push('icon = $icon')
        params.icon = patch.icon
      }
      if (patch.color !== undefined) {
        sets.push('color = $color')
        params.color = patch.color
      }
      if (patch.endedAt !== undefined) {
        sets.push('ended_at = $endedAt')
        params.endedAt = patch.endedAt
      }
      if (patch.lastActivity !== undefined) {
        sets.push('last_activity = $lastActivity')
        params.lastActivity = patch.lastActivity
      }
      if (patch.meta !== undefined) {
        sets.push('meta = $meta')
        params.meta = JSON.stringify(patch.meta)
      }
      if (patch.stats !== undefined) {
        sets.push('stats = $stats')
        params.stats = JSON.stringify(patch.stats)
      }

      if (sets.length > 0) {
        db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = $id`).run(params)
      }
    },

    delete(id) {
      stmtDelete.run({ id })
    },

    list(filter?: ConversationFilter) {
      const conditions: string[] = []
      const params: Params = {}

      if (filter?.scope) {
        conditions.push('scope = $scope')
        params.scope = filter.scope
      }
      if (filter?.agentType) {
        conditions.push('agent_type = $agentType')
        params.agentType = filter.agentType
      }
      if (filter?.status?.length) {
        const placeholders = filter.status.map((_, i) => `$status${i}`)
        conditions.push(`status IN (${placeholders.join(', ')})`)
        for (let i = 0; i < filter.status.length; i++) {
          params[`status${i}`] = filter.status[i]
        }
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const limit = filter?.limit ?? -1
      const offset = filter?.offset ?? 0
      const sql = `SELECT * FROM sessions ${where} ORDER BY created_at DESC LIMIT $limit OFFSET $offset`
      const rows = db.prepare(sql).all({ ...params, limit, offset }) as Params[]
      return rows.map(rowToSummary)
    },

    listByScope(scope, filter) {
      const conditions: string[] = ['scope = $scope']
      const params: Params = { scope }

      if (filter?.status?.length) {
        const placeholders = filter.status.map((_, i) => `$status${i}`)
        conditions.push(`status IN (${placeholders.join(', ')})`)
        for (let i = 0; i < filter.status.length; i++) {
          params[`status${i}`] = filter.status[i]
        }
      }

      const where = `WHERE ${conditions.join(' AND ')}`
      const sql = `SELECT * FROM sessions ${where} ORDER BY created_at DESC`
      const rows = db.prepare(sql).all(params) as Params[]
      return rows.map(rowToSummary)
    },

    updateStats(id, stats: Partial<ConversationStats>) {
      const row = stmtGet.get({ id }) as Params | null
      if (!row) throw new SessionNotFound(id)

      const existing: ConversationStats = row.stats ? JSON.parse(row.stats as string) : {}
      const merged = { ...existing, ...stats }
      db.prepare('UPDATE sessions SET stats = $stats WHERE id = $id').run({
        id,
        stats: JSON.stringify(merged),
      })
    },
  }
}
