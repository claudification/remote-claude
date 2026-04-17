/**
 * WebSocket Protocol Types
 * Defines the message format between wrapper and concentrator
 */

import type { SpawnRequest } from './spawn-schema'

// Dashboard -> Concentrator: spawn request (WS equivalent of POST /api/spawn)
export type SpawnRequestMessage = { type: 'spawn_request' } & SpawnRequest

// Concentrator -> Dashboard: ack for spawn_request (correlated by jobId)
export interface SpawnRequestAck {
  type: 'spawn_request_ack'
  ok: boolean
  jobId?: string
  wrapperId?: string
  tmuxSession?: string
  error?: string
}

// Wrapper -> Concentrator messages
export interface HookEvent {
  type: 'hook'
  sessionId: string
  hookEvent: HookEventType
  timestamp: number
  data: HookEventData
}

// Capabilities that rclaude declares on connect
export type WrapperCapability = 'terminal' | 'channel' | 'headless' | 'ad-hoc'

export interface SessionMeta {
  type: 'meta'
  sessionId: string
  wrapperId: string // unique per rclaude instance (multiple wrappers can share a sessionId via --resume)
  cwd: string
  startedAt: number
  model?: string
  args?: string[]
  capabilities?: WrapperCapability[]
  version?: string
  buildTime?: string
  claudeVersion?: string
  claudeAuth?: {
    email?: string
    orgId?: string
    orgName?: string
    subscriptionType?: string
  }
  spinnerVerbs?: string[]
  autocompactPct?: number // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE value if set
  maxBudgetUsd?: number // --max-budget-usd value if set (headless only)
  adHocTaskId?: string // project board task slug that spawned this ad-hoc session
  adHocWorktree?: string // worktree branch name for ad-hoc sessions
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

// Content block in a Claude API message (text, tool_use, tool_result, thinking)
export interface TranscriptContentBlock {
  type: string // 'text' | 'tool_use' | 'thinking' | 'tool_result' | ...
  text?: string
  thinking?: string
  signature?: string
  name?: string
  id?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | unknown
  is_error?: boolean
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
  content: TranscriptContentBlock[]
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
    content: string | TranscriptContentBlock[]
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
  | InterSessionMessage
  | ProjectLinkResponse
  | InterSessionListRequest
  | PermissionRequest
  | AskQuestionRequest
  | ClipboardCapture
  | DialogShowMessage
  | DialogDismissMessage
  | PlanApprovalRequest
  | PlanModeChanged
  | StreamDelta
  | WrapperRateLimit
  | SessionInfoUpdate
  | SessionNameUpdate
  | SpawnFailed
  | MonitorUpdate
  | ScheduledTaskFire
  | SessionStatusSignal

export interface SessionNameUpdate {
  type: 'session_name'
  sessionId: string
  name: string
}

// Session info from stream-json init (skills, tools, agents, etc.)
export interface SessionInfoUpdate {
  type: 'session_info'
  sessionId: string
  tools: string[]
  slashCommands: string[]
  skills: string[]
  agents: string[]
  mcpServers: Array<{ name: string; status?: string }>
  plugins: Array<{ name: string; source?: string }>
  model: string
  permissionMode: string
  claudeCodeVersion: string
  fastModeState: string
}

// Backend-agnostic session status signal (wrapper -> concentrator)
// Works for any backend (headless stream-json, PTY, future transports).
// Fired when the wrapper detects work starting/stopping, independent of CC hooks.
export interface SessionStatusSignal {
  type: 'session_status'
  sessionId: string
  status: 'active' | 'idle'
}

// Headless streaming deltas (token-by-token from --include-partial-messages)
export interface StreamDelta {
  type: 'stream_delta'
  sessionId: string
  event: Record<string, unknown> // raw Anthropic API SSE event
}

// Rate limit notification from headless stream-json backend
export interface WrapperRateLimit {
  type: 'rate_limit'
  sessionId: string
  retryAfterMs: number
  message: string
}

// Clipboard capture from PTY OSC 52 sequences
export interface ClipboardCapture {
  type: 'clipboard_capture'
  sessionId: string
  contentType: 'text' | 'image'
  text?: string // decoded text (for text content)
  base64?: string // raw base64 (for images -- text omits this to save bandwidth)
  mimeType?: string // 'image/png', 'image/jpeg', etc.
  timestamp: number
}

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

export interface TranscriptKick {
  type: 'transcript_kick'
  sessionId: string
}

// Persistent inter-session link (CWD-pair based, survives restarts)
export interface LinkSummary {
  cwdA: string
  cwdB: string
  nameA: string
  nameB: string
  createdAt: number
  lastUsed: number
  online: boolean // true if both CWDs have active sessions
  sessionIdA?: string
  sessionIdB?: string
}

// Inter-session messaging (channel-enabled sessions only)
export type InterSessionIntent = 'request' | 'response' | 'notify' | 'progress'

export interface InterSessionMessage {
  type: 'channel_send'
  fromSession: string
  toSession: string
  intent: InterSessionIntent
  message: string
  context?: string
  conversationId?: string
}

export interface InterSessionDelivery {
  type: 'channel_deliver'
  fromSession: string
  fromProject: string
  intent: InterSessionIntent
  message: string
  context?: string
  conversationId?: string
}

export interface ProjectLinkRequest {
  type: 'channel_link_request'
  fromSession: string
  fromProject: string
}

export interface ProjectLinkResponse {
  type: 'channel_link_response'
  sessionId: string
  action: 'approve' | 'block'
}

export interface InterSessionListRequest {
  type: 'channel_list_sessions'
  status?: 'live' | 'inactive' | 'all'
}

export interface InterSessionListResponse {
  type: 'channel_sessions_list'
  sessions: Array<{
    id: string
    name: string
    cwd: string
    status: 'live' | 'inactive'
    title?: string
    summary?: string
  }>
}

// AskUserQuestion relay (CC 2.1.85+ PreToolUse hook -> dashboard -> hook response)
export interface AskQuestionOption {
  label: string
  description: string
  preview?: string
}

export interface AskQuestionItem {
  question: string
  header: string
  options: AskQuestionOption[]
  multiSelect?: boolean
}

export interface AskQuestionRequest {
  type: 'ask_question'
  sessionId: string
  toolUseId: string
  questions: AskQuestionItem[]
}

export interface AskQuestionResponse {
  type: 'ask_answer'
  sessionId: string
  toolUseId: string
  answers: Record<string, string> // question text -> selected label(s)
  annotations?: Record<string, { preview?: string; notes?: string }>
  skip?: boolean // true = fall through to terminal UI
}

// Dialog MCP tool (channel-based rich UI for user interaction)
export type { DialogComponent, DialogLayout, DialogResult } from './dialog-schema'

export interface DialogShowMessage {
  type: 'dialog_show'
  sessionId: string
  dialogId: string
  layout: import('./dialog-schema').DialogLayout
}

export interface DialogResultMessage {
  type: 'dialog_result'
  sessionId: string
  dialogId: string
  result: import('./dialog-schema').DialogResult
  [key: string]: unknown
}

export interface DialogDismissMessage {
  type: 'dialog_dismiss'
  sessionId: string
  dialogId: string
}

// Plan approval relay (headless: ExitPlanMode -> wrapper -> concentrator -> dashboard -> back)
export interface PlanApprovalRequest {
  type: 'plan_approval'
  sessionId: string
  requestId: string // control_request request_id from CC
  toolUseId?: string
  plan: string // the plan content (markdown)
  planFilePath?: string
  allowedPrompts?: string[]
}

export interface PlanApprovalResponse {
  type: 'plan_approval_response'
  sessionId: string
  requestId: string
  toolUseId?: string
  action: 'approve' | 'reject' | 'feedback'
  feedback?: string // user feedback text (when action === 'feedback')
  [key: string]: unknown // WS JSON boundary
}

export interface PlanModeChanged {
  type: 'plan_mode_changed'
  sessionId: string
  planMode: boolean
}

// Permission relay (CC -> channel -> dashboard -> channel -> CC)
export interface PermissionRequest {
  type: 'permission_request'
  sessionId: string
  requestId: string // request_id from CC's control_request
  toolName: string
  description: string
  inputPreview: string // JSON.stringify(input), truncated to 200 chars
  toolUseId?: string // tool_use_id from CC, needed for control_response
}

export interface PermissionResponse {
  type: 'permission_response'
  sessionId: string
  requestId: string
  behavior: 'allow' | 'deny'
  toolUseId?: string
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
  | TranscriptKick
  | InterSessionDelivery
  | ProjectLinkRequest
  | InterSessionListResponse
  | SendInterrupt
  | PermissionResponse
  | AskQuestionResponse
  | QuitSession
  | DialogResultMessage
  | PlanApprovalResponse

export interface SendInterrupt {
  type: 'interrupt'
  sessionId: string
}

export interface QuitSession {
  type: 'terminate_session'
  sessionId: string
}

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
  | 'StopFailure'
  | 'Setup'
  | 'CwdChanged'
  | 'FileChanged'
  | 'TaskCreated'
  | 'PermissionDenied'

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

// Monitor (background watch) tracking
export interface MonitorInfo {
  taskId: string
  toolUseId: string
  description: string
  command?: string
  persistent?: boolean
  timeoutMs?: number
  startedAt: number
  stoppedAt?: number
  status: 'running' | 'completed' | 'timed_out' | 'failed'
  eventCount: number
}

// Monitor lifecycle events (wrapper -> concentrator)
export interface MonitorUpdate {
  type: 'monitor_update'
  sessionId: string
  monitor: MonitorInfo
}

// Scheduled task fire event (wrapper -> concentrator, distinct from transcript entry)
export interface ScheduledTaskFire {
  type: 'scheduled_task_fire'
  sessionId: string
  content: string
  timestamp: number
}

// Per-project customization settings (label, icon, color, keyterms)
export interface ProjectSettings {
  label?: string
  icon?: string
  color?: string
  description?: string // user-provided purpose, shown in list_sessions for routing
  keyterms?: string[]
  trustLevel?: 'default' | 'open' | 'benevolent' // open = accepts from anyone, benevolent = can message anyone
  defaultLaunchMode?: 'headless' | 'pty'
  defaultEffort?: 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' // 'default' = don't pass --effort flag
  defaultModel?: string // model alias or full name (e.g. 'sonnet', 'opus', 'claude-sonnet-4-7')
  // Spawn dialog defaults (override global)
  defaultBare?: boolean
  defaultRepl?: boolean
  defaultPermissionMode?: 'default' | 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions'
  defaultAutocompactPct?: number // 0 = use CC default
  defaultMaxBudgetUsd?: number // 0 = no limit
  defaultEnvText?: string
  allowPlanMode?: boolean // default: true. Set false to auto-deny EnterPlanMode
  verbs?: string[] // custom spinner verbs (merged with defaults)
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
  cwd: string // project root (where rclaude launched -- session identity)
  currentCwd?: string // where Claude is currently working (CwdChanged hook)
  model?: string
  args?: string[]
  capabilities?: WrapperCapability[]
  transcriptPath?: string
  version?: string
  buildTime?: string
  claudeVersion?: string
  claudeAuth?: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string }
  startedAt: number
  lastActivity: number
  status: 'active' | 'idle' | 'ended' | 'starting'
  compacting?: boolean
  compactedAt?: number
  events: HookEvent[]
  subagents: SubagentInfo[]
  tasks: TaskInfo[]
  archivedTasks: ArchivedTaskGroup[]
  bgTasks: BgTaskInfo[]
  monitors: MonitorInfo[]
  teammates: TeammateInfo[]
  team?: TeamInfo
  diagLog: Array<{ t: number; type: string; msg: string; args?: unknown }>
  effortLevel?: string // 'speed' field from API usage: e.g. 'standard', maps to low/medium/high
  lastError?: { stopReason?: string; errorType?: string; errorMessage?: string; timestamp: number }
  rateLimit?: { retryAfterMs: number; message: string; timestamp: number }
  pendingAttention?: {
    type: 'permission' | 'elicitation' | 'ask' | 'dialog' | 'plan_approval'
    toolName?: string
    filePath?: string
    question?: string
    timestamp: number
  }
  planMode?: boolean // true when session is in plan mode (EnterPlanMode approved, not yet exited)
  hasNotification?: boolean // unread notification (cleared when session is viewed)
  pendingDialog?: { dialogId: string; layout: import('./dialog-schema').DialogLayout; timestamp: number }
  pendingPlanApproval?: {
    requestId: string
    toolUseId?: string
    plan: string
    planFilePath?: string
    allowedPrompts?: unknown[]
    timestamp: number
  }
  pendingPermission?: {
    requestId: string
    toolName: string
    description: string
    inputPreview: string
    toolUseId?: string
    timestamp: number
  }
  pendingAskQuestion?: {
    toolUseId: string
    questions: unknown[]
    timestamp: number
  }
  tokenUsage?: { input: number; cacheCreation: number; cacheRead: number; output: number }
  cacheTtl?: '5m' | '1h' // dominant cache TTL tier from last turn
  lastTurnEndedAt?: number // timestamp when last turn completed (Stop hook)
  // Transcript-derived metadata (from special JSONL entry types)
  summary?: string // AI-generated session summary
  title?: string // custom session title (from /rename or auto-generated)
  titleUserSet?: boolean // true if title was explicitly set by user (spawn dialog) -- prevents auto-name overwrite
  agentName?: string // agent/skill name (for --agent sessions)
  prLinks?: Array<{ prNumber: number; prUrl: string; prRepository: string; timestamp: string }>
  stats: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheCreation: number
    totalCacheWrite5m: number // 5-min TTL cache writes (1.25x input price)
    totalCacheWrite1h: number // 1-hour TTL cache writes (2.0x input price)
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
  gitBranch?: string
  spinnerVerbs?: string[] // custom spinner verbs from ~/.claude/settings.json
  autocompactPct?: number // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE value if set
  maxBudgetUsd?: number // --max-budget-usd value if set (headless only)
  adHocTaskId?: string // project board task slug that spawned this ad-hoc session
  adHocWorktree?: string // worktree branch name for ad-hoc sessions
  launchConfig?: LaunchConfig // resolved launch configuration -- reused on revive
  resultText?: string // final result text from headless session (captured from stream-json result message)
  recap?: { content: string; timestamp: number } // away_summary from CC recaps
}

/** Resolved launch configuration -- stored on session at spawn time, reused on revive */
export interface LaunchConfig {
  headless: boolean
  model?: string
  effort?: string
  bare?: boolean
  repl?: boolean
  permissionMode?: string
  autocompactPct?: number
  maxBudgetUsd?: number
  env?: Record<string, string>
}

// ─── Launch Jobs (request-scoped event channels for spawn/revive) ────

/** Agent -> Concentrator: progress event during spawn/revive, tagged with jobId */
export interface LaunchLog {
  type: 'launch_log'
  jobId: string
  step: string
  status: 'info' | 'ok' | 'error'
  detail?: string
  t: number
}

/** Structured launch lifecycle step (concentrator -> dashboard, first-class) */
export type LaunchStep =
  | 'job_created'
  | 'spawn_sent'
  | 'agent_acked'
  | 'wrapper_booted'
  | 'session_connected'
  | 'prompt_submitted'
  | 'running'
  | 'completed'
  | 'failed'

/**
 * Concentrator -> Dashboard: first-class launch progress event.
 * Emitted at each lifecycle step of a spawn/revive job so clients (dashboard,
 * MCP callers) see real progress instead of silence.
 */
export interface LaunchProgressEvent {
  type: 'launch_progress'
  jobId: string
  step: LaunchStep
  status: 'active' | 'done' | 'error'
  detail?: string
  t: number
  wrapperId?: string
  sessionId?: string
  elapsed?: number
  error?: string
}

/** Concentrator -> Dashboard: launch job completed (session connected) */
export interface JobComplete {
  type: 'job_complete'
  jobId: string
  sessionId: string
  wrapperId: string
}

/** Concentrator -> Dashboard: launch job failed */
export interface JobFailed {
  type: 'job_failed'
  jobId: string
  error: string
}

// Agent -> Concentrator messages
export interface AgentIdentify {
  type: 'agent_identify'
  machineId?: string // short fingerprint (truncated SHA-256 of platform UUID/machine-id)
  hostname?: string
}

export interface ReviveResult {
  type: 'revive_result'
  sessionId: string
  wrapperId?: string // echoes the pre-assigned wrapperId
  cwd?: string // echoed back for scoped broadcast when session is evicted
  jobId?: string // launch job correlation ID
  success: boolean
  error?: string
  tmuxSession?: string
  continued: boolean // true if --resume worked, false if fresh session
}

export interface SpawnResult {
  type: 'spawn_result'
  requestId: string
  jobId?: string // launch job correlation ID
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

/** Agent or wrapper reports a spawn failure (headless child exit, PTY crash, or early exit) */
export interface SpawnFailed {
  type: 'spawn_failed'
  wrapperId: string
  cwd?: string
  pid?: number
  exitCode?: number | null
  error?: string
  elapsedMs?: number // time from spawn to exit (< 5000 = likely hook/config failure)
}

// Usage API data (agent polls api.anthropic.com/api/oauth/usage)
export interface UsageWindow {
  usedPercent: number // 0-100
  resetAt: string // ISO timestamp
}

export interface ExtraUsage {
  isEnabled: boolean
  monthlyLimit: number
  usedCredits: number
  utilization: number | null
}

export interface UsageUpdate {
  type: 'usage_update'
  fiveHour: UsageWindow
  sevenDay: UsageWindow
  sevenDayOpus?: UsageWindow
  sevenDaySonnet?: UsageWindow
  extraUsage?: ExtraUsage
  polledAt: number // timestamp of last poll
}

export type AgentMessage =
  | AgentIdentify
  | ReviveResult
  | SpawnResult
  | SpawnFailed
  | ListDirsResult
  | UsageUpdate
  | LaunchLog

// Concentrator -> Agent messages
export interface ReviveSession {
  type: 'revive'
  sessionId: string
  cwd: string
  wrapperId: string // pre-assigned wrapperId so concentrator can correlate the incoming connection
  jobId?: string // launch job correlation ID for progress events
  adHocWorktree?: string // restore worktree context on revive (RCLAUDE_WORKTREE env)
  env?: Record<string, string> // custom env vars forwarded to claude process
}

export interface SpawnSession {
  type: 'spawn'
  requestId: string
  cwd: string
  wrapperId: string
  jobId?: string // launch job correlation ID for progress events
  // Ad-hoc task runner fields
  prompt?: string // initial prompt to send after session starts
  adHoc?: boolean // fire-and-forget headless session
  adHocTaskId?: string // project board task slug for deep linking
  worktree?: string // git worktree branch name (passed as --worktree to claude CLI)
  env?: Record<string, string> // custom env vars forwarded to claude process
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
  claudeAuth?: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string }
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
  archivedTasks?: Array<{ id: string; subject: string }>
  runningBgTaskCount: number
  bgTasks: Array<{
    taskId: string
    command: string
    description: string
    startedAt: number
    completedAt?: number
    status: 'running' | 'completed' | 'killed'
  }>
  monitors: MonitorInfo[]
  runningMonitorCount: number
  teammates: Array<{
    name: string
    status: TeammateInfo['status']
    currentTaskSubject?: string
    completedTaskCount: number
  }>
  team?: TeamInfo
  effortLevel?: string
  lastError?: Session['lastError']
  rateLimit?: Session['rateLimit']
  planMode?: boolean
  pendingAttention?: Session['pendingAttention']
  hasNotification?: boolean
  summary?: string
  title?: string
  agentName?: string
  prLinks?: Session['prLinks']
  linkedProjects?: Array<{ cwd: string; name: string }>
  tokenUsage?: { input: number; cacheCreation: number; cacheRead: number; output: number }
  cacheTtl?: '5m' | '1h'
  lastTurnEndedAt?: number
  stats: Session['stats']
  costTimeline?: Session['costTimeline']
  gitBranch?: string
  spinnerVerbs?: string[]
  autocompactPct?: number
  maxBudgetUsd?: number
  adHocTaskId?: string
  adHocWorktree?: string
  resultText?: string
  recap?: Session['recap']
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
// Session status is driven by hooks (active/idle/ended), no configurable timeout
// Server evaluates idle status - clients trust session.status
