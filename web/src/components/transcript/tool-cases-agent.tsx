import type { ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { cn, truncate } from '@/lib/utils'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K tok`
  return `${tokens} tok`
}

export function renderAgentTask(name: string, ctx: ToolCaseInput): ToolCaseResult {
  const { input, subagents } = ctx
  const desc = input.description as string
  // Canonical: input.agent (was subagent_type in Claude legacy)
  const agentType = input.agent as string
  const prompt = input.prompt as string
  const summary = agentType ? `${agentType}: ${desc}` : desc
  let details = null
  if (prompt) {
    details = (
      <pre className="text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap">
        {truncate(prompt, 2000)}
      </pre>
    )
  }
  let agentBadge: ReactNode = null
  let matchedAgentId: string | null = null
  if (name === 'Agent') {
    const subagent = subagents?.find(a => a.description === desc)
    if (subagent) {
      matchedAgentId = subagent.agentId
      const isRunning = subagent.status === 'running'
      const elapsed = subagent.stoppedAt
        ? Math.round((subagent.stoppedAt - subagent.startedAt) / 1000)
        : Math.round((Date.now() - subagent.startedAt) / 1000)
      const agentIdForNav = subagent.agentId
      agentBadge = (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation()
            const store = useConversationsStore.getState()
            store.selectSubagent(agentIdForNav)
            if (store.selectedConversationId) {
              store.openTab(store.selectedConversationId, 'transcript')
            }
          }}
          className={cn(
            'inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold cursor-pointer hover:brightness-125 transition-all',
            isRunning ? 'bg-active/20 text-active animate-pulse' : 'bg-emerald-500/20 text-emerald-400',
          )}
          title="View agent transcript"
        >
          {isRunning ? 'running' : 'done'}
          {subagent.eventCount > 0 && (
            <span className="text-muted-foreground font-normal">{subagent.eventCount} events</span>
          )}
          <span className="text-muted-foreground font-normal">{elapsed}s</span>
          {subagent.tokenUsage && subagent.tokenUsage.totalOutput > 0 && (
            <span className="text-muted-foreground font-normal">
              {formatTokenCount(subagent.tokenUsage.totalOutput)} out
            </span>
          )}
        </button>
      )
    }
  }
  return { summary, details, agentBadge, matchedAgentId }
}

export function renderAskUserQuestion({ input }: ToolCaseInput): ToolCaseResult {
  const questions = input.questions as Array<{
    question: string
    header?: string
    options?: Array<{ label: string }>
  }>
  let summary: ReactNode = ''
  let details: ReactNode = null
  if (questions?.length) {
    const q0 = questions[0].question
    summary = q0.length > 60 ? `${q0.slice(0, 60)}...` : q0
    details = (
      <div className="text-[10px] font-mono space-y-1 mt-1">
        {questions.map((q, qi) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: question list items are positional, no stable IDs
          <div key={qi}>
            {q.header && <span className="text-amber-400/70">[{q.header}] </span>}
            <span className="text-foreground/80">{q.question}</span>
            {q.options && (
              <div className="ml-2 text-muted-foreground">
                {q.options.map((o, oi) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: option list items are positional, no stable IDs
                  <div key={oi} className="text-amber-400/50">
                    {'>'} {o.label}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    )
  }
  return { summary, details }
}
