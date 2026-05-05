import type { Conversation, ReviveConversation } from '../shared/protocol'

export interface ReviveOverrides {
  headless?: boolean
  effort?: string
  model?: string
  agent?: string
  bare?: boolean
  repl?: boolean
  permissionMode?: string
  autocompactPct?: number
  maxBudgetUsd?: number
  env?: Record<string, string>
}

/**
 * Build a ReviveConversation message from a conversation's full metadata.
 * The broker sends everything it knows; the sentinel picks what it needs.
 */
export function buildReviveMessage(
  conversation: Conversation,
  newConversationId: string,
  overrides?: ReviveOverrides & { jobId?: string },
): ReviveConversation {
  const lc = conversation.launchConfig
  return {
    type: 'revive',
    conversationId: newConversationId,
    project: conversation.project,
    ccSessionId: conversation.ccSessionId || conversation.id,
    jobId: overrides?.jobId,
    sessionName: conversation.title || undefined,
    mode: 'resume',
    headless: overrides?.headless ?? lc?.headless,
    effort: overrides?.effort ?? lc?.effort ?? undefined,
    model: overrides?.model ?? lc?.model ?? conversation.model ?? undefined,
    agent: overrides?.agent ?? lc?.agent ?? conversation.agentName ?? undefined,
    bare: overrides?.bare ?? lc?.bare ?? undefined,
    repl: overrides?.repl ?? lc?.repl ?? undefined,
    permissionMode: overrides?.permissionMode ?? lc?.permissionMode ?? undefined,
    autocompactPct: overrides?.autocompactPct ?? lc?.autocompactPct ?? conversation.autocompactPct,
    maxBudgetUsd: overrides?.maxBudgetUsd ?? lc?.maxBudgetUsd ?? conversation.maxBudgetUsd,
    adHocWorktree: conversation.adHocWorktree || undefined,
    env: overrides?.env ?? lc?.env ?? undefined,
  }
}
