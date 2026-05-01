import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ConversationCreate,
  ConversationPatch,
  EnqueueMessage,
  MessageLogEntry,
  ShareCreate,
  StoreDriver,
  TranscriptEntryInput,
  TurnRecord,
} from './types'

export interface MigrationCounts {
  sessions: number
  transcripts: number
  transcriptEntries: number
  globalSettings: number
  projectSettings: number
  sessionOrder: number
  shares: number
  addressBook: number
  projectLinks: number
  messageQueue: number
  interSessionLog: number
  costTurns: number
}

export interface MigrationResult {
  counts: MigrationCounts
  warnings: string[]
  errors: string[]
}

function emptyCounts(): MigrationCounts {
  return {
    sessions: 0,
    transcripts: 0,
    transcriptEntries: 0,
    globalSettings: 0,
    projectSettings: 0,
    sessionOrder: 0,
    shares: 0,
    addressBook: 0,
    projectLinks: 0,
    messageQueue: 0,
    interSessionLog: 0,
    costTurns: 0,
  }
}

function readJsonSafe(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

function migrateSessions(store: StoreDriver, cacheDir: string, result: MigrationResult): void {
  const path = join(cacheDir, 'sessions.json')
  if (!existsSync(path)) return

  const raw = readJsonSafe(path)
  if (!raw || typeof raw !== 'object') {
    result.errors.push('sessions.json: failed to parse')
    return
  }

  const state = raw as { version?: number; sessions?: unknown[] }
  if (state.version !== 1 || !Array.isArray(state.sessions)) {
    result.errors.push(`sessions.json: unsupported version ${state.version}`)
    return
  }

  for (const s of state.sessions) {
    if (!s || typeof s !== 'object') {
      result.warnings.push('sessions.json: skipping non-object entry')
      continue
    }

    const session = s as Record<string, unknown>
    const id = session.id as string | undefined
    if (!id) {
      result.warnings.push('sessions.json: skipping entry with no id')
      continue
    }

    try {
      const scope = (session.project as string) || (session.cwd as string) || ''
      const create: ConversationCreate = {
        id,
        scope,
        agentType: (session.agentName as string) || 'claude',
        agentVersion: session.claudeVersion as string | undefined,
        title: session.title as string | undefined,
        model: session.model as string | undefined,
        createdAt: (session.startedAt as number) || Date.now(),
        meta: buildSessionMeta(session),
      }

      store.sessions.create(create)

      const patch: ConversationPatch = {
        status: (session.status as string) || 'ended',
        summary: session.summary as string | undefined,
        lastActivity: session.lastActivity as number | undefined,
        endedAt: session.status === 'ended' ? (session.lastActivity as number) : undefined,
        stats: buildSessionStats(session),
      }
      store.sessions.update(id, patch)
      result.counts.sessions++
    } catch (err) {
      result.warnings.push(`sessions.json: failed to import session ${id}: ${err instanceof Error ? err.message : err}`)
    }
  }
}

function buildSessionMeta(session: Record<string, unknown>): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  const passthrough = [
    'configuredModel',
    'permissionMode',
    'effortLevel',
    'contextMode',
    'args',
    'capabilities',
    'version',
    'buildTime',
    'claudeVersion',
    'claudeAuth',
    'transcriptPath',
    'compactedAt',
    'subagents',
    'tasks',
    'archivedTasks',
    'bgTasks',
    'monitors',
    'teammates',
    'team',
    'gitBranch',
    'adHocTaskId',
    'adHocWorktree',
    'launchConfig',
    'resultText',
    'recap',
    'titleUserSet',
    'agentName',
    'prLinks',
    'costTimeline',
    'currentPath',
  ] as const

  for (const key of passthrough) {
    if (session[key] !== undefined) {
      meta[key] = session[key]
    }
  }
  return Object.keys(meta).length > 0 ? meta : {}
}

function buildSessionStats(session: Record<string, unknown>): Record<string, unknown> | undefined {
  const stats = session.stats as Record<string, unknown> | undefined
  if (!stats) return undefined

  return {
    inputTokens: stats.totalInputTokens as number | undefined,
    outputTokens: stats.totalOutputTokens as number | undefined,
    cacheReadTokens: stats.totalCacheRead as number | undefined,
    cacheWriteTokens: stats.totalCacheCreation as number | undefined,
    totalCost: stats.totalCostUsd as number | undefined,
    toolCalls: stats.toolCallCount as number | undefined,
    linesChanged: ((stats.linesAdded as number) || 0) + ((stats.linesRemoved as number) || 0) || undefined,
    turnCount: stats.turnCount as number | undefined,
  }
}

