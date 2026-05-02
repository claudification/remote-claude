/**
 * StoreDriver -- pluggable storage backend for the broker.
 *
 * SQLite is the primary driver. MemoryDriver exists for tests.
 * No SQL, no file paths, no storage-specific code outside the driver.
 */

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface ConversationRecord {
  id: string
  scope: string
  agentType: string
  agentVersion?: string

  title?: string
  summary?: string
  label?: string
  icon?: string
  color?: string

  status: string
  model?: string

  createdAt: number
  endedAt?: number
  lastActivity?: number

  meta?: Record<string, unknown>
  stats?: ConversationStats
}

export interface ConversationStats {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalCost?: number
  toolCalls?: number
  linesChanged?: number
  turnCount?: number
}

export interface ConversationCreate {
  id: string
  scope: string
  agentType: string
  agentVersion?: string
  title?: string
  model?: string
  meta?: Record<string, unknown>
  createdAt?: number
}

export interface ConversationPatch {
  status?: string
  model?: string
  title?: string
  summary?: string
  label?: string
  icon?: string
  color?: string
  endedAt?: number
  lastActivity?: number
  meta?: Record<string, unknown>
  stats?: ConversationStats
}

export interface ConversationFilter {
  scope?: string
  status?: string[]
  agentType?: string
  limit?: number
  offset?: number
}

export interface ConversationSummaryRecord {
  id: string
  scope: string
  agentType: string
  status: string
  model?: string
  title?: string
  label?: string
  icon?: string
  color?: string
  createdAt: number
  endedAt?: number
  lastActivity?: number
}

