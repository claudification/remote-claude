// Re-export shared types (single source of truth)
export type {
  ArchivedTaskGroup,
  BgTaskInfo as BgTaskSummary,
  FileInfo,
  HookEventType,
  ProjectSettings,
  SubagentInfo,
  TaskInfo,
  TeamInfo,
  WrapperCapability,
} from '@shared/protocol'

import type { BgTaskInfo as BgTaskSummary, ProjectSettings, WrapperCapability } from '@shared/protocol'

// Re-export HookEvent but with a looser data type for generic property access
// (dashboard does e.data?.model, e.data?.tool_name, etc.)
export type { HookEvent } from '@shared/protocol'

/** Check if a session can open a terminal. Requires explicit terminal capability. */
export function canTerminal(s: Session): boolean {
  return (s.status === 'active' || s.status === 'idle') && !!s.capabilities?.includes('terminal')
}

// Client-side session model (derived from SessionSummary wire format with defaults applied)
export interface Session {
  id: string
  cwd: string
  model?: string
  capabilities?: WrapperCapability[]
  wrapperIds?: string[]
  status: 'active' | 'idle' | 'ended'
  compacting?: boolean
  compactedAt?: number
  startedAt: number
  lastActivity: number
  eventCount: number
  activeSubagentCount: number
  totalSubagentCount: number
  subagents: Array<{
    agentId: string
    agentType: string
    description?: string
    status: 'running' | 'stopped'
    startedAt: number
    stoppedAt?: number
    eventCount: number
  }>
  taskCount: number
  pendingTaskCount: number
  activeTasks: Array<{ id: string; subject: string }>
  pendingTasks: Array<{ id: string; subject: string }>
  archivedTaskCount?: number
  runningBgTaskCount: number
  bgTasks: BgTaskSummary[]
  teammates: Array<{
    name: string
    status: 'idle' | 'working' | 'stopped'
    currentTaskSubject?: string
    completedTaskCount: number
  }>
  team?: { teamName: string; role: 'lead' | 'teammate' }
  tokenUsage?: { input: number; cacheCreation: number; cacheRead: number; output: number }
  stats?: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheCreation: number
    totalCacheRead: number
    turnCount: number
    toolCallCount: number
    compactionCount: number
  }
  claudeVersion?: string
  gitBranch?: string
  lastEvent?: {
    hookEvent: string
    timestamp: number
  }
}

// Transcript types (web-specific rich types for rendering, not the opaque Record<string,unknown> from shared)
export interface TranscriptContentBlock {
  type: 'text' | 'tool_use' | 'thinking' | 'tool_result' | string
  text?: string
  thinking?: string
  signature?: string
  name?: string
  id?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | unknown
}

export interface TranscriptImage {
  hash: string
  ext: string
  url: string
  originalPath: string
}

export interface TranscriptEntry {
  type: string
  timestamp?: string
  message?: {
    role?: string
    content?: string | TranscriptContentBlock[]
  }
  data?: Record<string, unknown>
  toolUseResult?: {
    filePath?: string
    oldString?: string
    newString?: string
    structuredPatch?: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }>
  }
  images?: TranscriptImage[]
}

export type ProjectSettingsMap = Record<string, ProjectSettings>

export type WSMessage =
  | { type: 'sessions'; data: Session[] }
  | { type: 'session_update'; data: Session }
  | { type: 'event'; data: import('@shared/protocol').HookEvent }
