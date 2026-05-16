import type { ReactNode } from 'react'

export interface ToolCaseResult {
  summary: ReactNode
  details: ReactNode
  inlineContent?: ReactNode
  agentBadge?: ReactNode
  matchedAgentId?: string | null
}

export interface ToolCaseInput {
  input: Record<string, unknown>
  result?: string
  toolUseResult?: Record<string, unknown>
  isError?: boolean
  conversationPath?: string
  expandAll: boolean
  subagents?: Array<{
    agentId: string
    agentType: string
    description?: string
    status: 'running' | 'stopped'
    startedAt: number
    stoppedAt?: number
    eventCount: number
    tokenUsage?: { totalInput: number; totalOutput: number; cacheCreation: number; cacheRead: number }
  }>
  planContent?: string
  planPath?: string
}
