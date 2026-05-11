import type { PeriodTurn } from '../../shared/transcript-extract'

export interface PeriodScope {
  /** Project URIs in scope (parent + worktree rollup, or '*' resolved to all). */
  projectUris: string[]
  periodStart: number
  periodEnd: number
  timeZone: string
}

export interface ConversationDigest {
  id: string
  title: string
  projectUri: string
  status: string
  createdAt: number
  updatedAt: number
  turnCount: number
}

export interface TranscriptDigest {
  conversationId: string
  conversationTitle: string
  turns: PeriodTurn[]
}

export interface CostDigest {
  totalCostUsd: number
  totalTurns: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  perDay: Array<{
    day: string
    costUsd: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    turns: number
  }>
  perModel: Array<{ model: string; costUsd: number; inputTokens: number; outputTokens: number; turns: number }>
  perConversation: Array<{ conversationId: string; costUsd: number; tokens: number; turns: number }>
  perProject: Array<{ projectUri: string; costUsd: number; tokens: number; turns: number; conversations: number }>
}

export interface TaskDigest {
  doneInPeriod: Array<{ id: string; conversationId: string; name: string; updatedAt: number }>
  createdInPeriod: Array<{ id: string; conversationId: string; name: string; createdAt: number; status: string }>
  inProgress: Array<{ id: string; conversationId: string; name: string }>
}

export interface ToolUseDigest {
  perConversation: Array<{
    conversationId: string
    perTool: Array<{ tool: string; count: number }>
    total: number
  }>
}

export interface ErrorDigest {
  incidents: Array<{
    conversationId: string
    timestamp: number
    subtype: string
    summary: string
  }>
}

export interface OpenQuestionDigest {
  /** Conversations whose final assistant message ends with an unanswered question. */
  conversationsWithOpenQuestions: Array<{
    conversationId: string
    conversationTitle: string
    lastUserPrompt: string
    finalAssistantText: string
    openQuestions: string[]
    timestamp: number
  }>
}

export interface CommitDigest {
  perProject: Array<{
    projectUri: string
    cwd: string
    commits: CommitEntry[]
    error?: string
  }>
}

export interface CommitEntry {
  sha: string
  isoDate: string
  author: string
  subject: string
  body: string
  filesChanged?: number
  insertions?: number
  deletions?: number
}