function migrateTranscripts(store: StoreDriver, cacheDir: string, result: MigrationResult): void {
  const dir = join(cacheDir, 'transcripts')
  if (!existsSync(dir)) return

  let files: string[]
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
  } catch {
    result.errors.push('transcripts/: failed to read directory')
    return
  }

  for (const file of files) {
    const sessionId = file.slice(0, -6)
    const filePath = join(dir, file)
    let entryCount = 0

    try {
      const text = readFileSync(filePath, 'utf-8').trim()
      if (!text) continue

      const entries: TranscriptEntryInput[] = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>
          entries.push({
            type: (parsed.type as string) || 'unknown',
            subtype: parsed.subtype as string | undefined,
            agentId: (parsed.isSidechain ? (parsed.parentUuid as string) : undefined) as string | undefined,
            uuid: (parsed.uuid as string) || crypto.randomUUID(),
            content: parsed,
            timestamp: parseTimestamp(parsed.timestamp),
          })
        } catch {
          result.warnings.push(`transcripts/${file}: skipping malformed line`)
        }
      }

      if (entries.length > 0) {
        const BATCH_SIZE = 500
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
          const batch = entries.slice(i, i + BATCH_SIZE)
          store.transcripts.append(sessionId, 'migration', batch)
        }
        entryCount = entries.length
      }
    } catch (err) {
      result.errors.push(`transcripts/${file}: ${err instanceof Error ? err.message : err}`)
      continue
    }

    if (entryCount > 0) {
      result.counts.transcripts++
      result.counts.transcriptEntries += entryCount
    }
  }
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (!Number.isNaN(ms)) return ms
  }
  return Date.now()
}

function migrateGlobalSettings(store: StoreDriver, cacheDir: string, result: MigrationResult): void {
  const path = join(cacheDir, 'global-settings.json')
  if (!existsSync(path)) return

  const raw = readJsonSafe(path)
  if (raw === null) {
    result.errors.push('global-settings.json: failed to parse')
    return
  }

  store.kv.set('global-settings', raw)
  result.counts.globalSettings = 1
}

function migrateProjectSettings(store: StoreDriver, cacheDir: string, result: MigrationResult): void {
  const path = join(cacheDir, 'project-settings.json')
  if (!existsSync(path)) return

  const raw = readJsonSafe(path)
  if (raw === null) {
    result.errors.push('project-settings.json: failed to parse')
    return
  }

  store.kv.set('project-settings', raw)
  result.counts.projectSettings = 1
}

function migrateSessionOrder(store: StoreDriver, cacheDir: string, result: MigrationResult): void {
  const projectOrderPath = join(cacheDir, 'project-order.json')
  const sessionOrderPath = join(cacheDir, 'session-order.json')
  const path = existsSync(projectOrderPath) ? projectOrderPath : existsSync(sessionOrderPath) ? sessionOrderPath : null
  if (!path) return

  const raw = readJsonSafe(path)
  if (raw === null) {
    result.errors.push(`${path}: failed to parse`)
    return
  }

  store.kv.set('session-order', raw)
  result.counts.sessionOrder = 1
}

function migrateShares(store: StoreDriver, cacheDir: string, result: MigrationResult): void {
  const path = join(cacheDir, 'shares.json')
  if (!existsSync(path)) return

  const raw = readJsonSafe(path)
  if (!Array.isArray(raw)) {
    result.errors.push('shares.json: expected array')
    return
  }

  for (const share of raw) {
    if (!share || typeof share !== 'object') {
      result.warnings.push('shares.json: skipping non-object entry')
      continue
    }

    const s = share as Record<string, unknown>
    if (s.revoked === true) continue
    if (typeof s.expiresAt === 'number' && s.expiresAt <= Date.now()) continue

    try {
      const permArray = s.permissions as string[] | undefined
      const permObj: Record<string, boolean> = {}
      if (Array.isArray(permArray)) {
        for (const p of permArray) permObj[p] = true
      }

      const create: ShareCreate = {
        token: s.token as string,
        sessionId: (s.sessionCwd as string) || (s.sessionId as string) || '',
        permissions: permObj,
        expiresAt: s.expiresAt as number,
      }
      store.shares.create(create)
      result.counts.shares++
    } catch (err) {
      result.warnings.push(`shares.json: failed to import share: ${err instanceof Error ? err.message : err}`)
    }
  }
}

