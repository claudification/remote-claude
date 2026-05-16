import type { ReactNode } from 'react'
import { canonicalizeToolUse } from '@/lib/legacy-to-canonical'
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
  renderMcpConfigureConversation,
  renderMcpControlConversation,
  renderMcpConversationLifecycle,
  renderMcpDefault,
  renderMcpDialog,
  renderMcpListConversations,
  renderMcpNotify,
  renderMcpSendMessage,
  renderPlanMode,
} from './tool-cases-mcp'
import { renderMcpSpawnConversation } from './tool-cases-mcp-spawn'
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

type ToolHandler = (ctx: ToolCaseInput) => ToolCaseResult
type ToolHandlerWithName = (name: string, ctx: ToolCaseInput) => ToolCaseResult

/** Detect whether `current` already carries the canonical shape. We compare
 *  the keys of `canonical` against `current`: if every canonical key is
 *  present in current, no normalization is needed. */
function looksCanonical(current: Record<string, unknown>, canonical: Record<string, unknown>): boolean {
  for (const key of Object.keys(canonical)) {
    if (!(key in current)) return false
  }
  return true
}

/** Canonical-kind dispatch table. The agent host's dialect translator
 *  populates `block.kind` for every new tool block; old persisted entries
 *  get a synthesized kind via the legacy shim at the dispatcher entry.
 *  Either way, by the time we look up a renderer, every tool has a kind. */
const kindHandlers: Record<string, ToolHandler> = {
  'shell.exec': renderBash,
  'repl.exec': renderRepl,
  'file.read': renderRead,
  'file.edit': renderEdit,
  'file.write': renderWrite,
  'web.search': renderWebSearch,
  'web.fetch': renderWebFetch,
  'todo.write': renderTodoWrite,
  'notebook.edit': renderNotebookEdit,
}

const kindHandlersWithName: Record<string, ToolHandlerWithName> = {
  'file.glob': renderGlobGrep,
  'text.search': renderGlobGrep,
  'task.spawn': renderAgentTask,
}

const toolHandlers: Record<string, ToolHandler> = {
  Bash: renderBash,
  REPL: renderRepl,
  Read: renderRead,
  Edit: renderEdit,
  Write: renderWrite,
  WebSearch: renderWebSearch,
  WebFetch: renderWebFetch,
  AskUserQuestion: renderAskUserQuestion,
  ToolSearch: ctx => ({ summary: ctx.input.query as string, details: null }),
  TaskCreate: renderTaskCreate,
  TaskUpdate: renderTaskUpdate,
  TaskOutput: renderTaskMisc,
  TaskList: renderTaskMisc,
  TaskStop: renderTaskMisc,
  TodoWrite: renderTodoWrite,
  Skill: renderSkill,
  NotebookEdit: renderNotebookEdit,
  SendMessage: renderSendMessage,
  TeamCreate: renderTeam,
  TeamDelete: renderTeam,
  CronCreate: renderCronCreate,
  CronList: renderCronList,
  CronDelete: renderCronDelete,
  ScheduleWakeup: renderScheduleWakeup,
  Monitor: renderMonitor,
  mcp__rclaude__send_message: renderMcpSendMessage,
  mcp__rclaude__list_conversations: renderMcpListConversations,
  mcp__rclaude__notify: renderMcpNotify,
  mcp__rclaude__spawn_conversation: renderMcpSpawnConversation,
  mcp__rclaude__control_conversation: renderMcpControlConversation,
  mcp__rclaude__configure_conversation: renderMcpConfigureConversation,
  mcp__rclaude__dialog: renderMcpDialog,
  mcp__gmail__search_emails: renderGmailSearchEmails,
  mcp__gmail__get_thread: renderGmailGetThread,
  mcp__gmail__draft_email: renderGmailDraftEmail,
  mcp__gmail__modify_email: renderGmailLabelOp,
  mcp__gmail__batch_modify_emails: renderGmailLabelOp,
  mcp__gmail__create_label: renderGmailLabelOp,
  mcp__gmail__update_label: renderGmailLabelOp,
  mcp__gmail__get_or_create_label: renderGmailLabelOp,
  mcp__gmail__list_email_labels: renderGmailListLabels,
  mcp__gmail__send_email: renderGmailSend,
  mcp__gmail__reply_all: renderGmailSend,
}

