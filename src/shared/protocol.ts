/**
 * WebSocket Protocol Types
 * Defines the message format between wrapper and concentrator
 */

// Wrapper -> Concentrator messages
export interface HookEvent {
  type: 'hook'
  sessionId: string
  hookEvent: HookEventType
  timestamp: number
  data: HookEventData
}

// Capabilities that rclaude declares on connect
export type WrapperCapability = 'terminal'

export interface SessionMeta {
  type: 'meta'
  sessionId: string
  wrapperId: string // unique per rclaude instance (multiple wrappers can share a sessionId via --continue)
  cwd: string
  startedAt: number
  model?: string
  args?: string[]
  capabilities?: WrapperCapability[]
  version?: string
  buildTime?: string
}

export interface SessionEnd {
  type: 'end'
  sessionId: string
  reason: string
  endedAt: number
}

export interface Heartbeat {
  type: 'heartbeat'
  sessionId: string
  timestamp: number
}

// Terminal streaming messages (browser <-> concentrator <-> rclaude)
// All terminal messages route by wrapperId (physical rclaude instance + PTY)
export interface TerminalAttach {
  type: 'terminal_attach'
  wrapperId: string
  cols: number
  rows: number
}

export interface TerminalDetach {
  type: 'terminal_detach'
  wrapperId: string
}

export interface TerminalData {
  type: 'terminal_data'
  wrapperId: string
  data: string
}

export interface TerminalResize {
  type: 'terminal_resize'
  wrapperId: string
  cols: number
  rows: number
}

export interface TerminalError {
  type: 'terminal_error'
  wrapperId: string
  error: string
}

export interface DiagLog {
  type: 'diag'
  sessionId: string
  entries: Array<{ t: number; type: string; msg: string; args?: unknown }>
}

export interface TasksUpdate {
  type: 'tasks_update'
  sessionId: string
  tasks: TaskInfo[]
}

// Transcript streaming: rclaude -> concentrator
export interface TranscriptEntries {
  type: 'transcript_entries'
  sessionId: string
  entries: TranscriptEntry[]
  isInitial: boolean // true for initial batch on connect, false for incremental
}

export interface SubagentTranscript {
  type: 'subagent_transcript'
  sessionId: string
  agentId: string
  entries: TranscriptEntry[]
  isInitial: boolean
}

export interface FileResponse {
  type: 'file_response'
  requestId: string
  data?: string // base64
  mediaType?: string
  error?: string
}

// A single JSONL transcript entry (opaque to protocol - the concentrator just stores/forwards it)
export type TranscriptEntry = Record<string, unknown>

export type WrapperMessage =
  | HookEvent
  | SessionMeta
  | SessionEnd
  | Heartbeat
  | TerminalData
  | TerminalError
  | TasksUpdate
  | TranscriptEntries
  | SubagentTranscript
  | FileResponse

// Concentrator -> Wrapper messages
export interface Ack {
  type: 'ack'
  eventId: string
}

export interface ConcentratorError {
  type: 'error'
  message: string
}

export interface SendInput {
  type: 'input'
  sessionId: string
  input: string
}

// Transcript streaming: concentrator -> rclaude
export interface TranscriptRequest {
  type: 'transcript_request'
  sessionId: string
  limit?: number
}

export interface SubagentTranscriptRequest {
  type: 'subagent_transcript_request'
  sessionId: string
  agentId: string
  limit?: number
}

export interface FileRequest {
  type: 'file_request'
  requestId: string
  path: string
}

export type ConcentratorMessage =
  | Ack
  | ConcentratorError
  | SendInput
  | TerminalAttach
  | TerminalDetach
  | TerminalData
  | TerminalResize
  | TranscriptRequest
  | SubagentTranscriptRequest
  | FileRequest

// Hook event types from Claude Code
export type HookEventType =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'Stop'
  | 'SessionEnd'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest'
  | 'TeammateIdle'
  | 'TaskCompleted'
  | 'InstructionsLoaded'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'Setup'

// Hook event data structures (based on Claude Code hook system)
export interface SessionStartData {
  session_id: string
  cwd: string
  model?: string
  source?: string
}

export interface UserPromptSubmitData {
  session_id: string
  prompt: string
}

export interface PreToolUseData {
  session_id: string
  tool_name: string
  tool_input: Record<string, unknown>
}

export interface PostToolUseData {
  session_id: string
  tool_name: string
  tool_input: Record<string, unknown>
  tool_response?: string
}

export interface PostToolUseFailureData {
  session_id: string
  tool_name: string
  tool_input: Record<string, unknown>
  error: string
}

export interface NotificationData {
  session_id: string
  message: string
  notification_type?: string
}

