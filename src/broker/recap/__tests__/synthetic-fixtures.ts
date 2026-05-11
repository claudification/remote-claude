/**
 * Synthetic fixture generators for period-recap tests.
 *
 * Used by:
 *   - prompt-builder size + content tests at small / medium / large scales
 *   - escalate threshold tests
 *   - the optional live OpenRouter test (gated on RECAP_LIVE=1) to exercise
 *     the full prompt against a real model
 *
 * Keep these deterministic (no random) so test assertions stay stable.
 */

import type {
  CommitDigest,
  ConversationDigest,
  CostDigest,
  ErrorDigest,
  OpenQuestionDigest,
  TaskDigest,
  ToolUseDigest,
  TranscriptDigest,
} from '../period/gather/types'
import type { PromptInputs } from '../period/llm/prompt-builder'

const SAMPLE_USER_PROMPTS = [
  'Implement the SQLite migration for recaps_fts table',
  'Why does the broker drop ccSessionId on restart?',
  'Add a recap MCP tool to agents',
  'Fix the WAL corruption that hit us yesterday',
  'Refactor the inter-conversation send to use the new shape',
  'Investigate the spawn timeout race condition',
  'Write the recap viewer modal component',
  'Add tests for the period-recap orchestrator',
  'Document the polymorphic shares table',
  'Wire the jobs widget to the new recap_progress messages',
]

const SAMPLE_ASSISTANT_FINALS = [
  'Done. The recaps_fts virtual table is created via createRecapSchema(); migration runs at startup. I added insert + delete triggers handled in application code instead of SQL triggers because json_extract_text needed JS-side expansion.',
  'The agentHostMeta opaque bag was memory-only. Persisted it to SQLite via persistConversation + loadFromStore. Confirmed revive now reuses the right ccSessionId after broker restart.',
  'Added recap_search / recap_get / recap_list / recap_create MCP tools that pass through to the broker via the new broker-rpc helper. The helper uses requestId correlation, 15s timeout, clears on disconnect.',
  'Restored the WAL via the hourly backup. Added broker-cli exec as the safe alternative to docker cp. Documented the rule in CLAUDE.md gotchas.',
  'Inter-conversation send now uses the conversation_send wire message instead of the legacy session_send. Updated the dispatch table; old name removed.',
  'Spawn timeout was racing with revive_ready. Added a 30s guard before promoting the rendezvous and made the broker reject duplicate promotes by job id.',
  'Built the viewer with Radix Dialog + the existing Markdown component. Live recaps poll /api/recaps/:id every 2s until terminal status.',
  'Added 24 tests covering schedule + cancel + JSON parse + idle-status check. All pass; bun test green.',
  'Added a 60-line section to docs/api-reference.md covering target_kind=conversation vs target_kind=recap and the migration story.',
  'The widget subscribes to recap_progress via Zustand and the WS message handler. Auto-clears done jobs after 3s; failed jobs persist 1h or until dismissed.',
]

function pickFromList<T>(list: T[], i: number): T {
  return list[i % list.length]
}

function genTurns(n: number, seed = 0): TranscriptDigest['turns'] {
  const turns: TranscriptDigest['turns'] = []
  for (let i = 0; i < n; i++) {
    turns.push({
      userPrompt: pickFromList(SAMPLE_USER_PROMPTS, seed + i),
      assistantFinal: pickFromList(SAMPLE_ASSISTANT_FINALS, seed + i),
      timestamp: 1715000000000 + (seed + i) * 60_000,
      turnIndex: i,
    })
  }
  return turns
}

export interface FixtureSize {
  conversations: number
  turnsPerConversation: number
  commits: number
  perTool: number
}

export const SIZES: Record<'small' | 'medium' | 'large' | 'huge', FixtureSize> = {
  small: { conversations: 2, turnsPerConversation: 5, commits: 4, perTool: 3 },
  medium: { conversations: 8, turnsPerConversation: 25, commits: 30, perTool: 8 },
  large: { conversations: 30, turnsPerConversation: 80, commits: 120, perTool: 12 },
  huge: { conversations: 60, turnsPerConversation: 200, commits: 400, perTool: 20 },
}

export function makeConversations(n: number): ConversationDigest[] {
  const out: ConversationDigest[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      id: `conv_${String(i).padStart(3, '0')}`,
      title: `Test conversation ${i}`,
      projectUri: 'claude://default/p/test',
      status: 'ended',
      createdAt: 1715000000000 + i * 60_000,
      updatedAt: 1715000000000 + i * 60_000 + 30_000,
      turnCount: 10,
    })
  }
  return out
}

export function makeTranscripts(convs: ConversationDigest[], turnsPer: number): TranscriptDigest[] {
  return convs.map((c, i) => ({
    conversationId: c.id,
    conversationTitle: c.title,
    turns: genTurns(turnsPer, i * 7),
  }))
}

