import type { ReactNode } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { cn, truncate } from '@/lib/utils'
import type { ToolCaseInput, ToolCaseResult } from './tool-case-types'

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
  const created = result.match(/created successfully:\s*(.+)/)
  if (created) return created[1].trim()
  return ''
}

function parseTaskIdFromResult(result: string | undefined): string {
  if (!result) return ''
  const match = result.match(/Task #(\d+)/)
  return match ? match[1] : ''
}

function lookupTaskSubject(taskId: string | undefined): string {
  if (!taskId) return ''
  const state = useConversationsStore.getState()
  const sid = state.selectedConversationId
  if (!sid) return ''
  const conversation = sid ? state.conversationsById[sid] : undefined
  if (!conversation) return ''
  return (
    conversation.activeTasks?.find(t => t.id === taskId)?.subject ||
    conversation.pendingTasks?.find(t => t.id === taskId)?.subject ||
    conversation.archivedTasks?.find(t => t.id === taskId)?.subject ||
    ''
  )
}

function createTaskSummary(
  taskId: string | undefined,
  status: string | undefined,
  subject: string,
  desc: string | undefined,
): { summary: ReactNode; details: ReactNode } {
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

export function renderTaskCreate({ input, result }: ToolCaseInput): ToolCaseResult {
  const taskId = parseTaskIdFromResult(result)
  return createTaskSummary(taskId, 'pending', (input.subject as string) || '', input.description as string)
}

export function renderTaskUpdate({ input, result }: ToolCaseInput): ToolCaseResult {
  const taskId = (input.taskId || input.id || input.task_id) as string | undefined
  const status = (input.status || input.state) as string | undefined
  const subject = (input.subject as string) || parseTaskSubjectFromResult(result) || lookupTaskSubject(taskId)
  return createTaskSummary(taskId, status, subject, input.description as string)
}

export function renderTaskMisc({ input, result }: ToolCaseInput): ToolCaseResult {
  const taskId = (input.taskId || input.id || input.task_id) as string
  const summary = taskId ? `#${taskId}` : ''
  let details: ReactNode = null
  if (result) {
    details = <pre className="text-[10px] text-muted-foreground overflow-x-auto">{truncate(result, 500)}</pre>
  }
  return { summary, details }
}

export function renderTodoWrite({ input }: ToolCaseInput): ToolCaseResult {
  const todos = input.todos as Array<{ content: string; activeForm?: string; status?: string }>
  let summary: ReactNode = ''
  let details: ReactNode = null
  if (todos?.length) {
    const total = todos.length
    const completed = todos.filter(t => t.status === 'completed').length
    const inProgress = todos.find(t => t.status === 'in_progress')
    const nextPending = todos.find(t => !t.status || t.status === 'pending')
    const allDone = completed === total
    const someStarted = completed > 0 || !!inProgress

    let label: ReactNode
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
  return { summary, details }
}