export interface StopData {
  session_id: string
  reason?: string
}

export interface SessionEndData {
  session_id: string
  reason?: string
}

export interface SubagentStartData {
  session_id: string
  agent_id: string
  agent_type: string
}

export interface SubagentStopData {
  session_id: string
  agent_id: string
  transcript?: string
  agent_type?: string
  agent_transcript_path?: string
  stop_hook_active?: boolean
}

export interface TeammateIdleData {
  session_id: string
  agent_id: string
  agent_name?: string
  team_name?: string
}

export interface TaskCompletedData {
  session_id: string
  task_id: string
  task_subject?: string
  owner?: string
  team_name?: string
}

export interface SetupData {
  session_id: string
  [key: string]: unknown
}

export interface PreCompactData {
  session_id: string
  trigger: string
}

export interface PermissionRequestData {
  session_id: string
  tool: string
  suggestions?: string[]
}

export type HookEventData =
  | SessionStartData
  | UserPromptSubmitData
  | PreToolUseData
  | PostToolUseData
  | PostToolUseFailureData
  | NotificationData
  | StopData
  | SessionEndData
  | SubagentStartData
  | SubagentStopData
  | PreCompactData
  | PermissionRequestData
  | TeammateIdleData
  | TaskCompletedData
  | SetupData
  | Record<string, unknown>

// Sub-agent tracking
export interface SubagentInfo {
  agentId: string
  agentType: string
  description?: string
  startedAt: number
  stoppedAt?: number
  status: 'running' | 'stopped'
  transcriptPath?: string
  events: HookEvent[]
}

// Team tracking
export interface TeamInfo {
  teamName: string
  role: 'lead' | 'teammate'
}

export interface TeammateInfo {
  agentId: string
  name: string
  teamName: string
  status: 'idle' | 'working' | 'stopped'
  startedAt: number
  stoppedAt?: number
  currentTaskId?: string
  currentTaskSubject?: string
  completedTaskCount: number
}

// Background command tracking
export interface BgTaskInfo {
  taskId: string
  command: string
  description: string
  startedAt: number
  completedAt?: number
  status: 'running' | 'completed' | 'killed'
}

// Session state in concentrator
export interface TaskInfo {
  id: string
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  blockedBy?: string[]
  blocks?: string[]
  owner?: string
  updatedAt: number
}

export interface ArchivedTaskGroup {
  archivedAt: number
  tasks: TaskInfo[]
}

export interface Session {
  id: string
  cwd: string
  model?: string
  args?: string[]
  capabilities?: WrapperCapability[]
  transcriptPath?: string
  version?: string
  buildTime?: string
  startedAt: number
  lastActivity: number
  status: 'active' | 'idle' | 'ended'
  compacting?: boolean
  compactedAt?: number
  events: HookEvent[]
  subagents: SubagentInfo[]
  tasks: TaskInfo[]
  archivedTasks: ArchivedTaskGroup[]
  bgTasks: BgTaskInfo[]
  teammates: TeammateInfo[]
  team?: TeamInfo
  diagLog: Array<{ t: number; type: string; msg: string; args?: unknown }>
  tokenUsage?: { input: number; cacheCreation: number; cacheRead: number; output: number }
  stats: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheCreation: number
    totalCacheRead: number
    turnCount: number
    toolCallCount: number
    compactionCount: number
  }
  gitBranch?: string
}

// Agent -> Concentrator messages
export interface AgentIdentify {
  type: 'agent_identify'
}

export interface ReviveResult {
  type: 'revive_result'
  sessionId: string
  wrapperId?: string // echoes the pre-assigned wrapperId
  success: boolean
  error?: string
  tmuxSession?: string
  continued: boolean // true if --continue worked, false if fresh session
}

export type AgentMessage = AgentIdentify | ReviveResult

// Concentrator -> Agent messages
export interface ReviveSession {
  type: 'revive'
  sessionId: string
  cwd: string
  wrapperId: string // pre-assigned wrapperId so concentrator can correlate the incoming connection
}

export interface AgentQuit {
  type: 'quit'
  reason?: string
}

export interface AgentReject {
  type: 'agent_reject'
  reason: string
}

export type ConcentratorAgentMessage = ReviveSession | AgentQuit | AgentReject

// Dashboard broadcast: agent status
export interface AgentStatus {
  type: 'agent_status'
  connected: boolean
}

// Configuration
export const DEFAULT_CONCENTRATOR_URL = 'ws://localhost:9999'
export const DEFAULT_CONCENTRATOR_PORT = 9999
export const HEARTBEAT_INTERVAL_MS = 30000
// Idle timeout is now configured via global settings (idleTimeoutMinutes)
// Server evaluates idle status - clients trust session.status
