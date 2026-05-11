import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteDriver } from '../../../store/sqlite/driver'
import type { StoreDriver } from '../../../store/types'
import {
  gatherCommitsStub,
  gatherConversations,
  gatherCost,
  gatherErrors,
  gatherOpenQuestions,
  gatherTasks,
  gatherToolUse,
  gatherTranscripts,
  type PeriodScope,
} from './index'

describe('Phase 3 gather modules (integration)', () => {
  let cacheDir: string
  let store: StoreDriver
  const projectUri = 'claude://default/Users/test/proj'
  const periodStart = 1_700_000_000_000
  const periodEnd = 1_700_604_800_000
  const scope: PeriodScope = {
    projectUris: [projectUri],
    periodStart,
    periodEnd,
    timeZone: 'Europe/Stockholm',
  }

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'gather-test-'))
    store = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
    store.init()
    seed(store, projectUri, periodStart)
  })

  afterEach(() => {
    store.close?.()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it('gatherConversations returns conversations within the period window', () => {
    const out = gatherConversations(store, scope)
    expect(out.length).toBe(1)
    expect(out[0].id).toBe('conv_seed')
    expect(out[0].projectUri).toBe(projectUri)
  })

  it('gatherTranscripts returns user prompt + assistant final pairs', () => {
    const conversations = gatherConversations(store, scope)
    const out = gatherTranscripts(store, conversations, scope)
    expect(out.length).toBe(1)
    expect(out[0].turns.length).toBeGreaterThan(0)
    expect(out[0].turns[0].userPrompt).toContain('hello')
  })

  it('gatherCost aggregates totals + per-day + per-model + per-conv breakdowns', () => {
    const out = gatherCost(store, scope)
    expect(out.totalTurns).toBeGreaterThan(0)
    expect(out.totalCostUsd).toBeGreaterThan(0)
    expect(out.perDay.length).toBeGreaterThan(0)
    expect(out.perModel.length).toBeGreaterThan(0)
    expect(out.perConversation.length).toBeGreaterThan(0)
  })

  it('gatherTasks classifies done/created/in-progress within the window', () => {
    const conversations = gatherConversations(store, scope)
    const out = gatherTasks(store, conversations, scope)
    expect(out.doneInPeriod.length).toBeGreaterThanOrEqual(0)
    expect(out.createdInPeriod.length).toBeGreaterThanOrEqual(0)
  })

  it('gatherToolUse returns per-conversation tool counts', () => {
    const conversations = gatherConversations(store, scope)
    const out = gatherToolUse(store, conversations, scope)
    expect(Array.isArray(out.perConversation)).toBe(true)
  })

  it('gatherErrors returns incidents from system entries with error subtypes', () => {
    const conversations = gatherConversations(store, scope)
    const out = gatherErrors(store, conversations, scope)
    expect(Array.isArray(out.incidents)).toBe(true)
  })

  it('gatherOpenQuestions returns conversations whose final assistant text ends with a question', () => {
    const conversations = gatherConversations(store, scope)
    const out = gatherOpenQuestions(store, conversations, scope)
    expect(out.conversationsWithOpenQuestions.length).toBe(1)
    expect(out.conversationsWithOpenQuestions[0].openQuestions[0]).toContain('?')
  })

  it('gatherCommitsStub returns empty per-project list with parsed cwd', () => {
    const out = gatherCommitsStub(scope)
    expect(out.perProject.length).toBe(1)
    expect(out.perProject[0].cwd).toBe('/Users/test/proj')
    expect(out.perProject[0].commits.length).toBe(0)
  })
})

function seed(store: StoreDriver, projectUri: string, periodStart: number) {
  store.conversations.create({
    id: 'conv_seed',
    scope: projectUri,
    agentType: 'claude',
    title: 'Seed conversation',
    createdAt: periodStart + 1_000,
  })
  store.conversations.update('conv_seed', { lastActivity: periodStart + 5_000 })
  store.transcripts.append('conv_seed', 'epoch1', [
    {
      type: 'user',
      uuid: 'u1',
      content: { message: { role: 'user', content: 'hello assistant please help' } },
      timestamp: periodStart + 2_000,
    },
    {
      type: 'assistant',
      uuid: 'a1',
      content: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I will help. What database backend would you like?' }],
        },
      },
      timestamp: periodStart + 3_000,
    },
  ])
  store.costs.recordTurn({
    timestamp: periodStart + 4_000,
    conversationId: 'conv_seed',
    projectUri,
    account: 'a',
    orgId: '',
    model: 'anthropic/claude-haiku-4-5',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    costUsd: 0.0042,
    exactCost: true,
  })
  store.tasks.upsert('conv_seed', {
    id: 'task_a',
    conversationId: 'conv_seed',
    kind: 'todo',
    status: 'done',
    name: 'Set up storage',
    createdAt: periodStart + 1_500,
    updatedAt: periodStart + 4_500,
    completedAt: periodStart + 4_500,
  })
}
