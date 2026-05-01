/**
 * WebSocket Protocol Types
 * Defines the message format between wrapper and broker
 */

import type { SpawnRequest } from './spawn-schema'

// Control Panel -> Broker: spawn request (WS equivalent of POST /api/spawn)
export type SpawnRequestMessage = { type: 'spawn_request' } & SpawnRequest

// Broker -> Control Panel: ack for spawn_request (correlated by jobId)
export interface SpawnRequestAck {
  type: 'spawn_request_ack'
  ok: boolean
  jobId?: string
  conversationId?: string
  tmuxSession?: string
  error?: string
}

// Wrapper -> Broker messages
export interface HookEvent {
  type: 'hook'
  conversationId: string
  hookEvent: HookEventType
  timestamp: number
  data: HookEventData
}

// Capabilities that rclaude declares on connect
export type AgentHostCapability =
  | 'terminal'
  | 'channel'
  | 'headless'
  | 'json_stream'
  | 'ad-hoc'
  | 'boot_stream'
  | 'repl'
  | 'config_rw'

/** Discrete lifecycle steps the wrapper reports while booting, before CC
 *  has a real session id. Rendered inline in the transcript as BootEntry. */
export type BootStep =
  | 'wrapper_started'
  | 'settings_merged'
  | 'mcp_prepared'
  | 'broker_connected'
  | 'claude_spawning'
  | 'claude_started'
  | 'awaiting_init'
  | 'init_received'
  | 'session_ready'
  | 'claude_exited'
  | 'boot_error'

