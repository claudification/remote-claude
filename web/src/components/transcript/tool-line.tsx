import { memo, type ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { resolveToolDisplay, type ToolDisplayKey } from '@/lib/control-panel-prefs'
import { projectPath, type TranscriptContentBlock } from '@/lib/types'
import { cn } from '@/lib/utils'
import { JsonInspector } from '../json-inspector'
import { Collapsible, getToolStyle } from './shared'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'
import { renderAgentTask, renderAskUserQuestion } from './tool-cases-agent'
import { renderBash, renderEdit, renderRead, renderRepl, renderWrite } from './tool-cases-core'
import {
  renderGmailDraftEmail,
  renderGmailGetThread,
  renderGmailInbox,
  renderGmailLabelOp,
  renderGmailListLabels,
  renderGmailSearchEmails,
  renderGmailSend,
} from './tool-cases-gmail'
import {
  renderMcpConfigureSession,
  renderMcpControlSession,
  renderMcpDefault,
  renderMcpDialog,
  renderMcpListConversations,
  renderMcpNotify,
  renderMcpSendMessage,
  renderMcpSessionLifecycle,
  renderPlanMode,
} from './tool-cases-mcp'
import { renderMcpSpawnSession } from './tool-cases-mcp-spawn'
import {
  renderCronCreate,
  renderCronDelete,
  renderCronList,
  renderMonitor,
  renderNotebookEdit,
  renderScheduleWakeup,
  renderSendMessage,
  renderSkill,
  renderTeam,
} from './tool-cases-misc'
import { renderGlobGrep, renderWebFetch, renderWebSearch } from './tool-cases-search'
import { renderTaskCreate, renderTaskMisc, renderTaskUpdate, renderTodoWrite } from './tool-cases-tasks'

function dispatchToolCase(name: string, ctx: ToolCaseInput): ToolCaseResult {
  switch (name) {
    case 'Bash':
      return renderBash(ctx)
    case 'REPL':
      return renderRepl(ctx)
    case 'Read':
      return renderRead(ctx)
    case 'Edit':
      return renderEdit(ctx)
    case 'Write':
      return renderWrite(ctx)
    case 'WebSearch':
      return renderWebSearch(ctx)
    case 'WebFetch':
      return renderWebFetch(ctx)
    case 'Glob':
    case 'Grep':
      return renderGlobGrep(name, ctx)
    case 'Task':
    case 'Agent':
      return renderAgentTask(name, ctx)
    case 'AskUserQuestion':
      return renderAskUserQuestion(ctx)
    case 'ToolSearch':
      return { summary: ctx.input.query as string, details: null }
    case 'TaskCreate':
      return renderTaskCreate(ctx)
    case 'TaskUpdate':
      return renderTaskUpdate(ctx)
    case 'TaskOutput':
    case 'TaskList':
    case 'TaskStop':
      return renderTaskMisc(ctx)
    case 'TodoWrite':
      return renderTodoWrite(ctx)
    case 'Skill':
      return renderSkill(ctx)
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return renderPlanMode(name, ctx)
    case 'NotebookEdit':
      return renderNotebookEdit(ctx)
    case 'SendMessage':
      return renderSendMessage(ctx)
    case 'TeamCreate':
    case 'TeamDelete':
      return renderTeam(ctx)
    case 'CronCreate':
      return renderCronCreate(ctx)
    case 'CronList':
      return renderCronList(ctx)
    case 'CronDelete':
      return renderCronDelete(ctx)
    case 'ScheduleWakeup':
      return renderScheduleWakeup(ctx)
    case 'Monitor':
      return renderMonitor(ctx)
    case 'mcp__rclaude__send_message':
      return renderMcpSendMessage(ctx)
    case 'mcp__rclaude__revive_session':
    case 'mcp__rclaude__terminate_session':
    case 'mcp__rclaude__quit_session':
      return renderMcpSessionLifecycle(name, ctx)
    case 'mcp__rclaude__list_conversations':
      return renderMcpListConversations(ctx)
    case 'mcp__rclaude__notify':
      return renderMcpNotify(ctx)
    case 'mcp__rclaude__spawn_session':
      return renderMcpSpawnSession(ctx)
    case 'mcp__rclaude__control_session':
      return renderMcpControlSession(ctx)
    case 'mcp__rclaude__configure_session':
      return renderMcpConfigureSession(ctx)
    case 'mcp__rclaude__dialog':
      return renderMcpDialog(ctx)
    case 'mcp__gmail__search_emails':
      return renderGmailSearchEmails(ctx)
    case 'mcp__gmail__get_thread':
      return renderGmailGetThread(ctx)
    case 'mcp__gmail__draft_email':
      return renderGmailDraftEmail(ctx)
    case 'mcp__gmail__modify_email':
    case 'mcp__gmail__batch_modify_emails':
    case 'mcp__gmail__create_label':
    case 'mcp__gmail__update_label':
    case 'mcp__gmail__get_or_create_label':
      return renderGmailLabelOp(ctx)
    case 'mcp__gmail__list_email_labels':
      return renderGmailListLabels(ctx)
    case 'mcp__gmail__list_inbox_threads':
    case 'mcp__gmail__get_inbox_with_threads':
      return renderGmailInbox(name, ctx)
    case 'mcp__gmail__send_email':
    case 'mcp__gmail__reply_all':
      return renderGmailSend(ctx)
    default:
      if (name.startsWith('mcp__')) {
        return renderMcpDefault(name, ctx)
      }
      return { summary: JSON.stringify(ctx.input).slice(0, 60), details: null }
  }
}

function renderErrorFallback(result: string): ReactNode {
  const errorMatch = result.match(/<tool_use_error>([\s\S]*?)<\/tool_use_error>/)
  const errorMsg = errorMatch ? errorMatch[1].trim() : result
  return (
    <div className="text-[10px] text-red-400/90 bg-red-400/5 border border-red-400/20 rounded px-2.5 py-1.5 font-mono">
      {errorMsg}
    </div>
  )
}

function renderPersistedOutput(result: string): ReactNode | null {
  const persistedMatch = result.match(/<persisted-output>\s*([\s\S]*?)\s*<\/persisted-output>/)
  if (!persistedMatch) return null
  const inner = persistedMatch[1]
  const sizeMatch = inner.match(/Output too large \(([^)]+)\)/)
  const pathMatch = inner.match(/Full output saved to: (.+?)(?:\n|$)/)
  const previewMatch = inner.match(/Preview \(first [^)]+\):\s*([\s\S]*)/)
  const size = sizeMatch?.[1] || 'large'
  const path = pathMatch?.[1]?.trim()
  return (
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
  const expandAllStore = useConversationsStore(state => state.expandAll)
  const expandAll = expandAllProp ?? expandAllStore
  const displayKey = name.startsWith('mcp__') ? 'MCP' : name
  const toolDefaultOpen = useConversationsStore(
    state => resolveToolDisplay(state.controlPanelPrefs, displayKey as ToolDisplayKey).defaultOpen,
  )
  const sessionPath = useConversationsStore(s => {
    if (s.controlPanelPrefs.sanitizePaths === false) return undefined
    const sid = s.selectedConversationId
    const session = sid ? s.sessionsById[sid] : undefined
    return session ? projectPath(session.project) : undefined
  })

  const ctx: ToolCaseInput = {
    input,
    result,
    toolUseResult,
    isError,
    sessionPath,
    expandAll,
    subagents,
    planContent,
    planPath,
  }

  const caseResult = dispatchToolCase(name, ctx)
  let { summary, details } = caseResult
  const { inlineContent, agentBadge, matchedAgentId } = caseResult

  if (isError && !details && result) {
    details = renderErrorFallback(result)
  }

  if (!isError && !details && result) {
    details = renderPersistedOutput(result)
  }

  const { Icon } = style
  const displayName = name.startsWith('mcp__')
    ? name.split('__').slice(2).join('/') || name.split('__')[1] || name
    : name

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
