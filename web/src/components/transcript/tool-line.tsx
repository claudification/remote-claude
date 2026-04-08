/**
 * ToolLine - Compact tool display with one-line summary and expandable details.
 * Handles all tool types (Bash, Read, Edit, Write, Agent, MCP, etc.)
 */

import { memo, type ReactNode } from 'react'
import { Markdown } from '@/components/markdown'
import { useSessionsStore } from '@/hooks/use-sessions'
import { resolveToolDisplay, type ToolDisplayKey } from '@/lib/dashboard-prefs'
import type { TranscriptContentBlock } from '@/lib/types'
import { cn, haptic, truncate } from '@/lib/utils'
import { JsonInspector } from '../json-inspector'
import { Collapsible, getToolStyle, shortPath, TruncatedPre } from './shared'
import { BashOutput, DiffView, ShellCommand, WritePreview } from './tool-renderers'

/** Slugify a name the same way the concentrator address-book does. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'project'
  )
}

/** Find a session matching an address book slug (best-effort client-side match). */
function findSessionBySlug(slug: string) {
  const { sessions, projectSettings } = useSessionsStore.getState()
  const normalizedSlug = slug.toLowerCase()
  for (const s of sessions) {
    // Check project label from settings
    const ps = projectSettings[s.cwd]
    if (ps?.label && slugify(ps.label) === normalizedSlug) return s
    // Check session title
    if (s.title && slugify(s.title) === normalizedSlug) return s
    // Check dirname
    const dirname = s.cwd?.split('/').pop() || ''
    if (dirname && slugify(dirname) === normalizedSlug) return s
  }
  return undefined
}

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
  isError,
  expandAll: expandAllProp,
  subagents,
  renderAgentInline,
  planContent,
  planPath,
}: {
  tool: TranscriptContentBlock
  result?: string
  toolUseResult?: Record<string, unknown>
  isError?: boolean
  expandAll?: boolean
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
  const expandAllStore = useSessionsStore(state => state.expandAll)
  const expandAll = expandAllProp ?? expandAllStore
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
      // Find target session: try direct ID match first, then slug match
      const targetSession = useSessionsStore.getState().sessions.find(s => s.id === to) || findSessionBySlug(to)
      const targetName = targetSession?.title || targetSession?.cwd?.split('/').pop() || to
      const intentStyles: Record<string, string> = {
        request: 'bg-yellow-400/15 text-yellow-400 border-yellow-400/30',
        response: 'bg-green-400/15 text-green-400 border-green-400/30',
        notify: 'bg-blue-400/15 text-blue-400 border-blue-400/30',
        progress: 'bg-zinc-400/15 text-zinc-400 border-zinc-400/30',
      }
      summary = (
        <span className="flex items-center gap-1.5">
          <span className="text-teal-400/60">to</span>
          <button
            type="button"
            className="text-teal-400 font-bold hover:text-teal-300 hover:underline"
            onClick={() => {
              if (targetSession) {
                haptic('tap')
                useSessionsStore.getState().selectSession(targetSession.id)
              }
            }}
          >
            {targetName}
          </button>
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
          <div className="rounded-lg border border-teal-500/20 bg-teal-500/5 px-3 py-2 my-1">
            <div className="text-sm prose-sm">
              <Markdown>{msg}</Markdown>
            </div>
          </div>
        )
      }
      break
    }
    case 'mcp__rclaude__revive_session':
    case 'mcp__rclaude__terminate_session':
    case 'mcp__rclaude__quit_session': {
      // deprecated alias
      const sessionId = (input.session_id as string) || ''
      const action = name.includes('revive') ? 'revive' : 'terminate'
      const actionColor = action === 'revive' ? 'text-green-400' : 'text-red-400'
      const sess = useSessionsStore.getState().sessions.find(s => s.id === sessionId)
      const sessName = sess?.title || sess?.cwd?.split('/').pop() || sessionId.slice(0, 8)
      summary = (
        <span className="flex items-center gap-1.5">
          <span className={actionColor}>{action}</span>
          <span className="text-teal-400 font-bold">{sessName}</span>
        </span>
      )
      if (result) details = <TruncatedPre text={result} tool="MCP" />
      break
    }
    case 'mcp__rclaude__list_sessions': {
      summary = input.status ? `status=${input.status}` : 'all'
      if (result) {
        try {
          let parsed = JSON.parse(result)
          // MCP tool results are wrapped: [{ type: 'text', text: '...' }] - unwrap
          if (Array.isArray(parsed) && parsed[0]?.type === 'text' && typeof parsed[0].text === 'string') {
            parsed = JSON.parse(parsed[0].text)
          }
          const sessions = parsed as Array<{ id: string; name: string; cwd: string; status: string }>
          summary = `${sessions.length} sessions`
          details = (
            <div className="text-[10px] font-mono space-y-0.5 mt-1">
              {sessions.map(s => (
                <div key={s.id} className="flex items-center gap-2">
                  <span
                    className={cn(
                      'w-1.5 h-1.5 rounded-full shrink-0',
                      s.status === 'live' ? 'bg-green-400' : 'bg-zinc-600',
                    )}
                  />
                  <span className="text-teal-400">{s.name}</span>
                  <span className="text-muted-foreground/40 truncate">{s.cwd}</span>
                </div>
              ))}
            </div>
          )
        } catch {
          details = <TruncatedPre text={result} tool="MCP" />
        }
      }
      break
    }
    case 'mcp__rclaude__notify': {
      summary = (input.message as string)?.slice(0, 80) || 'notification'
      break
    }
    case 'mcp__rclaude__spawn_session': {
      const cwd = input.cwd as string
      const mode = input.mode as string | undefined
      const shortCwd = shortPath(cwd) || cwd
      const modeLabel = mode === 'continue' ? 'continue' : mode === 'resume' ? 'resume' : 'fresh'
      // Parse result for session metadata
      let spawnedSession: Record<string, unknown> | undefined
      if (result) {
        try {
          let parsed = JSON.parse(result)
          if (Array.isArray(parsed) && parsed[0]?.type === 'text') parsed = JSON.parse(parsed[0].text)
          if (parsed.session) spawnedSession = parsed.session as Record<string, unknown>
        } catch {}
      }
      summary = (
        <span className="flex items-center gap-1.5">
          <span className="text-green-400">spawn</span>
          <span className="text-foreground font-bold">{shortCwd}</span>
          <span className="text-muted-foreground text-[10px]">[{modeLabel}]</span>
        </span>
      )
      if (isError) {
        details = <pre className="text-[10px] text-red-400 bg-red-400/10 p-2 rounded whitespace-pre-wrap">{result}</pre>
      } else if (spawnedSession) {
        const sid = (spawnedSession.id as string) || ''
        const ver = spawnedSession.claudeVersion as string
        const model = spawnedSession.model as string
        const rcVer = spawnedSession.version as string
        const caps = spawnedSession.capabilities as string[] | undefined
        const auth = spawnedSession.claudeAuth as { email?: string; subscriptionType?: string } | undefined
        const status = spawnedSession.status as string
        const capColors: Record<string, string> = {
          terminal: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
          channel: 'bg-violet-500/20 text-violet-400 border-violet-500/30',
        }
        const subColors: Record<string, string> = {
          max: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
          pro: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
          team: 'bg-teal-500/20 text-teal-400 border-teal-500/30',
        }
        details = (
          <div className="text-[10px] font-mono bg-green-400/5 border border-green-500/20 rounded p-2.5 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-green-400 font-bold">{sid.slice(0, 12)}</span>
              {status && (
                <span className="px-1.5 py-0.5 bg-green-500/20 text-green-400 border border-green-500/30 rounded text-[9px] font-bold uppercase">
                  {status}
                </span>
              )}
              {auth?.subscriptionType && (
                <span
                  className={cn(
                    'px-1.5 py-0.5 border rounded text-[9px] font-bold uppercase',
                    subColors[auth.subscriptionType] || 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
                  )}
                >
                  {auth.subscriptionType}
                </span>
              )}
              {caps?.map(c => (
                <span
                  key={c}
                  className={cn(
                    'px-1.5 py-0.5 border rounded text-[9px] font-bold',
                    capColors[c] || 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
                  )}
                >
                  {c}
                </span>
              ))}
            </div>
            <div className="flex items-center gap-3 text-muted-foreground flex-wrap">
              {model && (
                <span>
                  <span className="text-muted-foreground/50">model</span>{' '}
                  <span className="text-foreground/70">{model}</span>
                </span>
              )}
              {ver && (
                <span>
                  <span className="text-muted-foreground/50">cc</span> <span className="text-foreground/70">{ver}</span>
                </span>
              )}
              {rcVer && (
                <span>
                  <span className="text-muted-foreground/50">rclaude</span>{' '}
                  <span className="text-foreground/70">{rcVer}</span>
                </span>
              )}
            </div>
            {auth?.email && (
              <div className="text-muted-foreground/60">
                <span className="text-foreground/50">{auth.email}</span>
              </div>
            )}
          </div>
        )
      }
      break
    }
    case 'mcp__rclaude__dialog': {
      const title = (input.title as string) || 'Dialog'
      const pageCount = Array.isArray(input.pages) ? (input.pages as unknown[]).length : 0
      const bodyCount = Array.isArray(input.body) ? (input.body as unknown[]).length : 0
      const componentDesc = pageCount > 0 ? `${pageCount} pages` : `${bodyCount} components`
      summary = (
        <span className="flex items-center gap-1.5">
          <span className="text-violet-400 font-bold">{title}</span>
          <span className="text-muted-foreground/50 text-[10px]">{componentDesc}</span>
        </span>
      )
      // Non-blocking: tool returns a status message, result comes via channel
      details = (
        <div className="text-[10px] font-mono bg-violet-500/5 border border-violet-500/20 rounded px-3 py-2 text-violet-400/70">
          Waiting for user response...
        </div>
      )
      break
    }
    // mcp__rclaude__terminate_session + quit_session handled above (line ~473)
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

  // Show error result when no details are set but tool returned an error
  if (isError && !details && result) {
    // Extract clean error message from tool_use_error XML
    const errorMatch = result.match(/<tool_use_error>([\s\S]*?)<\/tool_use_error>/)
    const errorMsg = errorMatch ? errorMatch[1].trim() : result
    details = (
      <div className="text-[10px] text-red-400/90 bg-red-400/5 border border-red-400/20 rounded px-2.5 py-1.5 font-mono">
        {errorMsg}
      </div>
    )
  }

  // Handle persisted-output (tool result too large)
  if (!isError && !details && result) {
    const persistedMatch = result.match(/<persisted-output>\s*([\s\S]*?)\s*<\/persisted-output>/)
    if (persistedMatch) {
      const inner = persistedMatch[1]
      const sizeMatch = inner.match(/Output too large \(([^)]+)\)/)
      const pathMatch = inner.match(/Full output saved to: (.+?)(?:\n|$)/)
      const previewMatch = inner.match(/Preview \(first [^)]+\):\s*([\s\S]*)/)
      const size = sizeMatch?.[1] || 'large'
      const path = pathMatch?.[1]?.trim()
      details = (
        <div className="text-[10px] font-mono">
          <div className="flex items-center gap-2 px-2.5 py-1.5 bg-amber-400/5 border border-amber-400/15 rounded-t text-amber-400/80">
            <span className="font-bold">{size}</span>
            <span className="text-muted-foreground">output truncated</span>
            {path && <span className="text-muted-foreground/50 truncate ml-auto">{path.split('/').pop()}</span>}
          </div>
          {previewMatch?.[1] && (
            <pre className="bg-black/30 p-2 rounded-b whitespace-pre-wrap break-words text-foreground/70 max-h-32 overflow-y-auto">
              {previewMatch[1].trim().slice(0, 500)}
            </pre>
          )}
        </div>
      )
    }
  }

  return (
    <div className={cn('font-mono text-xs', isError && 'border-l-2 border-red-500/60 pl-1.5')}>
      <div className="flex items-center gap-2">
        <span className={cn('shrink-0 flex items-center gap-1', isError ? 'text-red-400' : style.color)} title={name}>
          <Icon className="w-3 h-3 shrink-0" />
          <span className="truncate max-w-[120px]">{displayName}</span>
        </span>
        <span className={cn('truncate flex-1', isError ? 'text-red-400/80' : 'text-foreground/80')}>
          {isError && <span className="text-red-500 font-bold mr-1">ERROR</span>}
          {summary}
        </span>
        {agentBadge}
        <JsonInspector title={name} data={input} result={result} extra={toolUseResult} />
      </div>
      {details && (
        <Collapsible
          id={tool.id ? `tool-${tool.id}` : undefined}
          label="output"
          defaultOpen={isError || toolDefaultOpen}
        >
          {details}
        </Collapsible>
      )}
      {matchedAgentId && renderAgentInline?.(matchedAgentId, tool.id)}
    </div>
  )
}

export const MemoizedToolLine = memo(ToolLine)