export interface ConversationMeta {
  type: 'meta'
  sessionId: string
  conversationId: string // stable identity that survives /clear, reconnect, and revival
  project: string
  startedAt: number
  model?: string
  configuredModel?: string // the --model value passed to CC (CC strips [1m] from API responses)
  args?: string[]
  capabilities?: AgentHostCapability[]
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

// Wrapper tells broker the Claude session ID changed (e.g. /clear)
// Same wrapper, same PTY, just a new Claude session -- re-key without ending
export interface SessionClear {
  type: 'session_clear'
  oldSessionId: string
  newSessionId: string
  conversationId: string
  project: string
  model?: string
}

export interface Heartbeat {
  type: 'heartbeat'
  conversationId: string
  timestamp: number
}

// Terminal streaming messages (browser <-> broker <-> rclaude)
// All terminal messages route by conversationId (stable conversation identity)
export interface TerminalAttach {
  type: 'terminal_attach'
  conversationId: string
  cols: number
  rows: number
}

export interface TerminalDetach {
  type: 'terminal_detach'
  conversationId: string
}

export interface TerminalData {
  type: 'terminal_data'
  conversationId: string
  data: string
}

export interface TerminalResize {
  type: 'terminal_resize'
  conversationId: string
  cols: number
  rows: number
}

export interface TerminalError {
  type: 'terminal_error'
  conversationId: string
  error: string
}

export interface DiagLog {
  type: 'diag'
  conversationId: string
  entries: Array<{ t: number; type: string; msg: string; args?: unknown }>
}

export interface TasksUpdate {
  type: 'tasks_update'
  conversationId: string
  tasks: TaskInfo[]
}

// Transcript streaming: rclaude -> broker
export interface TranscriptEntries {
  type: 'transcript_entries'
  conversationId: string
  entries: TranscriptEntry[]
  isInitial: boolean // true for initial batch on connect, false for incremental
}

export interface SubagentTranscript {
  type: 'subagent_transcript'
  conversationId: string
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
  /** Per-session monotonic sequence number, stamped by the broker on cache
   *  insert. Starts at 1, increments by 1 per entry within a session. Scoped to
   *  the broker's in-memory counter -- NOT persisted to JSONL. On restart
   *  the counter rebuilds from hydration and SYNC_EPOCH bumps, forcing clients
   *  to full-resync. Clients compare `lastAppliedSeq[sid]` to server's seq for
   *  sync integrity. Missing (undefined) only on raw JSONL read before ingest. */
  seq?: number
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

/** Wrapper-generated boot timeline entry. Rendered above real CC messages
 *  during the pre-session-id phase. `raw` holds the full underlying payload
 *  (init message, exit info, etc.) for click-to-expand in the UI. */
export interface TranscriptBootEntry extends TranscriptEntryBase {
  type: 'boot'
  step: BootStep
  detail?: string
  raw?: unknown
}

/** Wrapper-generated CC launch lifecycle entry. Like TranscriptBootEntry but
 *  covers the full lifecycle including /clear reboots. launchId groups all
 *  steps of a single launch so the UI can render them as one card. */
export interface TranscriptLaunchEntry extends TranscriptEntryBase {
  type: 'launch'
  launchId: string
  phase: WrapperLaunchPhase
  step: WrapperLaunchStep
  detail?: string
  raw?: Record<string, unknown>
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
  | TranscriptBootEntry
  | TranscriptLaunchEntry
  | (TranscriptEntryBase & Record<string, unknown>) // fallback for unknown types

// Streaming output from background bash tasks (.output file watching)
export interface BgTaskOutput {
  type: 'bg_task_output'
  conversationId: string
  taskId: string
  data: string // new chunk of output
  done: boolean // true when task has completed and file is fully read
}

export interface WrapperNotify {
  type: 'notify'
  conversationId: string
  message: string
  title?: string
}

/** First frame from the wrapper after the WS handshake, sent BEFORE CC has
 *  produced a session id. Gives the broker enough to create a
 *  placeholder "booting" session so the dashboard shows progress from t=0. */
export interface WrapperBoot {
  type: 'wrapper_boot'
  conversationId: string
  project: string
  capabilities: AgentHostCapability[]
  claudeArgs: string[]
  claudeVersion?: string
  claudeAuth?: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string }
  launchConfig?: LaunchConfig
  title?: string
  description?: string
  startedAt: number
  configuredModel?: string // the --model value passed to CC (CC strips [1m] from API responses)
}

/** Structured wrapper-side boot progress. Broker appends each one as a
 *  TranscriptBootEntry and broadcasts it as a transcript update, so the user
 *  sees the boot timeline live. `raw` is optional -- present for events with
 *  a rich payload (init message, exit info). */
export interface BootEvent {
  type: 'boot_event'
  conversationId: string
  step: BootStep
  detail?: string
  raw?: unknown
  t: number
}

/**
 * Launch events — structured, persistent timeline of the CC process launching,
 * re-launching (on /clear), and settling on a session id. Each logical launch
 * gets a fresh `launchId` (uuid); every step in that launch carries the same
 * id so the dashboard can group them. These are distinct from boot events:
 *   - BootEvent fires only during the initial boot phase (wrapper_started
 *     through session_ready) and is keyed by conversationId.
 *   - LaunchEvent covers the whole launch lifecycle including /clear reboots,
 *     is keyed by both conversationId AND launchId, and is rendered inline in the
 *     transcript so the user always sees "which CC am I talking to and how
 *     was it launched?". The full args/env/init payloads go in `raw` for the
 *     (i) JSON inspector.
 */
export type WrapperLaunchPhase = 'initial' | 'reboot' | 'live'

export type WrapperLaunchStep =
  | 'launch_started' // process about to be spawned. raw: { args, env, cwd, headless, channelEnabled, mcpConfigPath, settingsPath }
  | 'clear_requested' // /clear dispatched. detail: source. Only on reboot phase.
  | 'process_killed' // CC exited during reboot. raw: { code }
  | 'mcp_reset' // MCP channel torn down (reboot only)
  | 'settings_regenerated' // settings + mcp config re-written (reboot only)
  | 'init_received' // CC reported a session id. raw: { session_id, model, tools, slash_commands, skills, agents, mcp_servers, plugins, ... }
  | 'rekeyed' // observeClaudeSessionId completed the rekey. detail: from -> to
  | 'ready' // launch settled; session usable
  // Mid-session state changes -- broker emits these by diffing session_info
  // across turns. Phase is 'live' (not initial/reboot). Each gets its own launchId
  // so they render as separate cards in the transcript.
  | 'model_changed' // detail: "old -> new". raw: { from, to }
  | 'permission_mode_changed' // detail: "old -> new". raw: { from, to }
  | 'fast_mode_changed' // detail: "on/off". raw: { from, to }
  | 'mcp_servers_changed' // detail: "+1 / -2". raw: { added, removed, current }
  | 'tools_changed' // detail: "+N / -N". raw: { added, removed, count }
  | 'slash_commands_changed' // detail: "+N / -N". raw: { added, removed, count }
  | 'skills_changed' // detail: "+N / -N". raw: { added, removed, count }
  | 'agents_changed' // detail: "+N / -N". raw: { added, removed, count }
  | 'plugins_changed' // detail: "+N / -N". raw: { added, removed, count }
  | 'conversation_exit' // self-termination via exit_session MCP tool. raw: { status, message }

/**
 * Wrapper -> broker -> dashboard: CC process launch lifecycle event.
 * Separate from `LaunchProgressEvent` (broker-initiated spawn jobs):
 * WrapperLaunchEvent is emitted by the wrapper itself and covers its local
 * CC process launching, re-launching on /clear, and settling on a session id.
 */
export interface WrapperLaunchEvent {
  type: 'launch_event'
  conversationId: string
  launchId: string
  phase: WrapperLaunchPhase
  step: WrapperLaunchStep
  /** Session id at the time of the step. null before init_received. */
  sessionId: string | null
  detail?: string
  raw?: Record<string, unknown>
  t: number
}

/** Tells the broker to promote the boot session to a real session once
 *  CC has produced a session id. Source indicates which channel won the race
 *  (stream-json init in headless, SessionStart hook in PTY). */
export interface SessionPromote {
  type: 'session_promote'
  conversationId: string
  sessionId: string
  source: 'stream_json' | 'hook'
}

export type AgentHostMessage =
  | HookEvent
  | ConversationMeta
  | SessionEnd
  | SessionClear
  | WrapperBoot
  | BootEvent
  | WrapperLaunchEvent
  | SessionPromote
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
  | ConversationInfoUpdate
  | ConversationNameUpdate
  | SpawnFailed
  | MonitorUpdate
  | ScheduledTaskFire
  | ConversationStatusSignal
  | JsonStreamData

export interface ConversationNameUpdate {
  type: 'conversation_name'
  conversationId: string
  name: string
  description?: string
}

// Session info from stream-json init (skills, tools, agents, etc.)
export interface ConversationInfoUpdate {
  type: 'conversation_info'
  conversationId: string
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

// Backend-agnostic session status signal (wrapper -> broker)
// Works for any backend (headless stream-json, PTY, future transports).
// Fired when the wrapper detects work starting/stopping, independent of CC hooks.
export interface ConversationStatusSignal {
  type: 'conversation_status'
  conversationId: string
  status: 'active' | 'idle'
}

// Headless streaming deltas (token-by-token from --include-partial-messages)
export interface StreamDelta {
  type: 'stream_delta'
  conversationId: string
  event: Record<string, unknown> // raw Anthropic API SSE event
}

// Raw NDJSON stream (headless sessions only -- dashboard tails raw CC output)
// Mirrors terminal_attach/detach pattern: wrapper only sends when viewers are attached.
export interface JsonStreamAttach {
  type: 'json_stream_attach'
  conversationId: string
}

export interface JsonStreamDetach {
  type: 'json_stream_detach'
  conversationId: string
}

export interface JsonStreamData {
  type: 'json_stream_data'
  conversationId: string
  lines: string[] // raw NDJSON lines from CC stdout
  isBackfill: boolean // true for initial batch on attach
}

// Rate limit notification from headless stream-json backend
export interface WrapperRateLimit {
  type: 'rate_limit'
  conversationId: string
  retryAfterMs: number
  message: string
}

// Clipboard capture from PTY OSC 52 sequences
export interface ClipboardCapture {
  type: 'clipboard_capture'
  conversationId: string
  contentType: 'text' | 'image'
  text?: string // decoded text (for text content)
  base64?: string // raw base64 (for images -- text omits this to save bandwidth)
  mimeType?: string // 'image/png', 'image/jpeg', etc.
  timestamp: number
}

// Broker -> Wrapper messages
export interface Ack {
  type: 'ack'
  eventId: string
  origins?: string[]
}

export interface BrokerError {
  type: 'error'
  message: string
}

export interface SendInput {
  type: 'input'
  conversationId: string
  input: string
  crDelay?: number // carriage return delay in ms (dashboard setting, optional)
}

// Transcript streaming: broker -> rclaude
export interface TranscriptRequest {
  type: 'transcript_request'
  conversationId: string
  limit?: number
}

export interface SubagentTranscriptRequest {
  type: 'subagent_transcript_request'
  conversationId: string
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
  conversationId: string
}

// Persistent inter-session link (project-pair based, survives restarts)
export interface LinkSummary {
  projectA: string
  projectB: string
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
  conversationId: string
  action: 'approve' | 'block'
}

export interface InterSessionListRequest {
  type: 'channel_list_sessions'
  status?: 'live' | 'inactive' | 'all'
}

export interface InterConversationListResponse {
  type: 'channel_sessions_list'
  sessions: Array<{
    id: string
    name: string
    project: string
    status: 'live' | 'inactive'
    title?: string
    description?: string
    summary?: string
  }>
  self?: {
    id: string
    project: string
    session_id: string
    name: string
    model?: string
    permissionMode?: string
    effortLevel?: string
    status: 'live'
  }
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
  conversationId: string
  toolUseId: string
  questions: AskQuestionItem[]
}

export interface AskQuestionResponse {
  type: 'ask_answer'
  conversationId: string
  toolUseId: string
  answers: Record<string, string> // question text -> selected label(s)
  annotations?: Record<string, { preview?: string; notes?: string }>
  skip?: boolean // true = fall through to terminal UI
}

// Dialog MCP tool (channel-based rich UI for user interaction)
export type { DialogComponent, DialogLayout, DialogResult } from './dialog-schema'

export interface DialogShowMessage {
  type: 'dialog_show'
  conversationId: string
  dialogId: string
  layout: import('./dialog-schema').DialogLayout
}

export interface DialogResultMessage {
  type: 'dialog_result'
  conversationId: string
  dialogId: string
  result: import('./dialog-schema').DialogResult
  [key: string]: unknown
}

export interface DialogDismissMessage {
  type: 'dialog_dismiss'
  conversationId: string
  dialogId: string
}

// Plan approval relay (headless: ExitPlanMode -> wrapper -> broker -> dashboard -> back)
export interface PlanApprovalRequest {
  type: 'plan_approval'
  conversationId: string
  requestId: string // control_request request_id from CC
  toolUseId?: string
  plan: string // the plan content (markdown)
  planFilePath?: string
  allowedPrompts?: string[]
}

export interface PlanApprovalResponse {
  type: 'plan_approval_response'
  conversationId: string
  requestId: string
  toolUseId?: string
  action: 'approve' | 'reject' | 'feedback'
  feedback?: string // user feedback text (when action === 'feedback')
  [key: string]: unknown // WS JSON boundary
}

export interface PlanModeChanged {
  type: 'plan_mode_changed'
  conversationId: string
  planMode: boolean
}

// Permission relay (CC -> channel -> dashboard -> channel -> CC)
export interface PermissionRequest {
  type: 'permission_request'
  conversationId: string
  requestId: string // request_id from CC's control_request
  toolName: string
  description: string
  inputPreview: string // JSON.stringify(input), truncated to 200 chars
  toolUseId?: string // tool_use_id from CC, needed for control_response
}

export interface PermissionResponse {
  type: 'permission_response'
  conversationId: string
  requestId: string
  behavior: 'allow' | 'deny'
  toolUseId?: string
}

export type BrokerMessage =
  | Ack
  | BrokerError
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
  | InterConversationListResponse
  | SendInterrupt
  | PermissionResponse
  | AskQuestionResponse
  | QuitConversation
  | ConversationControl
  | ControlDeliver
  | DialogResultMessage
  | PlanApprovalResponse
  | NotifyConfigUpdated
  | RclaudeConfigGet
  | RclaudeConfigSet
  | JsonStreamAttach
  | JsonStreamDetach

export interface NotifyConfigUpdated {
  type: 'notify_config_updated'
}

export interface SendInterrupt {
  type: 'interrupt'
  conversationId: string
}

export interface QuitConversation {
  type: 'terminate_conversation'
  conversationId: string
}

/**
 * Higher-level control verbs routed to a target session's wrapper. The wrapper
 * interprets these backend-specifically (headless vs PTY) instead of letting
 * the text reach the model. Used by:
 *   - dashboard input: when user types a bare `/clear`, `/quit`, `:q`, etc.
 *   - inter-session MCP `control_session` tool
 */
export type ConversationControlAction =
  | 'clear'
  | 'quit'
  | 'interrupt'
  | 'set_model'
  | 'set_effort'
  | 'set_permission_mode'

export interface ConversationControl {
  type: 'conversation_control'
  targetSession: string
  action: ConversationControlAction
  fromSession?: string
  model?: string // required when action === 'set_model'
  effort?: string // required when action === 'set_effort' (low|medium|high|xhigh|max|auto)
  permissionMode?: string // required when action === 'set_permission_mode'
}

export interface ConversationControlResult {
  type: 'conversation_control_result'
  ok: boolean
  action?: ConversationControlAction
  name?: string
  error?: string
}

/** Broker -> wrapper: execute a control verb against the local CC. */
export interface ControlDeliver {
  type: 'control'
  action: ConversationControlAction
  model?: string
  effort?: string
  permissionMode?: string
  fromSession?: string
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

// Monitor lifecycle events (wrapper -> broker)
export interface MonitorUpdate {
  type: 'monitor_update'
  conversationId: string
  monitor: MonitorInfo
}

// Scheduled task fire event (wrapper -> broker, distinct from transcript entry)
export interface ScheduledTaskFire {
  type: 'scheduled_task_fire'
  conversationId: string
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
  defaultIncludePartialMessages?: boolean // default: true. Set false to disable token streaming
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

// Session state in broker
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

export interface Conversation {
  id: string
  project: string // project URI identity (e.g. "claude:///Users/jonas/projects/foo")
  currentPath?: string // where Claude is currently working (CwdChanged hook)
  model?: string
  configuredModel?: string // the --model value passed to CC (preserves [1m] suffix that CC strips)
  args?: string[]
  capabilities?: AgentHostCapability[]
  transcriptPath?: string
  version?: string
  buildTime?: string
  claudeVersion?: string
  claudeAuth?: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string }
  startedAt: number
  lastActivity: number
  status: 'active' | 'idle' | 'ended' | 'starting' | 'booting'
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
  permissionMode?: string // current CC permission mode (default/plan/acceptEdits/auto/bypassPermissions)
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
  contextMode?: '1m' | 'standard' // detected from /model or /context stdout; overrides model-name heuristic
  cacheTtl?: '5m' | '1h' // dominant cache TTL tier from last turn
  lastTurnEndedAt?: number // timestamp when last turn completed (Stop hook)
  // Transcript-derived metadata (from special JSONL entry types)
  summary?: string // AI-generated session summary
  title?: string // custom session title (from /rename or auto-generated)
  titleUserSet?: boolean // true if title was explicitly set by user (spawn dialog) -- prevents auto-name overwrite
  description?: string // short user-provided line describing what this session is working on
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
  modelMismatch?: { requested: string; actual: string; detectedAt: number }
  resultText?: string // final result text from headless session (captured from stream-json result message)
  recap?: { content: string; timestamp: number } // away_summary from CC recaps
  recapFresh?: boolean // true when no meaningful activity has occurred after the recap
  hostSentinelId?: string // which sentinel owns this session (from sentinel registry)
  hostSentinelAlias?: string // denormalized display alias of the sentinel
}

/** Resolved launch configuration -- stored on session at spawn time, reused on revive */
export interface LaunchConfig {
  headless: boolean
  model?: string
  effort?: string
  agent?: string
  bare?: boolean
  repl?: boolean
  permissionMode?: string
  autocompactPct?: number
  maxBudgetUsd?: number
  includePartialMessages?: boolean
  env?: Record<string, string>
}

// ─── Launch Jobs (request-scoped event channels for spawn/revive) ────

/** Agent -> Broker: progress event during spawn/revive, tagged with jobId */
export interface LaunchLog {
  type: 'launch_log'
  jobId: string
  step: string
  status: 'info' | 'ok' | 'error'
  detail?: string
  t: number
}

/** Structured launch lifecycle step (broker -> dashboard, first-class) */
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
 * Broker -> Control Panel: first-class launch progress event.
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
  conversationId?: string
  sessionId?: string
  elapsed?: number
  error?: string
}

/** Broker -> Control Panel: launch job completed (session connected) */
export interface JobComplete {
  type: 'job_complete'
  jobId: string
  sessionId: string
  conversationId: string
}

/** Broker -> Control Panel: launch job failed */
export interface JobFailed {
  type: 'job_failed'
  jobId: string
  error: string
}

// Sentinel -> Broker messages
export interface SentinelIdentify {
  type: 'sentinel_identify'
  machineId?: string // short fingerprint (truncated SHA-256 of platform UUID/machine-id)
  hostname?: string
  alias?: string // suggested sentinel alias (first-contact only; broker may override with stored value)
  spawnRoot?: string // default directory for relative spawn paths
}

export interface ReviveResult {
  type: 'revive_result'
  sessionId: string
  conversationId?: string // echoes the pre-assigned conversationId
  project?: string // echoed back for scoped broadcast when session is evicted
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
  conversationId?: string
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
  conversationId: string
  project?: string
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

export type SentinelMessage =
  | SentinelIdentify
  | ReviveResult
  | SpawnResult
  | SpawnFailed
  | ListDirsResult
  | UsageUpdate
  | LaunchLog

// Broker -> Sentinel messages
export interface ReviveConversation {
  type: 'revive'
  sessionId: string
  project: string
  conversationId: string // pre-assigned conversationId so broker can correlate the incoming connection
  jobId?: string // launch job correlation ID for progress events
  adHocWorktree?: string // restore worktree context on revive (RCLAUDE_WORKTREE env)
  env?: Record<string, string> // custom env vars forwarded to claude process
}

export interface SpawnConversation {
  type: 'spawn'
  requestId: string
  cwd: string
  project?: string
  conversationId: string
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

export interface RclaudeConfigGet {
  type: 'rclaude_config_get'
  requestId: string
  project: string
}

export interface RclaudeConfigSet {
  type: 'rclaude_config_set'
  requestId: string
  project: string
  config: RclaudePermissionConfig
}

export interface RclaudePermissionConfig {
  permissions?: {
    Write?: { allow?: string[] }
    Edit?: { allow?: string[] }
    Read?: { allow?: string[] }
  }
  allowAll?: boolean
  allowPlanMode?: boolean
}

export interface RclaudeConfigData {
  type: 'rclaude_config_data'
  requestId: string
  config: RclaudePermissionConfig | null
  path: string
  project: string
}

export interface RclaudeConfigOk {
  type: 'rclaude_config_ok'
  requestId: string
  ok: boolean
  error?: string
}

export interface SentinelQuit {
  type: 'quit'
  reason?: string
}

export interface SentinelReject {
  type: 'sentinel_reject'
  reason: string
}

export type BrokerSentinelMessage = ReviveConversation | SpawnConversation | ListDirs | SentinelQuit | SentinelReject

// Dashboard broadcast: sentinel status
export interface SentinelStatus {
  type: 'sentinel_status'
  connected: boolean
}

// Session summary: broker -> dashboard wire format
export interface ConversationSummary {
  id: string
  project: string
  model?: string
  capabilities?: AgentHostCapability[]
  version?: string
  buildTime?: string
  claudeVersion?: string
  claudeAuth?: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string }
  conversationIds: string[]
  startedAt: number
  lastActivity: number
  status: Conversation['status']
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
  permissionMode?: string
  lastError?: Conversation['lastError']
  rateLimit?: Conversation['rateLimit']
  planMode?: boolean
  pendingAttention?: Conversation['pendingAttention']
  hasNotification?: boolean
  summary?: string
  title?: string
  description?: string
  agentName?: string
  prLinks?: Conversation['prLinks']
  linkedProjects?: Array<{ project: string; name: string }>
  tokenUsage?: { input: number; cacheCreation: number; cacheRead: number; output: number }
  contextWindow?: number // effective window (200K or 1M) matching Claude Code's current selection
  cacheTtl?: '5m' | '1h'
  lastTurnEndedAt?: number
  stats: Conversation['stats']
  costTimeline?: Conversation['costTimeline']
  gitBranch?: string
  spinnerVerbs?: string[]
  autocompactPct?: number
  maxBudgetUsd?: number
  adHocTaskId?: string
  adHocWorktree?: string
  modelMismatch?: Conversation['modelMismatch']
  resultText?: string
  recap?: Conversation['recap']
  recapFresh?: boolean
  hostSentinelId?: string
  hostSentinelAlias?: string
}

// Subscription channels (dashboard <-> broker pub/sub)
export type SubscriptionChannel =
  | 'conversation:events'
  | 'conversation:transcript'
  | 'conversation:tasks'
  | 'conversation:bg_output'
  | 'conversation:subagent_transcript'

// Control Panel -> Broker: channel subscription management
export interface ChannelSubscribe {
  type: 'channel_subscribe'
  channel: SubscriptionChannel
  conversationId: string
  agentId?: string // required for session:subagent_transcript
}

export interface ChannelUnsubscribe {
  type: 'channel_unsubscribe'
  channel: SubscriptionChannel
  conversationId: string
  agentId?: string
}

export interface ChannelUnsubscribeAll {
  type: 'channel_unsubscribe_all'
}

// Broker -> Control Panel: subscription acknowledgment
export interface ChannelAck {
  type: 'channel_ack'
  channel: SubscriptionChannel
  conversationId: string
  agentId?: string
  status: 'subscribed' | 'unsubscribed'
  previousSessionId?: string // set during rekey rollover
}

// Per-channel diagnostic stats
export interface ChannelStats {
  channel: SubscriptionChannel
  conversationId: string
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
export const DEFAULT_BROKER_URL = 'ws://localhost:9999'
export const DEFAULT_BROKER_PORT = 9999
export const HEARTBEAT_INTERVAL_MS = 30000
// Session status is driven by hooks (active/idle/ended), no configurable timeout
// Server evaluates idle status - clients trust session.status
