import type { StoreDriver, TurnRecord } from '../../../store/types'
import type { CostDigest, PeriodScope } from './types'

export function gatherCost(store: StoreDriver, scope: PeriodScope): CostDigest {
  const turns = collectTurns(store, scope)
  return buildDigest(turns, scope.timeZone)
}

function collectTurns(store: StoreDriver, scope: PeriodScope): TurnRecord[] {
  const all: TurnRecord[] = []
  for (const projectUri of scope.projectUris) {
    const { rows } = store.costs.queryTurns({
      from: scope.periodStart,
      to: scope.periodEnd,
      projectUri,
      limit: 100_000,
    })
    all.push(...rows)
  }
  return all
}

// fallow-ignore-next-line complexity
function buildDigest(turns: TurnRecord[], timeZone: string): CostDigest {
  const totals = aggregateTotals(turns)
  const perDay = aggregatePerDay(turns, timeZone)
  const perModel = aggregatePerModel(turns)
  const perConv = aggregatePerConversation(turns)
  const perProject = aggregatePerProject(turns)
  return { ...totals, perDay, perModel, perConversation: perConv, perProject }
}

function aggregateTotals(turns: TurnRecord[]) {
  let totalCostUsd = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheWriteTokens = 0
  for (const t of turns) {
    totalCostUsd += t.costUsd
    totalInputTokens += t.inputTokens
    totalOutputTokens += t.outputTokens
    totalCacheReadTokens += t.cacheReadTokens
    totalCacheWriteTokens += t.cacheWriteTokens
  }
  return {
    totalCostUsd,
    totalTurns: turns.length,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
  }
}

function aggregatePerDay(turns: TurnRecord[], timeZone: string) {
  const byDay = new Map<string, ReturnType<typeof emptyDayBucket>>()
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  for (const t of turns) {
    const day = fmt.format(new Date(t.timestamp))
    const bucket = byDay.get(day) ?? emptyDayBucket(day)
    bucket.costUsd += t.costUsd
    bucket.inputTokens += t.inputTokens
    bucket.outputTokens += t.outputTokens
    bucket.cacheReadTokens += t.cacheReadTokens
    bucket.cacheWriteTokens += t.cacheWriteTokens
    bucket.turns += 1
    byDay.set(day, bucket)
  }
  return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day))
}

function emptyDayBucket(day: string) {
  return { day, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 }
}

function aggregatePerModel(turns: TurnRecord[]) {
  const byModel = new Map<
    string,
    { model: string; costUsd: number; inputTokens: number; outputTokens: number; turns: number }
  >()
  for (const t of turns) {
    const cur = byModel.get(t.model) ?? { model: t.model, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 }
    cur.costUsd += t.costUsd
    cur.inputTokens += t.inputTokens
    cur.outputTokens += t.outputTokens
    cur.turns += 1
    byModel.set(t.model, cur)
  }
  return Array.from(byModel.values()).sort((a, b) => b.costUsd - a.costUsd)
}

function aggregatePerConversation(turns: TurnRecord[]) {
  const byConv = new Map<string, { conversationId: string; costUsd: number; tokens: number; turns: number }>()
  for (const t of turns) {
    const cur = byConv.get(t.conversationId) ?? { conversationId: t.conversationId, costUsd: 0, tokens: 0, turns: 0 }
    cur.costUsd += t.costUsd
    cur.tokens += t.inputTokens + t.outputTokens
    cur.turns += 1
    byConv.set(t.conversationId, cur)
  }
  return Array.from(byConv.values())
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 10)
}

function aggregatePerProject(turns: TurnRecord[]) {
  const byProject = new Map<
    string,
    { projectUri: string; costUsd: number; tokens: number; turns: number; conversations: Set<string> }
  >()
  for (const t of turns) {
    const cur = byProject.get(t.projectUri) ?? {
      projectUri: t.projectUri,
      costUsd: 0,
      tokens: 0,
      turns: 0,
      conversations: new Set<string>(),
    }
    cur.costUsd += t.costUsd
    cur.tokens += t.inputTokens + t.outputTokens
    cur.turns += 1
    cur.conversations.add(t.conversationId)
    byProject.set(t.projectUri, cur)
  }
  return Array.from(byProject.values())
    .map(p => ({
      projectUri: p.projectUri,
      costUsd: p.costUsd,
      tokens: p.tokens,
      turns: p.turns,
      conversations: p.conversations.size,
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
}
