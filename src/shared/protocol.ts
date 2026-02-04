/**
 * WebSocket Protocol Types
 * Defines the message format between wrapper and concentrator
 */

// Wrapper -> Concentrator messages
export interface HookEvent {
  type: "hook";
  sessionId: string;
  hookEvent: HookEventType;
  timestamp: number;
  data: HookEventData;
}

export interface SessionMeta {
  type: "meta";
  sessionId: string;
  cwd: string;
  startedAt: number;
  model?: string;
  args?: string[];
}

export interface SessionEnd {
  type: "end";
  sessionId: string;
  reason: string;
  endedAt: number;
}

export interface Heartbeat {
  type: "heartbeat";
  sessionId: string;
  timestamp: number;
}

export type WrapperMessage = HookEvent | SessionMeta | SessionEnd | Heartbeat;

// Concentrator -> Wrapper messages
export interface Ack {
  type: "ack";
  eventId: string;
}

export interface ConcentratorError {
  type: "error";
  message: string;
}

export interface SendInput {
  type: "input";
  sessionId: string;
  input: string;
}

export type ConcentratorMessage = Ack | ConcentratorError | SendInput;

// Hook event types from Claude Code
export type HookEventType =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Notification"
  | "Stop"
  | "SessionEnd"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "PermissionRequest";

// Hook event data structures (based on Claude Code hook system)
export interface SessionStartData {
  session_id: string;
  cwd: string;
  model?: string;
  source?: string;
}

export interface UserPromptSubmitData {
  session_id: string;
  prompt: string;
}

export interface PreToolUseData {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PostToolUseData {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: string;
}

export interface PostToolUseFailureData {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  error: string;
}

export interface NotificationData {
  session_id: string;
  message: string;
  notification_type?: string;
}

export interface StopData {
  session_id: string;
  reason?: string;
}

export interface SessionEndData {
  session_id: string;
  reason?: string;
}

export interface SubagentStartData {
  session_id: string;
  agent_id: string;
  agent_type: string;
}

export interface SubagentStopData {
  session_id: string;
  agent_id: string;
  transcript?: string;
}

export interface PreCompactData {
  session_id: string;
  trigger: string;
}

export interface PermissionRequestData {
  session_id: string;
  tool: string;
  suggestions?: string[];
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
  | Record<string, unknown>;

// Session state in concentrator
export interface Session {
  id: string;
  cwd: string;
  model?: string;
  args?: string[];
  transcriptPath?: string;
  startedAt: number;
  lastActivity: number;
  status: "active" | "idle" | "ended";
  events: HookEvent[];
}

// Configuration
export const DEFAULT_CONCENTRATOR_URL = "ws://localhost:9999";
export const DEFAULT_CONCENTRATOR_PORT = 9999;
export const HEARTBEAT_INTERVAL_MS = 30000;
export const IDLE_TIMEOUT_MS = 60000;
