/**
 * ToolLine - Compact tool display with one-line summary and expandable details.
 * Handles all tool types (Bash, Read, Edit, Write, Agent, MCP, etc.)
 */

import { structuredPatch } from 'diff'
import { memo, type ReactNode } from 'react'
import { Markdown } from '@/components/markdown'
import { useSessionsStore } from '@/hooks/use-sessions'
import { resolveToolDisplay, type ToolDisplayKey } from '@/lib/control-panel-prefs'
import { projectPath, type TranscriptContentBlock } from '@/lib/types'
import { cn, truncate } from '@/lib/utils'
import { JsonInspector } from '../json-inspector'
import { FileListResults, GlobSummary, GrepContentResults, GrepCountResults, GrepSummary } from './grep-results'
import { SessionTag } from './session-tag'
import { Collapsible, cleanCdPrefix, getToolStyle, shortPath, TruncatedPre } from './shared'
import { BashOutput, DiffView, ReplResult, ReplView, ShellCommand, WritePreview } from './tool-renderers'

/**
 * Try to extract readable text from an MCP tool result.
 * MCP results are often JSON-encoded arrays of content blocks: [{"type":"text","text":"..."}]
 * or a JSON string wrapping such an array in a `result` field.
 * Returns the concatenated text if detected, or null if the result isn't MCP-shaped.
 */
