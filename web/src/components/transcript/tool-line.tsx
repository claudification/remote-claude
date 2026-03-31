/**
 * ToolLine - Compact tool display with one-line summary and expandable details.
 * Handles all tool types (Bash, Read, Edit, Write, Agent, MCP, etc.)
 */

import { memo, type ReactNode } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { resolveToolDisplay, type ToolDisplayKey } from '@/lib/dashboard-prefs'
import type { TranscriptContentBlock } from '@/lib/types'
import { cn, truncate } from '@/lib/utils'
import { JsonInspector } from '../json-inspector'
import { Collapsible, getToolStyle, shortPath, TruncatedPre } from './shared'
import { BashOutput, DiffView, ShellCommand, WritePreview } from './tool-renderers'

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}K tok`
  return `${tokens} tok`
}

const TASK_STATUS_STYLES: Record<string, string> = {
  pending: 'bg-yellow-400/15 text-yellow-400 border-yellow-400/30',
  in_progress: 'bg-blue-400/15 text-blue-400 border-blue-400/30',
  completed: 'bg-green-400/15 text-green-400 border-green-400/30',
  deleted: 'bg-red-400/15 text-red-400 border-red-400/30',
}

const TASK_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
  deleted: 'Deleted',
}

function TaskStatusBadge({ status }: { status: string }) {
  const style = TASK_STATUS_STYLES[status] || 'bg-muted text-muted-foreground border-border'
  const label = TASK_STATUS_LABELS[status] || status
  return (
    <span className={cn('px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider border rounded', style)}>
      {label}
    </span>
  )
}

function parseTaskSubjectFromResult(result: string | undefined): string {
  if (!result) return ''
  // "Task #2 created successfully: Server: include transcript counts..."
  const created = result.match(/created successfully:\s*(.+)/)
  if (created) return created[1].trim()
  return ''
}

function parseTaskIdFromResult(result: string | undefined): string {
  if (!result) return ''
  // "Task #2 created successfully: ..."
  const match = result.match(/Task #(\d+)/)
  return match ? match[1] : ''
}

// Snapshot lookup - intentionally NOT reactive (no Zustand selector).
// Transcript entries are immutable once rendered; if task data arrives later,
// the entry won't re-render, but that's acceptable since the subject is
// best-effort display info, not critical data.
function lookupTaskSubject(taskId: string | undefined): string {
  if (!taskId) return ''
  const state = useSessionsStore.getState()
  const sid = state.selectedSessionId
  if (!sid) return ''
  const session = state.sessions.find(s => s.id === sid)
  if (!session) return ''
  return (
    session.activeTasks?.find(t => t.id === taskId)?.subject ||
    session.pendingTasks?.find(t => t.id === taskId)?.subject ||
    session.archivedTasks?.find(t => t.id === taskId)?.subject ||
    ''
  )
}

function createTaskSummary(
  taskId: string | undefined,
  status: string | undefined,
  subject: string,
  desc: string | undefined,
): { summary: React.ReactNode; details: React.ReactNode } {
  return {
    summary: (
      <span className="flex items-center gap-1.5">
        {taskId && <span className="text-muted-foreground font-bold">#{taskId}</span>}
        {status && <TaskStatusBadge status={status} />}
        {subject && <span className="truncate">{subject}</span>}
      </span>
    ),
    details: desc ? (
      <div className="text-[10px] text-muted-foreground pl-1 border-l border-border/30 ml-1">{desc}</div>
    ) : null,
  }
}

export function ToolLine({
  tool,
  result,
  toolUseResult,
  subagents,
  renderAgentInline,
  planContent,
  planPath,
}: {
  tool: TranscriptContentBlock
  result?: string
  toolUseResult?: Record<string, unknown>
  planContent?: string
  planPath?: string
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
  renderAgentInline?: (agentId: string, toolId?: string) => ReactNode
}) {
  const name = tool.name || 'Tool'
  const input = tool.input || {}
  const style = getToolStyle(name)
  const expandAll = useSessionsStore(state => state.expandAll)
  const displayKey = name.startsWith('mcp__') ? 'MCP' : name
  const toolDefaultOpen = useSessionsStore(
    state => resolveToolDisplay(state.dashboardPrefs, displayKey as ToolDisplayKey).defaultOpen,
  )

  let summary: React.ReactNode = ''
  let details: React.ReactNode = null
  let agentBadge: React.ReactNode = null
  let matchedAgentId: string | null = null

  switch (name) {
    case 'Bash': {
      const cmd = input.command as string
      const bashDesc = input.description as string | undefined
      summary = bashDesc || (cmd?.length > 80 && !expandAll ? `${cmd.slice(0, 80)}...` : cmd)
      if (result) {
        details = <BashOutput result={result} command={cmd} />
      } else if (cmd) {
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
      const patches = (toolUseResult as { structuredPatch?: Array<{ oldStart: number; lines: string[] }> })
        ?.structuredPatch
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
      const grepPath = (input.path as string) || ''
      const grepGlob = (input.glob as string) || ''
      const pathHint = grepPath ? ` in ${grepPath}` : ''
      const globHint = grepGlob ? ` (${grepGlob})` : ''
      summary = `${pattern}${pathHint}${globHint}`
      if (result) {
        let grepHighlight: RegExp | undefined
        if (pattern) {
          try {
            grepHighlight = new RegExp(pattern, input['-i'] ? 'gi' : 'g')
          } catch {
            // Invalid regex - skip highlighting
          }
        }
        details = <TruncatedPre text={result} tool={name as ToolDisplayKey} highlight={grepHighlight} />
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
              {subagent.tokenUsage && subagent.tokenUsage.totalOutput > 0 && (
                <span className="text-muted-foreground font-normal">
                  {formatTokenCount(subagent.tokenUsage.totalOutput)} out
                </span>
              )}
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
      const taskId = parseTaskIdFromResult(result)
      const jsx = createTaskSummary(taskId, 'pending', (input.subject as string) || '', input.description as string)
      summary = jsx.summary
      details = jsx.details
      break
    }
    case 'TaskUpdate': {
      const taskId = (input.taskId || input.id || input.task_id) as string | undefined
      const status = (input.status || input.state) as string | undefined
      const subject = (input.subject as string) || parseTaskSubjectFromResult(result) || lookupTaskSubject(taskId)
      const jsx = createTaskSummary(taskId, status, subject, input.description as string)
      summary = jsx.summary
      details = jsx.details
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
      summary = planPath ? `plan: ${shortPath(planPath)}` : 'exiting plan mode'
      if (planContent) {
        details = <WritePreview content={planContent} filePath={planPath || 'plan.md'} />
      }
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
    // rclaude inter-session tools - rich display
    case 'mcp__rclaude__send_message': {
      const to = (input.to as string) || ''
      const intent = (input.intent as string) || ''
      const msg = (input.message as string) || ''
      const intentStyles: Record<string, string> = {
        request: 'bg-yellow-400/15 text-yellow-400 border-yellow-400/30',
        response: 'bg-green-400/15 text-green-400 border-green-400/30',
        notify: 'bg-blue-400/15 text-blue-400 border-blue-400/30',
        progress: 'bg-zinc-400/15 text-zinc-400 border-zinc-400/30',
      }
      summary = (
        <span className="flex items-center gap-1.5">
          <span className="text-teal-400/60">to</span>
          <span className="text-teal-400 font-bold">{to.slice(0, 8)}</span>
          {intent && (
            <span
              className={cn(
                'px-1 py-0.5 text-[8px] font-bold uppercase border rounded',
                intentStyles[intent] || intentStyles.notify,
              )}
            >
              {intent}
            </span>
          )}
        </span>
      )
      if (msg) {
        details = (
          <div className="text-[10px] text-foreground/80 pl-1 border-l border-teal-400/30 ml-1 whitespace-pre-wrap">
            {msg.length > 300 ? `${msg.slice(0, 300)}...` : msg}
          </div>
        )
      }
      break
    }
    case 'mcp__rclaude__revive_session':
    case 'mcp__rclaude__quit_session': {
      const sessionId = (input.session_id as string) || ''
      const action = name.includes('revive') ? 'revive' : 'quit'
      const actionColor = action === 'revive' ? 'text-green-400' : 'text-red-400'
      summary = (
        <span className="flex items-center gap-1.5">
          <span className={actionColor}>{action}</span>
          <span className="text-muted-foreground font-mono">{sessionId.slice(0, 8)}</span>
        </span>
      )
      if (result) details = <TruncatedPre text={result} tool="MCP" />
      break
    }
    case 'mcp__rclaude__list_sessions': {
      summary = input.status ? `status=${input.status}` : 'all'
      if (result) {
        try {
          const sessions = JSON.parse(result) as Array<{ name: string; status: string }>
          summary = `${sessions.length} sessions`
        } catch {
          /* use default */
        }
      }
      if (result) details = <TruncatedPre text={result} tool="MCP" />
      break
    }
    case 'mcp__rclaude__notify': {
      summary = (input.message as string)?.slice(0, 80) || 'notification'
      break
    }
    default: {
      if (name.startsWith('mcp__')) {
        const parts = name.split('__')
        const server = parts[1] || ''
        const toolName = parts.slice(2).join('__') || ''
        // Build a concise summary from input params
        const inputEntries = Object.entries(input).filter(([k]) => k !== 'type')
        const inputSummary = inputEntries
          .map(([k, v]) => {
            const val = typeof v === 'string' ? v : JSON.stringify(v)
            return `${k}=${typeof val === 'string' && val.length > 40 ? `${val.slice(0, 40)}...` : val}`
          })
          .join(', ')
        summary = inputSummary || `${server}/${toolName}`
        // Show result as expandable output
        if (result && typeof result === 'string' && result.trim()) {
          details = <TruncatedPre text={result} tool="MCP" />
        }
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
        <Collapsible id={tool.id ? `tool-${tool.id}` : undefined} label="output" defaultOpen={toolDefaultOpen}>
          {details}
        </Collapsible>
      )}
      {matchedAgentId && renderAgentInline?.(matchedAgentId, tool.id)}
    </div>
  )
}

export const MemoizedToolLine = memo(ToolLine)
