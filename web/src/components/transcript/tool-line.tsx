/**
 * ToolLine - Compact tool display with one-line summary and expandable details.
 * Handles all tool types (Bash, Read, Edit, Write, Agent, MCP, etc.)
 */

import React, { Suspense } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { resolveToolDisplay, type ToolDisplayKey } from '@/lib/dashboard-prefs'
import type { TranscriptContentBlock } from '@/lib/types'
import { cn, truncate } from '@/lib/utils'
import { JsonInspector } from '../json-inspector'
import { Collapsible, getToolStyle, shortPath, TruncatedPre } from './shared'
import { DiffView, ShellCommand, WritePreview } from './tool-renderers'

// Lazy import to break circular dependency: agent-views -> ToolLine -> AgentTranscriptInline -> agent-views
const LazyAgentTranscriptInline = React.lazy(() =>
  import('./agent-views').then(m => ({ default: m.AgentTranscriptInline })),
)

function AgentInline({ agentId, toolId }: { agentId: string; toolId?: string }) {
  return (
    <Suspense fallback={<div className="text-[10px] text-muted-foreground">loading...</div>}>
      <LazyAgentTranscriptInline agentId={agentId} toolId={toolId} />
    </Suspense>
  )
}

export function ToolLine({
  tool,
  result,
  toolUseResult,
  subagents,
}: {
  tool: TranscriptContentBlock
  result?: string
  toolUseResult?: Record<string, unknown>
  subagents?: Array<{
    agentId: string
    agentType: string
    description?: string
    status: 'running' | 'stopped'
    startedAt: number
    stoppedAt?: number
    eventCount: number
  }>
}) {
  const name = tool.name || 'Tool'
  const input = tool.input || {}
  const style = getToolStyle(name)
  const expandAll = useSessionsStore(state => state.expandAll)
  const dashPrefs = useSessionsStore(state => state.dashboardPrefs)
  const toolPrefs = resolveToolDisplay(dashPrefs, name as ToolDisplayKey)

  let summary = ''
  let details: React.ReactNode = null
  let agentBadge: React.ReactNode = null
  let matchedAgentId: string | null = null

  switch (name) {
    case 'Bash': {
      const cmd = input.command as string
      summary = cmd?.length > 80 && !expandAll ? `${cmd.slice(0, 80)}...` : cmd
      if (result) {
        details = (
          <div className="space-y-1">
            {expandAll && cmd && <ShellCommand command={cmd} />}
            <TruncatedPre text={result} tool="Bash" />
          </div>
        )
      } else if (expandAll && cmd) {
        details = <ShellCommand command={cmd} />
      }
      break
    }
    case 'Read': {
      const path = input.file_path as string
      summary = shortPath(path) || path
      if (expandAll && result && typeof result === 'string') {
        details = <TruncatedPre text={result} tool="Read" />
      }
      break
    }
    case 'Edit': {
      const path = input.file_path as string
      summary = shortPath(path) || path
      const patches = (toolUseResult as any)?.structuredPatch
      if (patches?.length) {
        details = <DiffView patches={patches} filePath={path} />
      }
      break
    }
    case 'Write': {
      const path = input.file_path as string
      const content = input.content as string
      summary = `${shortPath(path)} (${content?.length || 0} chars)`
      if (content) {
        details = <WritePreview content={content} filePath={path} />
      }
      break
    }
    case 'WebSearch': {
      const query = input.query as string
      summary = query
      if (result) {
        details = <TruncatedPre text={result} tool="WebSearch" />
      }
      break
    }
    case 'WebFetch': {
      const url = input.url as string
      try {
        const parsed = new URL(url)
        summary = parsed.hostname + parsed.pathname
      } catch {
        summary = url
      }
      if (result) {
        details = <TruncatedPre text={result} tool="WebFetch" />
      }
      break
    }
    case 'Glob':
    case 'Grep': {
      const pattern = input.pattern as string
      summary = pattern
      if (result) {
        details = <TruncatedPre text={result} tool={name as ToolDisplayKey} />
      }
      break
    }
    case 'Task':
    case 'Agent': {
      const desc = input.description as string
      const agentType = input.subagent_type as string
      const prompt = input.prompt as string
      summary = agentType ? `${agentType}: ${desc}` : desc
      if (prompt) {
        details = (
          <pre className="text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap">
            {truncate(prompt, 2000)}
          </pre>
        )
      }
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
                const store = useSessionsStore.getState()
                store.selectSubagent(agentIdForNav)
                if (store.selectedSessionId) {
                  store.openTab(store.selectedSessionId, 'transcript')
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
            </button>
          )
        }
      }
      break
    }
    case 'AskUserQuestion': {
      const questions = input.questions as Array<{
        question: string
        header?: string
        options?: Array<{ label: string }>
      }>
      if (questions?.length) {
        const q0 = questions[0].question
        summary = q0.length > 60 ? `${q0.slice(0, 60)}...` : q0
        details = (
          <div className="text-[10px] font-mono space-y-1 mt-1">
            {questions.map((q, qi) => (
              <div key={qi}>
                {q.header && <span className="text-amber-400/70">[{q.header}] </span>}
                <span className="text-foreground/80">{q.question}</span>
                {q.options && (
                  <div className="ml-2 text-muted-foreground">
                    {q.options.map((o, oi) => (
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
      break
    }
    case 'ToolSearch': {
      const query = input.query as string
      summary = query
      break
    }
    case 'TaskCreate': {
      const desc = input.description as string
      summary = desc?.length > 60 ? `${desc.slice(0, 60)}...` : desc
      break
    }
    case 'TaskUpdate': {
      const taskId = (input.taskId || input.id || input.task_id) as string | undefined
      const status = (input.status || input.state) as string | undefined
      const parts: string[] = []
      if (taskId) parts.push(`#${taskId}`)
      if (status) parts.push(status)
      if (input.addBlockedBy) parts.push('blockedBy')
      if (input.description) parts.push(String(input.description).slice(0, 50))
      summary = parts.join(' ') || 'update'
      break
    }
    case 'TaskOutput':
    case 'TaskList':
    case 'TaskStop': {
      const taskId = (input.taskId || input.id || input.task_id) as string
      summary = taskId ? `#${taskId}` : ''
      if (result) {
        details = <pre className="text-[10px] text-muted-foreground overflow-x-auto">{truncate(result, 500)}</pre>
      }
      break
    }
    case 'TodoWrite': {
      const todos = input.todos as Array<{ content: string; status?: string }>
      if (todos?.length) {
        summary = `${todos.length} item${todos.length !== 1 ? 's' : ''}`
        details = (
          <div className="text-[10px] font-mono text-muted-foreground">
            {todos.slice(0, 10).map((t, i) => (
              <div key={i}>
                <span className={t.status === 'completed' ? 'text-green-400' : 'text-foreground/60'}>
                  {t.status === 'completed' ? '[x]' : '[ ]'}
                </span>{' '}
                {t.content}
              </div>
            ))}
            {todos.length > 10 && <div>... +{todos.length - 10} more</div>}
          </div>
        )
      }
      break
    }
    case 'Skill': {
      const skill = input.skill as string
      const args = input.args as string
      summary = args ? `${skill} ${args}` : skill
      break
    }
    case 'EnterPlanMode':
      summary = 'entering plan mode'
      break
    case 'ExitPlanMode':
      summary = 'exiting plan mode'
      break
    case 'NotebookEdit': {
      const cellId = input.cell_id as string
      summary = cellId ? `cell ${cellId}` : 'edit'
      break
    }
    case 'SendMessage': {
      const msg = input.message as string
      summary = msg?.length > 60 ? `${msg.slice(0, 60)}...` : msg
      break
    }
    case 'TeamCreate':
    case 'TeamDelete': {
      const teamName = input.name as string
      summary = teamName || ''
      break
    }
    case 'CronCreate': {
      const cronExpr = input.cron as string
      const prompt = input.prompt as string
      const recurring = input.recurring as boolean
      summary = `${cronExpr}${recurring ? ' (recurring)' : ''}`
      if (prompt) {
        details = (
          <pre className="text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap">
            {truncate(prompt, 500)}
          </pre>
        )
      }
      break
    }
    case 'CronList': {
      const extra = toolUseResult as Record<string, unknown> | undefined
      const jobs = extra?.jobs as
        | Array<{ id: string; humanSchedule: string; prompt: string; recurring: boolean }>
        | undefined
      if (jobs?.length) {
        summary = `${jobs.length} job${jobs.length !== 1 ? 's' : ''}`
        details = (
          <div className="text-[10px] font-mono text-muted-foreground space-y-0.5">
            {jobs.map(j => (
              <div key={j.id}>
                <span className="text-sky-400">{j.id.slice(0, 8)}</span>{' '}
                <span className="text-foreground/70">{j.humanSchedule}</span>
                {j.recurring && <span className="text-muted-foreground"> (recurring)</span>}
                {' - '}
                <span>{truncate(j.prompt, 80)}</span>
              </div>
            ))}
          </div>
        )
      } else {
        summary = 'no jobs'
      }
      break
    }
    case 'CronDelete': {
      const jobId = input.id as string
      summary = jobId ? `delete ${jobId.slice(0, 8)}` : 'delete'
      break
    }
    default: {
      if (name.startsWith('mcp__')) {
        const parts = name.split('__')
        const server = parts[1] || ''
        const toolName = parts.slice(2).join('__') || ''
        summary = `${server}/${toolName}`
      } else {
        summary = JSON.stringify(input).slice(0, 60)
      }
    }
  }

  const { Icon } = style
  const displayName = name.startsWith('mcp__')
    ? name.split('__').slice(2).join('/') || name.split('__')[1] || name
    : name

  return (
    <div className="font-mono text-xs">
      <div className="flex items-center gap-2">
        <span className={cn('shrink-0 flex items-center gap-1', style.color)} title={name}>
          <Icon className="w-3 h-3 shrink-0" />
          <span className="truncate max-w-[120px]">{displayName}</span>
        </span>
        <span className="text-foreground/80 truncate flex-1">{summary}</span>
        {agentBadge}
        <JsonInspector title={name} data={input} result={result} extra={toolUseResult} />
      </div>
      {details && (
        <Collapsible id={tool.id ? `tool-${tool.id}` : undefined} label="output" defaultOpen={toolPrefs.defaultOpen}>
          {details}
        </Collapsible>
      )}
      {matchedAgentId && <AgentInline agentId={matchedAgentId} toolId={tool.id} />}
    </div>
  )
}