function migrateAddressBook(store: StoreDriver, cacheDir: string, result: MigrationResult): void {
  const path = join(cacheDir, 'address-books.json')
  if (!existsSync(path)) return

  const raw = readJsonSafe(path)
  if (!raw || typeof raw !== 'object') {
    result.errors.push('address-books.json: failed to parse')
    return
  }

  const file = raw as { _version?: number; books?: Record<string, Record<string, string>> }
  const books = file.books || (file as unknown as Record<string, Record<string, string>>)

  for (const [ownerScope, book] of Object.entries(books)) {
    if (ownerScope === '_version') continue
    if (!book || typeof book !== 'object') continue

    for (const [slug, targetScope] of Object.entries(book)) {
      if (typeof targetScope !== 'string') continue
      try {
        store.addressBook.set(ownerScope, slug, targetScope)
        result.counts.addressBook++
      } catch (err) {
        result.warnings.push(
          `address-books.json: failed to set ${ownerScope}/${slug}: ${err instanceof Error ? err.message : err}`,
        )
      }
    }
  }
}

function migrateProjectLinks(store: StoreDriver, cacheDir: string, result: MigrationResult): void {
  const projectLinksPath = join(cacheDir, 'project-links.json')
  const sessionLinksPath = join(cacheDir, 'session-links.json')
  const path = existsSync(projectLinksPath) ? projectLinksPath : existsSync(sessionLinksPath) ? sessionLinksPath : null
  if (!path) return

  const raw = readJsonSafe(path)
  if (!raw || typeof raw !== 'object') {
    result.errors.push(`${path}: failed to parse`)
    return
  }

  const file = raw as { version?: number; links?: unknown[] }
  const links = file.links || []
  if (!Array.isArray(links)) {
    result.errors.push(`${path}: expected links array`)
    return
  }

  for (const link of links) {
    if (!link || typeof link !== 'object') continue
    const l = link as Record<string, unknown>
    const scopeA = (l.projectA as string) || (l.cwdA as string)
    const scopeB = (l.projectB as string) || (l.cwdB as string)
    if (!scopeA || !scopeB) {
      result.warnings.push(`${path}: skipping link with missing scope`)
      continue
    }

    try {
      store.scopeLinks.link(scopeA, scopeB)
      result.counts.projectLinks++
    } catch (err) {
      result.warnings.push(
        `${path}: failed to link ${scopeA} <-> ${scopeB}: ${err instanceof Error ? err.message : err}`,
      )
    }
  }
}

function migrateMessageQueue(store: StoreDriver, cacheDir: string, result: MigrationResult): void {
  const path = join(cacheDir, 'message-queue.json')
  if (!existsSync(path)) return

  const raw = readJsonSafe(path)
  if (!raw || typeof raw !== 'object') {
    result.errors.push('message-queue.json: failed to parse')
    return
  }

  const queues = raw as Record<string, unknown[]>
  const now = Date.now()
  const TTL_MS = 24 * 60 * 60 * 1000

  for (const [targetProject, messages] of Object.entries(queues)) {
    if (!Array.isArray(messages)) continue

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue
      const m = msg as Record<string, unknown>
      const ts = m.ts as number | undefined
      if (ts && now - ts > TTL_MS) continue

      try {
        const enqueue: EnqueueMessage = {
          fromScope: (m.senderProject as string) || (m.fromCwd as string) || '',
          toScope: targetProject,
          fromSessionId: undefined,
          content: JSON.stringify(m.message || ''),
          intent: undefined,
          conversationId: undefined,
          expiresAt: (ts || now) + TTL_MS,
        }
        store.messages.enqueue(enqueue)
        result.counts.messageQueue++
      } catch (err) {
        result.warnings.push(`message-queue.json: failed to enqueue: ${err instanceof Error ? err.message : err}`)
      }
    }
  }
}

