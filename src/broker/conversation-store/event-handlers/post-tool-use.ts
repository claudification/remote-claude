import type { Conversation, HookEventOf } from '../../../shared/protocol'

/**
 * PostToolUse runs three pieces of bookkeeping that all key off the same
 * tool_name discriminant: subagent TaskStop correlation (kills a running
 * subagent that didn't get its own SubagentStop), Bash backgrounding
 * (registers a new bgTask when the tool response carries a background
 * task id), and bg-task completion detection (TaskOutput / TaskStop tool
 * names mark the corresponding bgTask done/killed).
 */
export function handlePostToolUseTracking(session: Conversation, event: HookEventOf<'PostToolUse'>): void {
  const { tool_name: toolName } = event.data

  if (toolName === 'TaskStop') correlateTaskStopWithSubagent(session, event)
  if (toolName === 'Bash') registerBgTaskFromBash(session, event)
  if (toolName === 'TaskOutput' || toolName === 'TaskStop') {
    completeBgTask(session, event, toolName)
  }
}

/**
 * TaskStop tool kills a background subagent that didn't fire SubagentStop
 * on its own. task_id IS the agent_id.
 */
function correlateTaskStopWithSubagent(session: Conversation, event: HookEventOf<'PostToolUse'>): void {
  const taskId = event.data.tool_input.task_id
  if (typeof taskId !== 'string') return
  const agent = session.subagents.find(a => a.agentId === taskId && a.status === 'running')
  if (!agent) return
  agent.status = 'stopped'
  agent.stoppedAt = event.timestamp
}

/**
 * Bash with a backgroundTaskId in the response (or user-triggered Ctrl+B
 * with the legacy "with ID: xxx" string format) registers a new bgTask.
 */
function registerBgTaskFromBash(session: Conversation, event: HookEventOf<'PostToolUse'>): void {
  const responseObj = event.data.tool_response
  const bgTaskId =
    typeof responseObj === 'object' && responseObj !== null
      ? (responseObj as Record<string, unknown>).backgroundTaskId
      : undefined

  let taskId: string | undefined
  if (typeof bgTaskId === 'string') {
    taskId = bgTaskId
  } else {
    const responseText = typeof responseObj === 'string' ? responseObj : ''
    taskId = responseText.match(/with ID: (\S+)/)?.[1]
  }
  if (!taskId) return

  const input = event.data.tool_input
  const command = typeof input.command === 'string' ? input.command : ''
  const description = typeof input.description === 'string' ? input.description : ''
  session.bgTasks.push({
    taskId,
    command: command.slice(0, 100),
    description,
    startedAt: event.timestamp,
    status: 'running',
  })
}

/**
 * TaskOutput / TaskStop tool calls mark the matching running bgTask done
 * (TaskOutput = completed, TaskStop = killed). No-op when the task is
 * already in a terminal state or unknown.
 */
function completeBgTask(
  session: Conversation,
  event: HookEventOf<'PostToolUse'>,
  toolName: 'TaskOutput' | 'TaskStop',
): void {
  const input = event.data.tool_input
  const rawTaskId = input.task_id ?? input.taskId
  if (typeof rawTaskId !== 'string') return
  const bgTask = session.bgTasks.find(t => t.taskId === rawTaskId)
  if (!bgTask || bgTask.status !== 'running') return
  bgTask.completedAt = event.timestamp
  bgTask.status = toolName === 'TaskStop' ? 'killed' : 'completed'
}
