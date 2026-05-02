// Re-export shared types (single source of truth)
export type {
  AgentHostCapability,
  ArchivedTaskGroup,
  BgTaskInfo as BgTaskSummary,
  ExtraUsage,
  FileInfo,
  HookEventType,
  LaunchConfig,
  MonitorInfo,
  ProjectSettings,
  SubagentInfo,
  TaskInfo,
  TeamInfo,
  UsageUpdate,
  UsageWindow,
} from '@shared/protocol'

import type { AgentHostCapability, BgTaskInfo as BgTaskSummary, ProjectSettings } from '@shared/protocol'

// Re-export HookEvent but with a looser data type for generic property access
// (dashboard does e.data?.model, e.data?.tool_name, etc.)
export type { HookEvent } from '@shared/protocol'

/** Check if a session can open a terminal. Requires explicit terminal capability. */
export function canTerminal(s: Session): boolean {
  return s.status !== 'ended' && !!s.capabilities?.includes('terminal')
}

/** Check if a session supports raw JSON stream viewing. */
export function canJsonStream(s: Session): boolean {
  return s.status !== 'ended' && !!s.capabilities?.includes('json_stream')
}

// Client-side session model (derived from SessionSummary wire format with defaults applied)
export interface Session {
  id: string
  project: string
  model?: string
  capabilities?: AgentHostCapability[]
  version?: string
  buildTime?: string
  ccSessionIds?: string[]
  status: 'active' | 'idle' | 'ended' | 'starting' | 'booting'
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
    tokenUsage?: { totalInput: number; totalOutput: number; cacheCreation: number; cacheRead: number }
  }>
  taskCount: number
  pendingTaskCount: number
  activeTasks: Array<{ id: string; subject: string }>
  pendingTasks: Array<{ id: string; subject: string }>
  archivedTaskCount?: number
  archivedTasks?: Array<{ id: string; subject: string }>
  runningBgTaskCount: number
  bgTasks: BgTaskSummary[]
  monitors?: import('@shared/protocol').MonitorInfo[]
  runningMonitorCount?: number
  teammates: Array<{
    name: string
    status: 'idle' | 'working' | 'stopped'
    currentTaskSubject?: string
    completedTaskCount: number
  }>
  team?: { teamName: string; role: 'lead' | 'teammate' }
  effortLevel?: string
  permissionMode?: string
  lastError?: { stopReason?: string; errorType?: string; errorMessage?: string; timestamp: number }
  rateLimit?: { retryAfterMs: number; message: string; timestamp: number }
  planMode?: boolean
  pendingAttention?: {
    type: 'permission' | 'elicitation' | 'ask' | 'dialog' | 'plan_approval'
    toolName?: string
    filePath?: string
    question?: string
    timestamp: number
  }
  hasNotification?: boolean
  tokenUsage?: { input: number; cacheCreation: number; cacheRead: number; output: number }
  contextWindow?: number
  cacheTtl?: '5m' | '1h'
  lastTurnEndedAt?: number
  summary?: string
  title?: string
  description?: string
  agentName?: string
  prLinks?: Array<{ prNumber: number; prUrl: string; prRepository: string; timestamp: string }>
  linkedProjects?: Array<{ project: string; name: string }>
  stats?: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheCreation: number
    totalCacheWrite5m?: number
    totalCacheWrite1h?: number
    totalCacheRead: number
    turnCount: number
    toolCallCount: number
    compactionCount: number
    totalCostUsd?: number
    linesAdded: number
    linesRemoved: number
    totalApiDurationMs: number
  }
  costTimeline?: Array<{ t: number; cost: number }>
  claudeVersion?: string
  claudeAuth?: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string }
  gitBranch?: string
  spinnerVerbs?: string[]
  autocompactPct?: number
  adHocTaskId?: string
  adHocWorktree?: string
  launchConfig?: import('@shared/protocol').LaunchConfig
  resultText?: string
  recap?: { content: string; timestamp: number }
  recapFresh?: boolean
  lastEvent?: {
    hookEvent: string
    timestamp: number
  }
  hostSentinelId?: string
  hostSentinelAlias?: string
}