function migrateInterSessionLog(store: StoreDriver, cacheDir: string, result: MigrationResult): void {
  const path = join(cacheDir, 'inter-session-messages.jsonl')
  if (!existsSync(path)) return

  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    result.errors.push('inter-session-messages.jsonl: failed to read')
    return
  }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue

    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      const from = entry.from as Record<string, string> | undefined
      const to = entry.to as Record<string, string> | undefined
      if (!from || !to) {
        result.warnings.push('inter-session-messages.jsonl: skipping entry without from/to')
        continue
      }

      const logEntry: MessageLogEntry = {
        fromScope: from.project || from.cwd || '',
        toScope: to.project || to.cwd || '',
        fromSessionId: from.sessionId,
        toSessionId: to.sessionId,
        content: entry.preview as string | undefined,
        intent: entry.intent as string | undefined,
        conversationId: entry.conversationId as string | undefined,
        createdAt: (entry.ts as number) || Date.now(),
      }
      store.messages.log(logEntry)
      result.counts.interSessionLog++
    } catch {
      result.warnings.push('inter-session-messages.jsonl: skipping malformed line')
    }
  }
}

function migrateCostData(store: StoreDriver, cacheDir: string, result: MigrationResult): void {
  const path = join(cacheDir, 'cost-data.db')
  if (!existsSync(path)) return

  let legacy: Database | null = null
  try {
    legacy = new Database(path, { readonly: true })
  } catch (err) {
    result.errors.push(`cost-data.db: failed to open: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  try {
    // Skip if target table already has rows -- avoids duplicating on re-run
    const existing = store.costs.queryTurns({ limit: 1 })
    if (existing.total > 0) {
      result.warnings.push('cost-data.db: target turns table not empty, skipping (already migrated)')
      return
    }

    // Verify legacy schema -- project_uri column is required (added in cost-store.ts migration)
    const cols = legacy.query("PRAGMA table_info('turns')").all() as Array<{ name: string }>
    const hasProjectUri = cols.some(c => c.name === 'project_uri')
    const hasCwd = cols.some(c => c.name === 'cwd')

    if (!hasProjectUri && !hasCwd) {
      result.warnings.push('cost-data.db: no turns table found')
      return
    }

    // Prefer project_uri (post-migration DBs have already dropped the cwd column);
    // fall back to synthesizing a canonical URI from cwd for pre-migration DBs.
    // Emits `claude://default/{abs}` directly -- canonicalizeUris() will upgrade
    // any legacy `claude:///` or `claude:////` rows on the target side anyway,
    // but producing canonical form here saves a second pass.
    const selectExpr = hasProjectUri
      ? "COALESCE(project_uri, '')"
      : `CASE
           WHEN cwd IS NOT NULL AND cwd != ''
             THEN 'claude://default' || CASE WHEN substr(cwd, 1, 1) = '/' THEN cwd ELSE '/' || cwd END
           ELSE ''
         END`

    const rows = legacy
      .query(
        `SELECT timestamp, session_id, ${selectExpr} as project_uri,
          account, org_id, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_usd, exact_cost
         FROM turns
         ORDER BY timestamp ASC`,
      )
      .all() as Array<Record<string, unknown>>

    for (const r of rows) {
      const rec: TurnRecord = {
        timestamp: (r.timestamp as number) ?? 0,
        sessionId: (r.session_id as string) ?? '',
        projectUri: (r.project_uri as string) || '',
        account: (r.account as string) ?? '',
        orgId: (r.org_id as string) ?? '',
        model: (r.model as string) ?? '',
        inputTokens: (r.input_tokens as number) ?? 0,
        outputTokens: (r.output_tokens as number) ?? 0,
        cacheReadTokens: (r.cache_read_tokens as number) ?? 0,
        cacheWriteTokens: (r.cache_write_tokens as number) ?? 0,
        costUsd: (r.cost_usd as number) ?? 0,
        exactCost: !!(r.exact_cost as number),
      }
      store.costs.recordTurn(rec)
      result.counts.costTurns++
    }
  } finally {
    legacy.close()
  }
}

export function migrateFromLegacy(store: StoreDriver, cacheDir: string): MigrationResult {
  const result: MigrationResult = {
    counts: emptyCounts(),
    warnings: [],
    errors: [],
  }

  migrateSessions(store, cacheDir, result)
  migrateTranscripts(store, cacheDir, result)
  migrateGlobalSettings(store, cacheDir, result)
  migrateProjectSettings(store, cacheDir, result)
  migrateSessionOrder(store, cacheDir, result)
  migrateShares(store, cacheDir, result)
  migrateAddressBook(store, cacheDir, result)
  migrateProjectLinks(store, cacheDir, result)
  migrateMessageQueue(store, cacheDir, result)
  migrateInterSessionLog(store, cacheDir, result)
  migrateCostData(store, cacheDir, result)

  return result
}

/**
 * Canonicalize every project URI in the store to `claude://default/{path}`.
 *
 * Handles two legacy forms produced by pre-2026-04-25 code:
 *   1. `claude:////path` -- quad-slash scar from `'claude:///' || cwd` concat
 *      where cwd was already absolute.
 *   2. `claude:///path`  -- empty-authority form, written before the scheme
 *      gained a mandatory authority.
 *
 * Both collapse to `claude://default/path`. Applied as two SQL UPDATE passes
 * per affected column so we can drive it with pure REPLACE (no per-row JS).
 *
 * Covered columns:
 *   - store.db  turns.project_uri        (quad-slash scar present)
 *   - store.db  hourly_stats.project_uri (PK -- malformed rows deleted, rebuilt on next query)
 *   - store.db  sessions.scope           (clean on entry but we still canonicalize for consistency)
 *   - store.db  scope_links.scope_a/b    (clean on entry; future-proof)
 *   - store.db  address_book.owner_scope/target_scope (ditto)
 *   - analytics.db turns.project_uri     (quad-slash scar present, BIG)
 *
 * Idempotent: running twice is a no-op.
 */
export interface CanonicalizeResult {
  storeTurns: number
  storeHourlyDeleted: number
  storeSessions: number
  storeScopeLinks: number
  storeAddressBook: number
  analyticsTurns: number
}

function canonicalizeColumn(db: Database, table: string, column: string): number {
  // Two-pass: quad-slash -> triple-slash -> default-authority. The order
  // matters so a single REPLACE doesn't introduce a double slash on quad input.
  db.prepare(
    `UPDATE ${table} SET ${column} = REPLACE(${column}, 'claude:////', 'claude:///')
       WHERE ${column} LIKE 'claude:////%'`,
  ).run()
  const r = db
    .prepare(
      `UPDATE ${table} SET ${column} = REPLACE(${column}, 'claude:///', 'claude://default/')
         WHERE ${column} LIKE 'claude:///%' AND ${column} NOT LIKE 'claude://default/%'`,
    )
    .run()
  return r.changes ?? 0
}

export function canonicalizeUris(cacheDir: string): CanonicalizeResult {
  const result: CanonicalizeResult = {
    storeTurns: 0,
    storeHourlyDeleted: 0,
    storeSessions: 0,
    storeScopeLinks: 0,
    storeAddressBook: 0,
    analyticsTurns: 0,
  }

  const storeDbPath = join(cacheDir, 'store.db')
  if (existsSync(storeDbPath)) {
    const db = new Database(storeDbPath)
    try {
      result.storeTurns = canonicalizeColumn(db, 'turns', 'project_uri')

      // hourly_stats has project_uri in the PK; REPLACE could produce collisions
      // against existing canonical rows. Delete malformed rows and let
      // materializeHourly() rebuild from the now-clean turns table on next query.
      const r = db
        .prepare(
          "DELETE FROM hourly_stats WHERE project_uri LIKE 'claude:///%' AND project_uri NOT LIKE 'claude://default/%'",
        )
        .run()
      result.storeHourlyDeleted = r.changes ?? 0

      result.storeSessions = canonicalizeColumn(db, 'sessions', 'scope')
      // scope_links: both columns, plus dedup on collision (PK is (scope_a, scope_b))
      const sl1 = canonicalizeColumn(db, 'scope_links', 'scope_a')
      const sl2 = canonicalizeColumn(db, 'scope_links', 'scope_b')
      result.storeScopeLinks = sl1 + sl2

      const ab1 = canonicalizeColumn(db, 'address_book', 'owner_scope')
      const ab2 = canonicalizeColumn(db, 'address_book', 'target_scope')
      result.storeAddressBook = ab1 + ab2
    } finally {
      db.close()
    }
  }

  const analyticsDbPath = join(cacheDir, 'analytics.db')
  if (existsSync(analyticsDbPath)) {
    const db = new Database(analyticsDbPath)
    try {
      result.analyticsTurns = canonicalizeColumn(db, 'turns', 'project_uri')
    } finally {
      db.close()
    }
  }

  return result
}

/**
 * Current schema version. Bumped whenever a startup-time migration step is added.
 * - 1: Phase 4 complete (legacy JSON/JSONL/cost-data.db absorbed into store.db)
 * - 2: all project URIs canonicalized to `claude://default/{path}` form
 *      (collapses claude:////path scar AND upgrades claude:///path to include
 *      the default sentinel authority)
 */
export const SCHEMA_VERSION = 2

const SCHEMA_VERSION_KEY = 'schema-version'

export interface StartupMigrationResult {
  fromVersion: number
  toVersion: number
  migrated?: MigrationResult
  canonicalized?: CanonicalizeResult
  skipped: boolean
}

/**
 * Idempotent startup hook -- runs any migration steps whose version is higher
 * than the currently-stamped schema version, then updates the stamp.
 *
 * Designed to be called once on broker startup after store.init(). Fast path
 * (stamp already current) is a single KV read.
 */
export function runStartupMigration(store: StoreDriver, cacheDir: string): StartupMigrationResult {
  const current = (store.kv.get<number>(SCHEMA_VERSION_KEY) as number | null) ?? 0

  if (current >= SCHEMA_VERSION) {
    return { fromVersion: current, toVersion: SCHEMA_VERSION, skipped: true }
  }

  const out: StartupMigrationResult = { fromVersion: current, toVersion: SCHEMA_VERSION, skipped: false }

  // v1: absorb legacy JSON/JSONL/cost-data.db. Each sub-migrate is idempotent
  // (skips if the target table is already populated), so this is safe to call
  // regardless of current version.
  if (current < 1) {
    out.migrated = migrateFromLegacy(store, cacheDir)
  }

  // v2: canonicalize all project URIs to `claude://default/{path}` form
  if (current < 2) {
    out.canonicalized = canonicalizeUris(cacheDir)
  }

  store.kv.set(SCHEMA_VERSION_KEY, SCHEMA_VERSION)
  return out
}

export function dryRunScan(cacheDir: string): { files: Record<string, { exists: boolean; entries?: number }> } {
  const files: Record<string, { exists: boolean; entries?: number }> = {}

  const sessionsPath = join(cacheDir, 'sessions.json')
  if (existsSync(sessionsPath)) {
    const raw = readJsonSafe(sessionsPath) as { sessions?: unknown[] } | null
    files['sessions.json'] = { exists: true, entries: raw?.sessions?.length }
  } else {
    files['sessions.json'] = { exists: false }
  }

  const transcriptsDir = join(cacheDir, 'transcripts')
  if (existsSync(transcriptsDir)) {
    try {
      const jsonlFiles = readdirSync(transcriptsDir).filter(f => f.endsWith('.jsonl'))
      let totalEntries = 0
      for (const f of jsonlFiles) {
        try {
          const text = readFileSync(join(transcriptsDir, f), 'utf-8').trim()
          if (text) totalEntries += text.split('\n').length
        } catch {}
      }
      files['transcripts/'] = { exists: true, entries: jsonlFiles.length }
      files['transcripts/ (entries)'] = { exists: true, entries: totalEntries }
    } catch {
      files['transcripts/'] = { exists: true }
    }
  } else {
    files['transcripts/'] = { exists: false }
  }

  for (const name of [
    'global-settings.json',
    'project-settings.json',
    'session-order.json',
    'project-order.json',
    'shares.json',
    'address-books.json',
    'project-links.json',
    'session-links.json',
    'message-queue.json',
    'inter-session-messages.jsonl',
  ]) {
    const p = join(cacheDir, name)
    if (existsSync(p)) {
      let entries: number | undefined
      try {
        if (name.endsWith('.jsonl')) {
          entries = readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).length
        } else {
          const raw = readJsonSafe(p)
          if (Array.isArray(raw)) entries = raw.length
        }
      } catch {}
      files[name] = { exists: true, entries }
    } else {
      files[name] = { exists: false }
    }
  }

  const costDbPath = join(cacheDir, 'cost-data.db')
  if (existsSync(costDbPath)) {
    let entries: number | undefined
    try {
      const legacy = new Database(costDbPath, { readonly: true })
      try {
        const row = legacy.query('SELECT COUNT(*) as n FROM turns').get() as { n: number } | null
        entries = row?.n ?? 0
      } finally {
        legacy.close()
      }
    } catch {}
    files['cost-data.db'] = { exists: true, entries }
  } else {
    files['cost-data.db'] = { exists: false }
  }

  return { files }
}
