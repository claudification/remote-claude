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
  create(conversation: ConversationCreate): ConversationRecord
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
  conversationId: string
  seq: number
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
  id: number
  conversationId: string
  seq: number
  type: string
  subtype?: string
  content: Record<string, unknown>
  timestamp: number
  rank: number
  snippet: string
}

export interface SearchOpts {
  conversationId?: string
  conversationIds?: string[]
  scope?: string
  types?: string[]
  limit?: number
  offset?: number
}

export interface WindowOpts {
  aroundSeq?: number
  aroundId?: number
  before?: number
  after?: number
}

export interface SearchIndexStats {
  /** Number of source rows in transcript_entries. */
  totalEntries: number
  /** Number of documents currently in the FTS5 inverted index (or totalEntries
   *  for the memory driver, which has no separate index structure). */
  indexedDocs: number
  /** Distinct conversation IDs represented in transcript_entries. */
  conversations: number
  /** indexedDocs == totalEntries -- a quick "is the index up to date?" probe. */
  isComplete: boolean
}

export interface RebuildResult {
  /** Documents present in the rebuilt index. */
  docsIndexed: number
  durationMs: number
}

export interface TranscriptStore {
  append(conversationId: string, syncEpoch: string, entries: TranscriptEntryInput[]): void
  getPage(conversationId: string, opts: PageOpts & { agentId?: string | null }): TranscriptPage
  getLatest(conversationId: string, limit: number, agentId?: string | null): TranscriptEntryRecord[]
  getSinceSeq(
    conversationId: string,
    sinceSeq: number,
    limit?: number,
  ): { entries: TranscriptEntryRecord[]; lastSeq: number; gap: boolean }
  getLastSeq(conversationId: string): number
  find(conversationId: string, filter: TranscriptFilter): TranscriptEntryRecord[]
  search(query: string, opts?: SearchOpts): SearchHit[]
  getWindow(conversationId: string, opts: WindowOpts): TranscriptEntryRecord[]
  count(conversationId: string, agentId?: string | null): number
  pruneOlderThan(cutoffMs: number): number
  /** Inspect FTS index health -- doc counts, completeness, conversation breadth. */
  getIndexStats(): SearchIndexStats
  /** Drop and rebuild the FTS index from transcript_entries. Memory driver no-ops. */
  rebuildIndex(): RebuildResult
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
  conversationId: string
  type: string
  data?: Record<string, unknown>
  createdAt: number
}

export interface EventStore {
  append(conversationId: string, event: EventInput): void
  getForConversation(
    conversationId: string,
    opts?: { types?: string[]; limit?: number; afterId?: number },
  ): EventRecord[]
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
// Messages (offline queue + inter-conversation log)
// ---------------------------------------------------------------------------

export interface EnqueueMessage {
  fromScope: string
  toScope: string
  fromConversationId?: string
  fromName?: string
  targetName?: string
  content: string
  intent?: string
  conversationId?: string
  expiresAt: number
}

export interface QueuedMessage {
  id: number
  fromScope: string
  toScope: string
  fromConversationId?: string
  fromName?: string
  targetName?: string
  content: string
  intent?: string
  conversationId?: string
  createdAt: number
}

export interface MessageLogEntry {
  id?: number
  fromScope: string
  toScope: string
  fromConversationId?: string
  toConversationId?: string
  fromName?: string
  toName?: string
  content?: string
  intent?: string
  conversationId?: string
  fullLength?: number
  createdAt: number
}

export interface MessageStore {
  enqueue(msg: EnqueueMessage): void
  dequeueFor(scope: string, targetName?: string): QueuedMessage[]
  countFor(scope: string): number
  log(entry: MessageLogEntry): void
  queryLog(opts?: {
    scope?: string
    conversationId?: string
    limit?: number
    afterId?: number
    before?: number
  }): MessageLogEntry[]
  purgeLog(scopeA: string, scopeB: string): number
  compactLog(retentionMs: number, maxEntries: number): number
  pruneExpired(): number
}

// ---------------------------------------------------------------------------
// Shares (conversation sharing via token)
// ---------------------------------------------------------------------------

export interface ShareCreate {
  token: string
  conversationId: string
  permissions: Record<string, boolean>
  expiresAt: number
}

export interface ShareRecord {
  token: string
  conversationId: string
  permissions: Record<string, boolean>
  createdAt: number
  expiresAt: number
  viewerCount: number
}

export interface ShareStore {
  create(share: ShareCreate): ShareRecord
  get(token: string): ShareRecord | null
  getForConversation(conversationId: string): ShareRecord[]
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
// Tasks (per-conversation task tracking)
// ---------------------------------------------------------------------------

export interface TaskRecord {
  id: string
  conversationId: string
  /** 'todo' | 'project' | future kinds. Free string so the store stays neutral. */
  kind: string
  status: string
  /** Short label / subject. Stored in the `name` column for legacy reasons. */
  name?: string
  description?: string
  priority?: number
  orderIndex?: number
  blockedBy?: string[]
  blocks?: string[]
  owner?: string
  /** Catch-all JSON for kind-specific extras. */
  data?: Record<string, unknown>
  createdAt: number
  updatedAt?: number
  completedAt?: number
  /** Non-null = the task has been archived (no longer in the active list). */
  archivedAt?: number
}

export interface TaskQuery {
  kind?: string
  /** true = archived only, false = active only, undefined = both */
  archived?: boolean
  /** archived_at >= since (ms epoch) */
  archivedSince?: number
  limit?: number
}

export interface TaskStore {
  upsert(conversationId: string, task: TaskRecord): void
  getForConversation(conversationId: string, query?: TaskQuery): TaskRecord[]
  delete(conversationId: string, taskId: string): boolean
  deleteForConversation(conversationId: string): number
  /** Delete archived tasks where archived_at < cutoffMs. Returns rows deleted. */
  pruneArchivedBefore(cutoffMs: number): number
}

// ---------------------------------------------------------------------------
// Cost (per-turn token/cost records + hourly rollups, replaces cost-data.db)
// ---------------------------------------------------------------------------

export interface TurnRecord {
  timestamp: number
  conversationId: string
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
   * Record a turn from cumulative session totals. The driver tracks per-conversation
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
  readonly conversations: ConversationStore
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
