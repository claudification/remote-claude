/**
 * Monitor task tracking for the stream-json backend.
 * Tracks non-agent background tasks (Monitor tool) and correlates
 * task_started events with cached tool_use inputs.
 */

export interface MonitorInfo {
  toolUseId: string
  description: string
  command?: string
  persistent?: boolean
  timeoutMs?: number
  eventCount: number
}

export interface MonitorInput {
  command?: string
  persistent?: boolean
  timeoutMs?: number
  description?: string
}

export function deriveMonitorOutputPath(command: string | undefined, monitorTaskId: string): string | undefined {
  if (!command) return undefined
  const match = command.match(/(\S+\/tasks\/)[\w-]+\.output/)
  if (match) return `${match[1]}${monitorTaskId}.output`
  return undefined
}

export interface MonitorTracker {
  agentTaskToToolUse: Map<string, string>
  monitorTasks: Map<string, MonitorInfo>
  pendingMonitorInputs: Map<string, MonitorInput>
}

export function createMonitorTracker(): MonitorTracker {
  return {
    agentTaskToToolUse: new Map(),
    monitorTasks: new Map(),
    pendingMonitorInputs: new Map(),
  }
}
