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
  claudeVersion?: string
}

export interface SessionEnd {
  type: 'end'
  sessionId: string
  reason: string
  endedAt: number
}

// Wrapper tells concentrator the Claude session ID changed (e.g. /clear)
// Same wrapper, same PTY, just a new Claude session -- re-key without ending
export interface SessionClear {
  type: 'session_clear'
  oldSessionId: string
  newSessionId: string
  wrapperId: string
  cwd: string
  model?: string
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

// Common fields present on most JSONL transcript entries
interface TranscriptEntryBase {
  type: string
  timestamp?: string
  uuid?: string
  parentUuid?: string | null
  isSidechain?: boolean
  sessionId?: string
  cwd?: string
  version?: string
  gitBranch?: string
  slug?: string
  userType?: string
}

export interface TranscriptAssistantMessage {
  model?: string
  id?: string
  type?: string
  role: 'assistant'
  content: unknown[]
  stop_reason?: string | null
  stop_sequence?: string | null
  usage?: {
    input_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    output_tokens: number
    service_tier?: string
    speed?: string
    server_tool_use?: Record<string, number>
    cache_creation?: Record<string, number>
    inference_geo?: string
    iterations?: unknown[]
  }
}

export interface TranscriptUserEntry extends TranscriptEntryBase {
  type: 'user'
  message?: {
    role: 'user'
    content: string | unknown[]
  }
  promptId?: string
  sourceToolAssistantUUID?: string
  sourceToolUseID?: string
  toolUseResult?: Record<string, unknown> | unknown[] | string
  isCompactSummary?: boolean
  isMeta?: boolean
  isVisibleInTranscriptOnly?: boolean
  imagePasteIds?: number[]
  permissionMode?: string
}

export interface TranscriptAssistantEntry extends TranscriptEntryBase {
  type: 'assistant'
  message?: TranscriptAssistantMessage
  requestId?: string
  isApiErrorMessage?: boolean
  error?: string
}

export interface TranscriptProgressEntry extends TranscriptEntryBase {
  type: 'progress'
  data?: Record<string, unknown>
  toolUseID?: string
  parentToolUseID?: string
}

export interface TranscriptSystemEntry extends TranscriptEntryBase {
  type: 'system'
  subtype?: 'stop_hook_summary' | 'turn_duration' | 'compact_boundary' | 'local_command' | string
  content?: string
  level?: string
  isMeta?: boolean
  stopReason?: string
  hookCount?: number
  hookErrors?: unknown[]
  hookInfos?: unknown[]
  preventedContinuation?: boolean
  hasOutput?: boolean
  durationMs?: number
  toolUseID?: string
  compactMetadata?: { trigger?: string; preTokens?: number }
}

export interface TranscriptQueueEntry extends TranscriptEntryBase {
  type: 'queue-operation'
  operation: 'enqueue' | 'remove' | 'dequeue' | 'popAll'
  content?: string
}

export interface TranscriptCompactingEntry extends TranscriptEntryBase {
  type: 'compacting' | 'compacted'
}

export interface TranscriptLastPromptEntry extends TranscriptEntryBase {
  type: 'last-prompt'
  lastPrompt?: string
}

export interface TranscriptPrLinkEntry extends TranscriptEntryBase {
  type: 'pr-link'
  prNumber?: number
  prRepository?: string
  prUrl?: string
}

export type TranscriptEntry =
  | TranscriptUserEntry
  | TranscriptAssistantEntry
  | TranscriptProgressEntry
  | TranscriptSystemEntry
  | TranscriptQueueEntry
  | TranscriptCompactingEntry
  | TranscriptLastPromptEntry
  | TranscriptPrLinkEntry
  | (TranscriptEntryBase & Record<string, unknown>) // fallback for unknown types

// Streaming output from background bash tasks (.output file watching)
export interface BgTaskOutput {
  type: 'bg_task_output'
  sessionId: string
  taskId: string
  data: string // new chunk of output
  done: boolean // true when task has completed and file is fully read
}

export interface WrapperNotify {
  type: 'notify'
  sessionId: string
  message: string
  title?: string
}

export type WrapperMessage =
  | HookEvent
  | SessionMeta
  | SessionEnd
  | SessionClear
  | Heartbeat
  | TerminalData
  | TerminalError
  | TasksUpdate
  | TranscriptEntries
  | SubagentTranscript
  | FileResponse
  | BgTaskOutput
  | WrapperNotify

// Concentrator -> Wrapper messages
export interface Ack {
  type: 'ack'
  eventId: string
  origins?: string[]
}

export interface ConcentratorError {
  type: 'error'
  message: string
}

export interface SendInput {
  type: 'input'
  sessionId: string
  input: string
  crDelay?: number // carriage return delay in ms (dashboard setting, optional)
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
  | 'PostCompact'
  | 'PermissionRequest'
  | 'TeammateIdle'
  | 'TaskCompleted'
  | 'InstructionsLoaded'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'Elicitation'
  | 'ElicitationResult'
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
  tokenUsage?: {
    totalInput: number
    totalOutput: number
    cacheCreation: number
    cacheRead: number
  }
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

// Per-project customization settings (label, icon, color, keyterms)
export interface ProjectSettings {
  label?: string
  icon?: string
  color?: string
  keyterms?: string[]
}

// File metadata for the file editor
export interface FileInfo {
  path: string
  name: string
  size: number
  modifiedAt: number
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
  claudeVersion?: string
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
  effortLevel?: string // 'speed' field from API usage: e.g. 'standard', maps to low/medium/high
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

export interface SpawnResult {
  type: 'spawn_result'
  requestId: string
  success: boolean
  error?: string
  tmuxSession?: string
  wrapperId?: string
}

export interface ListDirsResult {
  type: 'list_dirs_result'
  requestId: string
  dirs: string[]
  error?: string
}

export type AgentMessage = AgentIdentify | ReviveResult | SpawnResult | ListDirsResult

// Concentrator -> Agent messages
export interface ReviveSession {
  type: 'revive'
  sessionId: string
  cwd: string
  wrapperId: string // pre-assigned wrapperId so concentrator can correlate the incoming connection
}

export interface SpawnSession {
  type: 'spawn'
  requestId: string
  cwd: string
  wrapperId: string
}

export interface ListDirs {
  type: 'list_dirs'
  requestId: string
  path: string
}

export interface AgentQuit {
  type: 'quit'
  reason?: string
}

export interface AgentReject {
  type: 'agent_reject'
  reason: string
}

export type ConcentratorAgentMessage = ReviveSession | SpawnSession | ListDirs | AgentQuit | AgentReject

// Dashboard broadcast: agent status
export interface AgentStatus {
  type: 'agent_status'
  connected: boolean
}

// Session summary: concentrator -> dashboard wire format
export interface SessionSummary {
  id: string
  cwd: string
  model?: string
  capabilities?: WrapperCapability[]
  version?: string
  buildTime?: string
  claudeVersion?: string
  wrapperIds: string[]
  startedAt: number
  lastActivity: number
  status: Session['status']
  compacting?: boolean
  compactedAt?: number
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
  archivedTaskCount: number
  runningBgTaskCount: number
  bgTasks: Array<{
    taskId: string
    command: string
    description: string
    startedAt: number
    completedAt?: number
    status: 'running' | 'completed' | 'killed'
  }>
  teammates: Array<{
    name: string
    status: TeammateInfo['status']
    currentTaskSubject?: string
    completedTaskCount: number
  }>
  team?: TeamInfo
  effortLevel?: string
  tokenUsage?: { input: number; cacheCreation: number; cacheRead: number; output: number }
  stats: Session['stats']
  gitBranch?: string
}

// Subscription channels (dashboard <-> concentrator pub/sub)
export type SubscriptionChannel =
  | 'session:events'
  | 'session:transcript'
  | 'session:tasks'
  | 'session:bg_output'
  | 'session:subagent_transcript'

// Dashboard -> Concentrator: channel subscription management
export interface ChannelSubscribe {
  type: 'channel_subscribe'
  channel: SubscriptionChannel
  sessionId: string
  agentId?: string // required for session:subagent_transcript
}

export interface ChannelUnsubscribe {
  type: 'channel_unsubscribe'
  channel: SubscriptionChannel
  sessionId: string
  agentId?: string
}

export interface ChannelUnsubscribeAll {
  type: 'channel_unsubscribe_all'
}

// Concentrator -> Dashboard: subscription acknowledgment
export interface ChannelAck {
  type: 'channel_ack'
  channel: SubscriptionChannel
  sessionId: string
  agentId?: string
  status: 'subscribed' | 'unsubscribed'
  previousSessionId?: string // set during rekey rollover
}

// Per-channel diagnostic stats
export interface ChannelStats {
  channel: SubscriptionChannel
  sessionId: string
  agentId?: string
  subscribedAt: number
  messagesSent: number
  bytesSent: number
  lastMessageAt: number
}

// Per-subscriber diagnostic info
export interface SubscriberDiag {
  id: string
  userName?: string
  protocolVersion: number
  connectedAt: number
  channels: ChannelStats[]
  totals: {
    messagesSent: number
    bytesSent: number
    messagesReceived: number
    bytesReceived: number
  }
}

// GET /api/subscriptions response
export interface SubscriptionsDiag {
  subscribers: SubscriberDiag[]
  summary: {
    totalSubscribers: number
    legacySubscribers: number
    v2Subscribers: number
    channelCounts: Record<string, number>
    totalBytesSent: number
    totalMessagesSent: number
  }
}

// Configuration
export const DEFAULT_CONCENTRATOR_URL = 'ws://localhost:9999'
export const DEFAULT_CONCENTRATOR_PORT = 9999
export const HEARTBEAT_INTERVAL_MS = 30000
// Idle timeout is now configured via global settings (idleTimeoutMinutes)
// Server evaluates idle status - clients trust session.status