function extractMcpResultText(result: string): string | null {
  if (!result || typeof result !== 'string') return null
  const trimmed = result.trim()
  // Must look like JSON
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null
  try {
    let parsed = JSON.parse(trimmed)
    // Handle { result: "[{\"type\":\"text\",...}]" } wrapper
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.result === 'string') {
      try {
        parsed = JSON.parse(parsed.result)
      } catch {
        return null
      }
    }
    // Must be an array of content blocks
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    // Every element must have type === 'text' and a text field
    if (!parsed.every((b: { type?: string; text?: string }) => b.type === 'text' && typeof b.text === 'string'))
      return null
    const text = parsed.map((b: { text: string }) => b.text).join('\n\n')
    // Only worth rendering as markdown if there's actual content
    return text.trim() || null
  } catch {
    return null
  }
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
  const session = sid ? state.sessionsById[sid] : undefined
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
    state => resolveToolDisplay(state.controlPanelPrefs, displayKey as ToolDisplayKey).defaultOpen,
  )
  // Path sanitization for command display
  const sessionPath = useSessionsStore(s => {
    if (s.controlPanelPrefs.sanitizePaths === false) return undefined
    const sid = s.selectedSessionId
    const session = sid ? s.sessionsById[sid] : undefined
    return session ? projectPath(session.project) : undefined
  })

  let summary: React.ReactNode = ''
  let details: React.ReactNode = null
  let inlineContent: React.ReactNode = null // always-visible content below header (not inside Collapsible)
  let agentBadge: React.ReactNode = null
  let matchedAgentId: string | null = null

  switch (name) {
    case 'Bash': {
      const cmd = input.command as string
      const bashDesc = input.description as string | undefined
      const displayCmd = sessionPath && cmd ? cleanCdPrefix(cmd, sessionPath) : cmd
      summary = bashDesc || (displayCmd?.length > 80 && !expandAll ? `${displayCmd.slice(0, 80)}...` : displayCmd)
      if (result || toolUseResult?.stdout) {
        details = <BashOutput result={result || ''} command={cmd} extra={toolUseResult} />
      } else if (cmd) {
        details = <ShellCommand command={cmd} />
      }
      break
    }
    case 'REPL': {
      const replDesc = input.description as string | undefined
      const replCode = input.code as string
      summary = replDesc || (replCode?.length > 80 ? `${replCode.slice(0, 80)}...` : replCode)
      if (replCode) {
        inlineContent = <ReplView code={replCode} isError={isError} />
        // Result/stdout/stderr go into the collapsible
        const hasResult = result || toolUseResult?.result
        const hasStdout = toolUseResult?.stdout && (toolUseResult.stdout as string).trim()
        const hasStderr = toolUseResult?.stderr && (toolUseResult.stderr as string).trim()
        if (hasResult || hasStdout || hasStderr) {
          details = <ReplResult result={result} extra={toolUseResult} isError={isError} />
        }
      }
      break
    }
    case 'Read': {
      const path = input.file_path as string
      const readPath = shortPath(path) || path

      // Binary Read result (headless mode: toolUseResult has file with url/originalSize)
      // Handles images, PDFs, and any other binary type CC produces
      if (toolUseResult?.type && toolUseResult.type !== 'text') {
        const binFile = toolUseResult.file as
          | {
              url?: string
              type?: string
              originalSize?: number
              dimensions?: {
                originalWidth: number
                originalHeight: number
                displayWidth: number
                displayHeight: number
              }
            }
          | undefined
        const binType = toolUseResult.type as string
        const isImage = binType === 'image'
        const dims = binFile?.dimensions
        const dimStr = dims ? `${dims.originalWidth}x${dims.originalHeight}` : ''
        const sizeKB = binFile?.originalSize ? `${(binFile.originalSize / 1024).toFixed(0)}KB` : ''
        summary = (
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-foreground/90">{readPath}</span>
            {!isImage && <span className="text-violet-400/70 shrink-0">{binType}</span>}
            {dimStr && <span className="text-cyan-400/70 shrink-0">{dimStr}</span>}
            {sizeKB && <span className="text-muted-foreground/50 shrink-0">({sizeKB})</span>}
          </span>
        )
        if (binFile?.url) {
          if (isImage) {
            details = (
              <div className="space-y-1.5 py-1">
                <img
                  src={binFile.url}
                  alt={path?.split('/').pop() || 'image'}
                  className="max-w-sm max-h-64 rounded border border-border/50 hover:border-primary/50 transition-colors"
                  loading="lazy"
                />
              </div>
            )
          } else {
            // Non-image binary (PDF, etc.) -- show download link
            details = (
              <div className="text-[10px] font-mono flex items-center gap-2 py-1">
                {binFile.type && <span className="text-muted-foreground">{binFile.type}</span>}
                {sizeKB && <span className="text-muted-foreground">{sizeKB}</span>}
                <a
                  href={binFile.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:text-accent/80 underline"
                >
                  view file
                </a>
              </div>
            )
          }
        } else {
          details = (
            <div className="text-[10px] text-muted-foreground font-mono flex items-center gap-2 py-1">
              {binFile?.type && <span>{binFile.type}</span>}
              {dimStr && <span>{dimStr}</span>}
              {sizeKB && <span>{sizeKB}</span>}
              <span className="text-amber-400/70">(file not available)</span>
            </div>
          )
        }
        break
      }

      // Text Read result -- headless mode puts file content in toolUseResult.file
      const readFile = toolUseResult?.file as
        | { content?: string; filePath?: string; numLines?: number; startLine?: number; totalLines?: number }
        | undefined
      const readContent = result || readFile?.content
      const startLine = readFile?.startLine ?? (input.offset as number | undefined)
      const numLines = readFile?.numLines
      const totalLines = readFile?.totalLines
      // Partial read: show "lines X-Y of Z" with colored segments
      // Full read: show just total count
      const endLine = startLine && numLines ? startLine + numLines - 1 : undefined
      const isPartial = Boolean(startLine && totalLines && (startLine > 1 || (numLines && numLines < totalLines)))
      summary = (
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="truncate text-foreground/90">{readPath}</span>
          {isPartial && startLine && endLine && totalLines ? (
            <span className="text-muted-foreground/70 shrink-0">
              lines <span className="text-sky-400">{startLine}</span>
              <span className="text-muted-foreground/50">-</span>
              <span className="text-sky-400">{endLine}</span>
              <span className="text-muted-foreground/50"> of </span>
              <span className="text-foreground/70">{totalLines.toLocaleString()}</span>
            </span>
          ) : totalLines ? (
            <span className="text-muted-foreground/70 shrink-0">
              <span className="text-foreground/70">{totalLines.toLocaleString()}</span>{' '}
              <span className="text-muted-foreground/50">lines</span>
            </span>
          ) : null}
        </span>
      )
      if (readContent) {
        details = <WritePreview content={readContent} filePath={path} />
      }
      break
    }
    case 'Edit': {
      const path = input.file_path as string
      summary = shortPath(path) || path
      if (!isError) {
        const patches = (toolUseResult as { structuredPatch?: Array<{ oldStart: number; lines: string[] }> })
          ?.structuredPatch
        if (patches?.length) {
          details = <DiffView patches={patches} filePath={path} />
        } else if (input.old_string && input.new_string) {
          // Compute diff with proper line numbers using originalFile when available
          const oldStr = input.old_string as string
          const newStr = input.new_string as string
          const originalFile = (toolUseResult as { originalFile?: string })?.originalFile
          let patch: ReturnType<typeof structuredPatch>
          if (originalFile) {
            const modifiedFile = originalFile.replace(oldStr, newStr)
            patch = structuredPatch('file', 'file', originalFile, modifiedFile, '', '', { context: 3 })
          } else {
            patch = structuredPatch('file', 'file', oldStr, newStr, '', '', { context: 3 })
          }
          if (patch.hunks.length > 0) {
            details = <DiffView patches={patch.hunks} filePath={path} />
          }
        }
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
        details = (
          <div className="max-h-96 overflow-y-auto rounded border border-border/30 bg-black/20 px-3 py-2 text-[11px]">
            <Markdown>{result}</Markdown>
          </div>
        )
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
      const extra = toolUseResult as
        | {
            mode?: 'files_with_matches' | 'content' | 'count'
            filenames?: string[]
            numFiles?: number
            numMatches?: number
            numLines?: number
            content?: string
            truncated?: boolean
          }
        | undefined
      const filenames = Array.isArray(extra?.filenames) ? extra.filenames : undefined
      // Grep's mode defaults to files_with_matches when omitted (matches CC's tool spec)
      const mode = name === 'Glob' ? undefined : extra?.mode || (filenames ? 'files_with_matches' : undefined)

      let grepHighlight: RegExp | undefined
      if (pattern) {
        try {
          grepHighlight = new RegExp(pattern, input['-i'] ? 'gi' : 'g')
        } catch {
          // Invalid regex - skip highlighting
        }
      }

      if (name === 'Glob') {
        summary = (
          <GlobSummary
            pattern={pattern}
            path={grepPath || undefined}
            numFiles={extra?.numFiles ?? filenames?.length}
            truncated={extra?.truncated}
            isError={isError}
          />
        )
      } else {
        summary = (
          <GrepSummary
            pattern={pattern}
            path={grepPath || undefined}
            glob={grepGlob || undefined}
            numFiles={extra?.numFiles ?? filenames?.length}
            numMatches={extra?.numMatches}
            numLines={extra?.numLines}
            mode={mode}
            isError={isError}
          />
        )
      }

      if (!isError) {
        if (mode === 'content' && extra?.content) {
          details = (
            <GrepContentResults
              content={extra.content}
              filenames={filenames ?? []}
              numLines={extra.numLines}
              numFiles={extra.numFiles}
              highlight={grepHighlight}
            />
          )
        } else if (mode === 'count' && extra?.content) {
          details = <GrepCountResults content={extra.content} numMatches={extra.numMatches} numFiles={extra.numFiles} />
        } else if (filenames) {
          details = (
            <FileListResults
              filenames={filenames}
              numFiles={extra?.numFiles}
              truncated={extra?.truncated}
              emptyLabel={name === 'Glob' ? 'No files matched' : 'No matches'}
            />
          )
        } else if (result) {
          // Fallback: pre-structured-result transcripts (older sessions)
          details = <TruncatedPre text={result} tool={name as ToolDisplayKey} highlight={grepHighlight} />
        }
      } else if (result) {
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
      const todos = input.todos as Array<{ content: string; activeForm?: string; status?: string }>
      if (todos?.length) {
        const total = todos.length
        const completed = todos.filter(t => t.status === 'completed').length
        const inProgress = todos.find(t => t.status === 'in_progress')
        const nextPending = todos.find(t => !t.status || t.status === 'pending')
        const allDone = completed === total
        const someStarted = completed > 0 || !!inProgress

        let label: React.ReactNode
        if (allDone) {
          label = <span className="text-green-400 font-semibold">All done</span>
        } else if (inProgress) {
          label = (
            <>
              <span className="text-blue-400/80 font-semibold shrink-0">Working on:</span>
              <span className="text-foreground/85 truncate">{inProgress.activeForm || inProgress.content}</span>
            </>
          )
        } else if (someStarted && nextPending) {
          label = (
            <>
              <span className="text-amber-400/80 font-semibold shrink-0">Next:</span>
              <span className="text-foreground/85 truncate">{nextPending.content}</span>
            </>
          )
        } else {
          label = (
            <span className="text-foreground/85">
              {total} item{total !== 1 ? 's' : ''}
            </span>
          )
        }

        summary = (
          <span className="flex items-center gap-1.5 min-w-0">
            {label}
            {!allDone && someStarted && (
              <span className="shrink-0 text-muted-foreground/50 text-[10px] tabular-nums">
                ({completed}/{total})
              </span>
            )}
          </span>
        )
        details = (
          <div className="text-[10px] font-mono text-muted-foreground">
            {todos.slice(0, 10).map((t, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: todo items are positional display list, no stable IDs
              <div key={i} className="flex items-baseline gap-1.5">
                <span
                  className={cn(
                    'shrink-0',
                    t.status === 'completed' && 'text-green-400',
                    t.status === 'in_progress' && 'text-blue-400',
                    (!t.status || t.status === 'pending') && 'text-foreground/40',
                  )}
                >
                  {t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'}
                </span>
                <span
                  className={cn(
                    t.status === 'completed' && 'text-muted-foreground/60 line-through',
                    t.status === 'in_progress' && 'text-foreground/85',
                  )}
                >
                  {t.status === 'in_progress' ? t.activeForm || t.content : t.content}
                </span>
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
    case 'ScheduleWakeup': {
      const reason = input.reason as string
      const delay = input.delaySeconds as number
      const prompt = input.prompt as string
      const mins = delay ? Math.round(delay / 60) : 0
      summary = (
        <span className="flex items-center gap-1.5">
          <span className="text-amber-400">{mins}m</span>
          <span className="truncate">{reason}</span>
        </span>
      )
      if (prompt && prompt !== '<<autonomous-loop-dynamic>>') {
        details = (
          <pre className="text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap">
            {truncate(prompt, 500)}
          </pre>
        )
      }
      break
    }
    case 'Monitor': {
      const monDesc = (input.description as string) || ''
      const monCmd = (input.command as string) || ''
      const monTimeout = input.timeout_ms as number | undefined
      const monPersistent = input.persistent as boolean | undefined
      const monExtra = toolUseResult as Record<string, unknown> | undefined
      const monTaskId = (monExtra?.taskId as string) || ''
      const timeoutLabel = monTimeout ? `${Math.round(monTimeout / 1000)}s` : ''
      summary = (
        <span className="flex items-center gap-1.5">
          <span className="truncate">{monDesc || 'monitor'}</span>
          {timeoutLabel && <span className="text-violet-400/60">{timeoutLabel}</span>}
          {monPersistent && <span className="text-violet-400/50 text-[9px]">persistent</span>}
          {monTaskId && <span className="text-muted-foreground font-mono text-[9px]">{monTaskId.slice(0, 8)}</span>}
        </span>
      )
      if (monCmd) {
        details = (
          <pre className="text-[10px] font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap">
            <span className="text-violet-400/70">$</span> {truncate(monCmd, 500)}
          </pre>
        )
      }
      break
    }
    // rclaude inter-session tools - rich display
    case 'mcp__rclaude__send_message': {
      const to = (input.to as string) || ''
      const intent = (input.intent as string) || ''
      const msg = (input.message as string) || ''
      const targetIdMatch = result?.match(/target_session_id:\s*([0-9a-f-]{36})/)
      const targetSessionId = targetIdMatch?.[1]
      const intentStyles: Record<string, string> = {
        request: 'bg-yellow-400/15 text-yellow-400 border-yellow-400/30',
        response: 'bg-green-400/15 text-green-400 border-green-400/30',
        notify: 'bg-blue-400/15 text-blue-400 border-blue-400/30',
        progress: 'bg-zinc-400/15 text-zinc-400 border-zinc-400/30',
      }
      summary = (
        <span className="flex items-center gap-1.5">
          <span className="text-teal-400/60">to</span>
          <SessionTag idOrSlug={to} resolvedId={targetSessionId} />
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
              <Markdown copyable>{msg}</Markdown>
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
      summary = (
        <span className="flex items-center gap-1.5">
          <span className={actionColor}>{action}</span>
          <SessionTag idOrSlug={sessionId} />
        </span>
      )
      if (result) details = <TruncatedPre text={result} tool="MCP" />
      break
    }
    case 'mcp__rclaude__list_sessions': {
      const parts: string[] = []
      if (input.filter) parts.push(`glob=${input.filter}`)
      if (input.status) parts.push(`status=${input.status}`)
      summary = parts.length ? parts.join(' ') : 'all'
      if (result) {
        try {
          let parsed = JSON.parse(result)
          // MCP tool results are wrapped: [{ type: 'text', text: '...' }] - unwrap
          if (Array.isArray(parsed) && parsed[0]?.type === 'text' && typeof parsed[0].text === 'string') {
            parsed = JSON.parse(parsed[0].text)
          }
          // Handle both formats: flat array (legacy) or { self, sessions } (current)
          const sessions: Array<{ id: string; status: string }> = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.sessions)
              ? parsed.sessions
              : []
          summary = `${sessions.length} sessions` + (parts.length ? ` (${parts.join(', ')})` : '')
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
                  <SessionTag idOrSlug={s.id} />
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
      const inputCwd = input.cwd as string
      const mode = input.mode as string | undefined
      const shortCwd = shortPath(inputCwd) || inputCwd
      const modeLabel = mode === 'resume' ? 'resume' : 'fresh'
      const spawnName = input.name as string | undefined
      const spawnModel = input.model as string | undefined
      const spawnWorktree = input.worktree as string | undefined
      const spawnHeadless = input.headless as boolean | undefined
      const spawnPermMode = input.permissionMode as string | undefined
      const spawnPrompt = input.prompt as string | undefined
      const spawnEffort = input.effort as string | undefined
      const spawnAdHoc = input.adHoc as boolean | undefined
      const spawnDescription = input.description as string | undefined

      const resultText = result ? extractMcpResultText(result) || result : undefined

      summary = (
        <span className="flex items-center gap-1.5 flex-wrap">
          <span className="text-green-400">spawn</span>
          {spawnName ? (
            <>
              <span className="text-foreground font-bold">{spawnName}</span>
              <span className="text-muted-foreground">{shortCwd}</span>
            </>
          ) : (
            <span className="text-foreground font-bold">{shortCwd}</span>
          )}
          <span className="text-muted-foreground text-[10px]">[{modeLabel}]</span>
          {spawnModel && (
            <span className="px-1 py-0.5 bg-violet-500/20 text-violet-400 border border-violet-500/30 rounded text-[9px] font-bold">
              {spawnModel}
            </span>
          )}
          {spawnWorktree && (
            <span className="px-1 py-0.5 bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 rounded text-[9px]">
              {spawnWorktree}
            </span>
          )}
          {spawnHeadless && <span className="text-muted-foreground text-[10px]">headless</span>}
        </span>
      )

      if (isError) {
        details = <pre className="text-[10px] text-red-400 bg-red-400/10 p-2 rounded whitespace-pre-wrap">{result}</pre>
      } else {
        const badges: Array<{ label: string; value: string; cls: string }> = []
        if (spawnPermMode)
          badges.push({
            label: 'perms',
            value: spawnPermMode,
            cls:
              spawnPermMode === 'bypassPermissions'
                ? 'bg-red-500/20 text-red-400 border-red-500/30'
                : 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
          })
        if (spawnEffort)
          badges.push({
            label: 'effort',
            value: spawnEffort,
            cls: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
          })
        if (spawnAdHoc)
          badges.push({ label: '', value: 'ad-hoc', cls: 'bg-orange-500/20 text-orange-400 border-orange-500/30' })

        const promptCharCount = spawnPrompt ? spawnPrompt.length : 0
        const promptLabel = `Prompt (${promptCharCount >= 1000 ? `${(promptCharCount / 1000).toFixed(1)}k` : promptCharCount} chars)`

        details = (
          <div className="text-[10px] font-mono bg-green-400/5 border border-green-500/20 rounded p-2.5 space-y-2">
            {badges.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {badges.map(b => (
                  <span key={b.value} className={cn('px-1.5 py-0.5 border rounded text-[9px] font-bold', b.cls)}>
                    {b.label ? `${b.label}: ` : ''}
                    {b.value}
                  </span>
                ))}
              </div>
            )}
            {spawnDescription && <div className="text-foreground/70 text-[11px]">{spawnDescription}</div>}
            {spawnPrompt && (
              <Collapsible label={promptLabel} defaultOpen={false}>
                <div className="max-h-[400px] overflow-y-auto border-l-2 border-green-500/30 pl-2.5">
                  <div className="text-[11px] font-sans prose-sm">
                    <Markdown>{spawnPrompt}</Markdown>
                  </div>
                </div>
              </Collapsible>
            )}
            {resultText && <div className="text-green-400/80 pt-1 border-t border-green-500/10">{resultText}</div>}
          </div>
        )
      }
      break
    }
    case 'mcp__rclaude__control_session': {
      const ctrlAction = input.action as string
      const ctrlTarget = input.session_id as string
      const ctrlModel = input.model as string | undefined
      const ctrlEffort = input.effort as string | undefined
      const ctrlPermMode = input.permissionMode as string | undefined
      const resultText = result ? extractMcpResultText(result) || result : undefined

      const actionColors: Record<string, string> = {
        quit: 'text-red-400',
        clear: 'text-amber-400',
        interrupt: 'text-orange-400',
        set_model: 'text-violet-400',
        set_effort: 'text-cyan-400',
        set_permission_mode: 'text-blue-400',
      }
      const actionLabel =
        ctrlAction === 'set_model'
          ? `model -> ${ctrlModel}`
          : ctrlAction === 'set_effort'
            ? `effort -> ${ctrlEffort}`
            : ctrlAction === 'set_permission_mode'
              ? `perms -> ${ctrlPermMode}`
              : ctrlAction
      summary = (
        <span className="flex items-center gap-1.5">
          <span className={actionColors[ctrlAction] || 'text-foreground'}>{actionLabel}</span>
          <span className="text-muted-foreground">{ctrlTarget}</span>
        </span>
      )
      if (isError) {
        details = <pre className="text-[10px] text-red-400 bg-red-400/10 p-2 rounded whitespace-pre-wrap">{result}</pre>
      } else if (resultText) {
        details = (
          <div className="text-[10px] font-mono text-muted-foreground bg-muted/30 rounded px-3 py-1.5">
            {resultText}
          </div>
        )
      }
      break
    }
    case 'mcp__rclaude__configure_session': {
      const cfgTarget = input.session_id as string
      const cfgFields = ['label', 'icon', 'color', 'description', 'keyterms']
        .filter(k => input[k] !== undefined)
        .join(', ')
      summary = (
        <span className="flex items-center gap-1.5">
          <span className="text-blue-400">configure</span>
          <span className="text-muted-foreground">{cfgTarget}</span>
          <span className="text-muted-foreground/50 text-[10px]">[{cfgFields || 'no fields'}]</span>
        </span>
      )
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
        // Show result as expandable output - render as markdown if it's MCP content blocks
        if (result && typeof result === 'string' && result.trim()) {
          const mcpText = extractMcpResultText(result)
          if (mcpText) {
            details = (
              <div className="text-xs prose-sm max-h-96 overflow-y-auto">
                <Markdown>{mcpText}</Markdown>
              </div>
            )
          } else {
            details = <TruncatedPre text={result} tool="MCP" />
          }
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
      {inlineContent}
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