const namePassthroughHandlers: Record<string, ToolHandlerWithName> = {
  Glob: renderGlobGrep,
  Grep: renderGlobGrep,
  Task: renderAgentTask,
  Agent: renderAgentTask,
  EnterPlanMode: renderPlanMode,
  ExitPlanMode: renderPlanMode,
  mcp__rclaude__revive_conversation: renderMcpConversationLifecycle,
  mcp__rclaude__terminate_conversation: renderMcpConversationLifecycle,
  mcp__rclaude__exit_conversation: renderMcpConversationLifecycle,
  mcp__gmail__list_inbox_threads: renderGmailInbox,
  mcp__gmail__get_inbox_with_threads: renderGmailInbox,
}

export function dispatchToolCase(name: string, ctx: ToolCaseInput, kind?: string): ToolCaseResult {
  // CANONICAL DISPATCH: derive the kind AND ensure ctx.input carries the
  // canonical shape. Agent-host translators normalize at the wire boundary
  // for new entries, but old persisted entries (and direct test callers)
  // can land here with legacy keys still on input. Normalize defensively.
  const { kind: derivedKind, canonicalInput } = canonicalizeToolUse(name, ctx.input)
  const resolvedKind = kind ?? derivedKind
  if (resolvedKind !== 'agent.unknown' && !looksCanonical(ctx.input, canonicalInput)) {
    ctx = { ...ctx, input: canonicalInput }
  }
  const kindHandler = kindHandlers[resolvedKind]
  if (kindHandler) return kindHandler(ctx)
  const kindHandlerNamed = kindHandlersWithName[resolvedKind]
  if (kindHandlerNamed) return kindHandlerNamed(name, ctx)
  if (resolvedKind.startsWith('mcp.')) {
    // Map back to the legacy mcp__server__tool form the existing MCP
    // renderers key on. e.g. mcp.claudewerk.notify -> mcp__claudewerk__notify.
    // Also try the brand-drift aliases mcp__rclaude__ / mcp__claudwerk__
    // so renderers registered under the legacy keys still match.
    const parts = resolvedKind.split('.')
    if (parts.length >= 3) {
      const tool = parts.slice(2).join('__')
      const candidates =
        parts[1] === 'claudewerk'
          ? [`mcp__claudewerk__${tool}`, `mcp__rclaude__${tool}`, `mcp__claudwerk__${tool}`]
          : [`mcp__${parts[1]}__${tool}`]
      for (const candidate of candidates) {
        const direct = toolHandlers[candidate]
        if (direct) return direct(ctx)
        const named = namePassthroughHandlers[candidate]
        if (named) return named(candidate, ctx)
      }
      return renderMcpDefault(candidates[0], ctx)
    }
  }

  // LEGACY FALLBACK -- handlers keyed by tool name. Catches everything the
  // canonical vocabulary doesn't yet cover (Skill, TaskCreate/Update,
  // CronCreate/List/Delete, Monitor, ScheduleWakeup, Team, SendMessage,
  // EnterPlanMode/ExitPlanMode, gmail/* MCP renderers keyed by long
  // mcp__gmail__* names, ...). ACP lowercase normalized to PascalCase
  // for the legacy table.
  const normalizedName = name.charAt(0).toUpperCase() + name.slice(1)
  const handler = toolHandlers[name] ?? toolHandlers[normalizedName]
  if (handler) return handler(ctx)

  const namedHandler = namePassthroughHandlers[name] ?? namePassthroughHandlers[normalizedName]
  if (namedHandler) return namedHandler(name, ctx)

  if (name.startsWith('mcp__')) return renderMcpDefault(name, ctx)

  return { summary: JSON.stringify(ctx.input).slice(0, 60), details: null }
}

export function renderErrorFallback(result: string): ReactNode {
  const errorMatch = result.match(/<tool_use_error>([\s\S]*?)<\/tool_use_error>/)
  const errorMsg = errorMatch ? errorMatch[1].trim() : result
  return (
    <div className="text-[10px] text-red-400/90 bg-red-400/5 border border-red-400/20 rounded px-2.5 py-1.5 font-mono">
      {errorMsg}
    </div>
  )
}

export function renderPersistedOutput(result: string): ReactNode | null {
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