export function makeCost(convs: ConversationDigest[]): CostDigest {
  const total = convs.length * 0.123
  return {
    totalCostUsd: total,
    totalTurns: convs.length * 10,
    totalInputTokens: convs.length * 1000,
    totalOutputTokens: convs.length * 250,
    totalCacheReadTokens: convs.length * 5000,
    totalCacheWriteTokens: convs.length * 100,
    perDay: [
      {
        day: '2026-05-09',
        costUsd: total * 0.4,
        inputTokens: convs.length * 400,
        outputTokens: convs.length * 100,
        cacheReadTokens: convs.length * 2000,
        cacheWriteTokens: convs.length * 40,
        turns: convs.length * 4,
      },
      {
        day: '2026-05-10',
        costUsd: total * 0.3,
        inputTokens: convs.length * 300,
        outputTokens: convs.length * 75,
        cacheReadTokens: convs.length * 1500,
        cacheWriteTokens: convs.length * 30,
        turns: convs.length * 3,
      },
      {
        day: '2026-05-11',
        costUsd: total * 0.3,
        inputTokens: convs.length * 300,
        outputTokens: convs.length * 75,
        cacheReadTokens: convs.length * 1500,
        cacheWriteTokens: convs.length * 30,
        turns: convs.length * 3,
      },
    ],
    perModel: [
      {
        model: 'anthropic/claude-haiku-4.5',
        costUsd: total * 0.7,
        inputTokens: convs.length * 700,
        outputTokens: convs.length * 200,
        turns: convs.length * 7,
      },
      {
        model: 'anthropic/claude-sonnet-4',
        costUsd: total * 0.3,
        inputTokens: convs.length * 300,
        outputTokens: convs.length * 50,
        turns: convs.length * 3,
      },
    ],
    perConversation: convs.slice(0, 10).map(c => ({
      conversationId: c.id,
      costUsd: total / 10,
      tokens: 1250,
      turns: 10,
    })),
    perProject: [
      {
        projectUri: 'claude://default/p/test',
        costUsd: total,
        tokens: convs.length * 1250,
        conversations: convs.length,
        turns: convs.length * 10,
      },
    ],
  }
}

export function makeTasks(convs: ConversationDigest[]): TaskDigest {
  return {
    doneInPeriod: convs.slice(0, 5).map((c, i) => ({
      id: `task_done_${i}`,
      conversationId: c.id,
      name: `Implement feature ${i}`,
      updatedAt: 1715600000000,
    })),
    createdInPeriod: convs.slice(0, 3).map((c, i) => ({
      id: `task_new_${i}`,
      conversationId: c.id,
      name: `New task ${i}`,
      createdAt: 1715000000000,
      status: 'open',
    })),
    inProgress: convs.slice(0, 2).map((c, i) => ({
      id: `task_wip_${i}`,
      conversationId: c.id,
      name: `Ongoing ${i}`,
    })),
  }
}

export function makeTools(convs: ConversationDigest[], perTool: number): ToolUseDigest {
  const tools = ['Read', 'Edit', 'Bash', 'Grep', 'Glob', 'TodoWrite', 'Write', 'WebFetch']
  return {
    perConversation: convs.slice(0, 10).map(c => ({
      conversationId: c.id,
      perTool: tools.slice(0, perTool).map((t, i) => ({ tool: t, count: 10 + i * 3 })),
      total: tools.slice(0, perTool).reduce((acc, _, i) => acc + (10 + i * 3), 0),
    })),
  }
}

export function makeErrors(): ErrorDigest {
  return {
    incidents: [
      {
        conversationId: 'conv_000',
        timestamp: 1715300000000,
        subtype: 'hook_failure',
        summary: 'PostToolUse hook returned non-zero on Edit',
      },
      {
        conversationId: 'conv_001',
        timestamp: 1715400000000,
        subtype: 'spawn_timeout',
        summary: 'Sentinel did not respond within 120s',
      },
    ],
  }
}

export function makeOpenQuestions(convs: ConversationDigest[]): OpenQuestionDigest {
  return {
    conversationsWithOpenQuestions: convs.slice(0, 2).map(c => ({
      conversationId: c.id,
      conversationTitle: c.title,
      lastUserPrompt: 'Should we keep the legacy hash form for shares?',
      finalAssistantText:
        'I see two paths: keep the hash form indefinitely for backward compat, or sunset it after the migration. Which do you prefer?',
      openQuestions: ['Which do you prefer -- keep or sunset?'],
      timestamp: 1715500000000,
    })),
  }
}

export function makeCommits(n: number): CommitDigest {
  const commits = []
  for (let i = 0; i < n; i++) {
    commits.push({
      sha: `${i.toString(16).padStart(40, '0')}`,
      isoDate: new Date(1715000000000 + i * 3600_000).toISOString(),
      author: 'Jonas',
      subject: `feat: change ${i}`,
      body: pickFromList(SAMPLE_ASSISTANT_FINALS, i),
      filesChanged: 5 + (i % 10),
      insertions: 80 + (i % 50),
      deletions: 20 + (i % 30),
    })
  }
  return {
    perProject: [
      {
        projectUri: 'claude://default/p/test',
        cwd: '/tmp/test',
        commits,
      },
    ],
  }
}

export function makePromptInputs(size: keyof typeof SIZES): PromptInputs {
  const cfg = SIZES[size]
  const conversations = makeConversations(cfg.conversations)
  return {
    projectLabel: `test (${size})`,
    periodHuman: 'Last 7 days',
    periodIsoRange: '2026-05-04 to 2026-05-11',
    conversations,
    transcripts: makeTranscripts(conversations, cfg.turnsPerConversation),
    cost: makeCost(conversations),
    tasks: makeTasks(conversations),
    tools: makeTools(conversations, cfg.perTool),
    errors: makeErrors(),
    openQuestions: makeOpenQuestions(conversations),
    commits: makeCommits(cfg.commits),
  }
}