export interface ConversationStore {
  get(id: string): ConversationRecord | null
  create(session: ConversationCreate): ConversationRecord
  update(id: string, patch: ConversationPatch): void
  delete(id: string): void
  list(filter?: ConversationFilter): ConversationSummaryRecord[]
  listByScope(scope: string, filter?: { status?: string[] }): ConversationSummaryRecord[]
  updateStats(id: string, stats: Partial<ConversationStats>): void
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface TranscriptEntryRecord {
  id: number
  sessionId: string
  sessionSeq: number
  syncEpoch: string
  type: string
  subtype?: string
  agentId?: string
  uuid: string
  content: Record<string, unknown>
  timestamp: number
  ingestedAt: number
}

export interface PageOpts {
  cursor?: number
  limit?: number
  direction?: 'forward' | 'backward'
}

export interface TranscriptPage {
  entries: TranscriptEntryRecord[]
  nextCursor: number | null
  prevCursor: number | null
  totalCount: number
}

export interface TranscriptFilter {
  types?: string[]
  subtypes?: string[]
  agentId?: string | null
  after?: number
  before?: number
  limit?: number
}

export interface SearchHit {
  sessionId: string
  entryId: number
  snippet: string
  score: number
  createdAt: number
}

export interface TranscriptStore {
  append(sessionId: string, syncEpoch: string, entries: TranscriptEntryInput[]): void
  getPage(sessionId: string, opts: PageOpts & { agentId?: string | null }): TranscriptPage
  getLatest(sessionId: string, limit: number, agentId?: string | null): TranscriptEntryRecord[]
  getSinceSeq(
    sessionId: string,
    sinceSeq: number,
    limit?: number,
  ): { entries: TranscriptEntryRecord[]; lastSeq: number; gap: boolean }
  getLastSeq(sessionId: string): number
  find(sessionId: string, filter: TranscriptFilter): TranscriptEntryRecord[]
  search(query: string, opts?: { scope?: string; limit?: number }): SearchHit[]
  count(sessionId: string, agentId?: string | null): number
  pruneOlderThan(cutoffMs: number): number
}

export interface TranscriptEntryInput {
  type: string
  subtype?: string
  agentId?: string
  uuid: string
  content: Record<string, unknown>
  timestamp: number
}

// ---------------------------------------------------------------------------
// Events (hook events)
// ---------------------------------------------------------------------------

export interface EventRecord {
  id: number
  sessionId: string
  type: string
  data?: Record<string, unknown>
  createdAt: number
}

export interface EventStore {
  append(sessionId: string, event: EventInput): void
  getForConversation(sessionId: string, opts?: { types?: string[]; limit?: number; afterId?: number }): EventRecord[]
  pruneOlderThan(cutoffMs: number): number
}

export interface EventInput {
  type: string
  data?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Key-Value (replaces all small JSON config files)
// ---------------------------------------------------------------------------

export interface KVStore {
  get<T = unknown>(key: string): T | null
  set<T = unknown>(key: string, value: T): void
  delete(key: string): boolean
  keys(prefix?: string): string[]
}

// ---------------------------------------------------------------------------
// Messages (offline queue + inter-session log)
// ---------------------------------------------------------------------------

export interface EnqueueMessage {
  fromScope: string
  toScope: string
  fromSessionId?: string
  content: string
  intent?: string
  conversationId?: string
  expiresAt: number
}

export interface QueuedMessage {
  id: number
  fromScope: string
  toScope: string
  fromSessionId?: string
  content: string
  intent?: string
  conversationId?: string
  createdAt: number
}

export interface MessageLogEntry {
  id?: number
  fromScope: string
  toScope: string
  fromSessionId?: string
  toSessionId?: string
  content?: string
  intent?: string
  conversationId?: string
  createdAt: number
}

export interface MessageStore {
  enqueue(msg: EnqueueMessage): void
  dequeueFor(scope: string): QueuedMessage[]
  log(entry: MessageLogEntry): void
  queryLog(opts?: { scope?: string; conversationId?: string; limit?: number; afterId?: number }): MessageLogEntry[]
  pruneExpired(): number
}

// ---------------------------------------------------------------------------
// Shares (session sharing via token)
// ---------------------------------------------------------------------------

export interface ShareCreate {
  token: string
  sessionId: string
  permissions: Record<string, boolean>
  expiresAt: number
}

export interface ShareRecord {
  token: string
  sessionId: string
  permissions: Record<string, boolean>
  createdAt: number
  expiresAt: number
  viewerCount: number
}

export interface ShareStore {
  create(share: ShareCreate): ShareRecord
  get(token: string): ShareRecord | null
  getForConversation(sessionId: string): ShareRecord[]
  incrementViewerCount(token: string): void
  delete(token: string): boolean
  deleteExpired(): number
}

// ---------------------------------------------------------------------------
// Address Book (per-scope routing slugs)
// ---------------------------------------------------------------------------

export interface AddressEntry {
  ownerScope: string
  slug: string
  targetScope: string
  createdAt: number
  lastUsed?: number
}

export interface AddressBookStore {
  resolve(ownerScope: string, slug: string): string | null
  set(ownerScope: string, slug: string, targetScope: string): void
  delete(ownerScope: string, slug: string): boolean
  listForScope(ownerScope: string): AddressEntry[]
  findByTarget(targetScope: string): AddressEntry[]
}

// ---------------------------------------------------------------------------
// Scope Links (inter-project trust)
// ---------------------------------------------------------------------------

export type LinkStatus = 'active' | 'pending' | 'blocked'

export interface ScopeLink {
  scopeA: string
  scopeB: string
  status: LinkStatus
  createdAt: number
}

export interface ScopeLinkStore {
  link(scopeA: string, scopeB: string): void
  unlink(scopeA: string, scopeB: string): void
  getStatus(scopeA: string, scopeB: string): LinkStatus | null
  setStatus(scopeA: string, scopeB: string, status: LinkStatus): void
  listLinksFor(scope: string): ScopeLink[]
}

// ---------------------------------------------------------------------------
// Tasks (per-session task tracking)
// ---------------------------------------------------------------------------

export interface TaskRecord {
  id: string
  sessionId: string
  kind: 'task' | 'bg_task' | 'archived'
  status: string
  name?: string
  data?: Record<string, unknown>
  createdAt: number
  updatedAt?: number
}

export interface TaskStore {
  upsert(sessionId: string, task: TaskRecord): void
  getForConversation(sessionId: string, kind?: string): TaskRecord[]
  delete(sessionId: string, taskId: string): boolean
  deleteForConversation(sessionId: string): number
}

// ---------------------------------------------------------------------------
// Cost (per-turn token/cost records + hourly rollups, replaces cost-data.db)
// ---------------------------------------------------------------------------

export interface TurnRecord {
  timestamp: number
  sessionId: string
  projectUri: string
  account: string
  orgId: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  exactCost: boolean
}

export interface HourlyRow {
  hour: string
  account: string
  model: string
  projectUri: string
  turnCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

export interface CostSummary {
  period: string
  totalCostUsd: number
  totalTurns: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  topProjects: Array<{ projectUri: string; costUsd: number; turns: number }>
  topModels: Array<{ model: string; costUsd: number; turns: number }>
}

export interface CumulativeTurnInput {
  timestamp: number
  conversationId: string
  projectUri: string
  account: string
  orgId: string
  model: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheRead: number
  totalCacheWrite: number
  totalCostUsd: number
  exactCost: boolean
}

export interface TurnFilter {
  from?: number
  to?: number
  account?: string
  model?: string
  projectUri?: string
  limit?: number
  offset?: number
}

export interface HourlyFilter {
  from?: number
  to?: number
  account?: string
  model?: string
  projectUri?: string
  groupBy?: 'hour' | 'day'
}

export type CostPeriod = '24h' | '7d' | '30d'

export interface CostStore {
  /** Record a turn with explicit per-turn deltas (caller computed the diff). */
  recordTurn(record: TurnRecord): void
  /**
   * Record a turn from cumulative session totals. The driver tracks per-session
   * snapshots internally and stores the delta. Returns true if a turn was
   * recorded, false if no delta was detected (duplicate/noop).
   */
  recordTurnFromCumulatives(params: CumulativeTurnInput): boolean
  queryTurns(filter: TurnFilter): { rows: TurnRecord[]; total: number }
  queryHourly(filter: HourlyFilter): HourlyRow[]
  querySummary(period: CostPeriod): CostSummary
  /** Delete turns + hourly rows older than cutoffMs. Returns counts deleted. */
  pruneOlderThan(cutoffMs: number): { turns: number; hourly: number }
}

// ---------------------------------------------------------------------------
// StoreDriver -- top-level composition
// ---------------------------------------------------------------------------

export interface StoreConfig {
  type: 'sqlite' | 'memory'
  dataDir?: string
  filename?: string
}

export interface StoreDriver {
  readonly sessions: ConversationStore
  readonly transcripts: TranscriptStore
  readonly events: EventStore
  readonly kv: KVStore
  readonly messages: MessageStore
  readonly shares: ShareStore
  readonly addressBook: AddressBookStore
  readonly scopeLinks: ScopeLinkStore
  readonly tasks: TaskStore
  readonly costs: CostStore

  init(): void
  close(): void
  compact(): void
}