// Project order tree types -- each leaf is a project keyed by project URI
// (e.g. "claude:///Users/jonas/projects/foo"). Legacy entries may still use
// "cwd:<path>" format; consumers should handle both (legacy compat).
export interface ProjectOrderGroup {
  id: string
  type: 'group'
  name: string
  children: ProjectOrderNode[]
  isOpen?: boolean
}

interface ProjectOrderProject {
  id: string // project URI (e.g. "claude:///path") or legacy "cwd:<path>" (compat)
  type: 'project'
}

export type ProjectOrderNode = ProjectOrderGroup | ProjectOrderProject

export interface ProjectOrder {
  tree: ProjectOrderNode[]
}

// Nested groups aren't supported by the renderer. Flatten any group nested inside
// another group by hoisting it to root and promoting its own children. Idempotent.
export function flattenProjectOrderTree(tree: ProjectOrderNode[]): ProjectOrderNode[] {
  const roots: ProjectOrderNode[] = []
  const nestedGroups: ProjectOrderGroup[] = []
  for (const node of tree) {
    if (node.type === 'group') {
      const leaves: ProjectOrderNode[] = []
      for (const child of node.children) {
        if (child.type === 'group') nestedGroups.push(child)
        else leaves.push(child)
      }
      roots.push({ ...node, children: leaves })
    } else {
      roots.push(node)
    }
  }
  for (const g of nestedGroups) {
    const leaves: ProjectOrderNode[] = []
    for (const child of g.children) {
      if (child.type === 'group') nestedGroups.push(child)
      else leaves.push(child)
    }
    roots.push({ ...g, children: leaves })
  }
  return roots
}

export function projectOrderTreesEqual(a: ProjectOrderNode[], b: ProjectOrderNode[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface TranscriptImage {
  hash: string
  ext: string
  url: string
  originalPath: string
}

// Re-export all typed entry variants from shared protocol
export type {
  TranscriptAssistantEntry,
  TranscriptAssistantMessage,
  TranscriptCompactingEntry,
  TranscriptContentBlock,
  TranscriptEntry,
  TranscriptProgressEntry,
  TranscriptQueueEntry,
  TranscriptSystemEntry,
  TranscriptUserEntry,
} from '@shared/protocol'

// Frontend-specific rendering extensions on transcript entries.
// The JSONL entries are augmented by the broker/dashboard with
// images and structured tool results before rendering.
export interface TranscriptToolUseResult {
  filePath?: string
  oldString?: string
  newString?: string
  structuredPatch?: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }>
}

/** Project settings keyed by project URI (e.g. "claude:///Users/jonas/projects/foo") */
export type ProjectSettingsMap = Record<string, ProjectSettings>

/**
 * Extract the filesystem path from a project URI.
 * e.g. "claude:///Users/jonas/foo" -> "/Users/jonas/foo"
 * Duplicated from src/shared/project-uri.ts since web bundle can't import from src/shared/.
 */
export function projectPath(uri: string): string {
  if (!uri) return ''
  try {
    const url = new URL(uri)
    return decodeURIComponent(url.pathname) || '/'
  } catch {
    return uri
  }
}

/**
 * Convert a filesystem path to a project URI.
 * e.g. "/Users/jonas/foo" -> "claude:///Users/jonas/foo"
 * Duplicated from src/shared/project-uri.ts since web bundle can't import from src/shared/.
 */
export function cwdToProjectUri(cwd: string): string {
  return `claude://${cwd}`
}

/**
 * Extract a human-readable label from a project URI.
 * Returns the last path segment (e.g. "claude:///Users/jonas/foo" -> "foo").
 * Duplicated from src/shared/project-uri.ts since web bundle can't import from src/shared/.
 */
export function extractProjectLabel(uri: string): string {
  if (!uri || uri === '*') return uri || ''
  try {
    const url = new URL(uri)
    const segments = decodeURIComponent(url.pathname).split('/').filter(Boolean)
    return segments.length > 0 ? segments[segments.length - 1] : uri
  } catch {
    // Legacy "cwd:<path>" format or plain path
    const path = uri.startsWith('cwd:') ? uri.slice(4) : uri
    const segments = path.split('/').filter(Boolean)
    return segments.length > 0 ? segments[segments.length - 1] : uri
  }
}
