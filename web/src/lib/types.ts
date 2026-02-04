export interface Session {
	id: string
	cwd: string
	model?: string
	status: 'active' | 'idle' | 'ended'
	startedAt: number
	lastActivity: number
	eventCount: number
	lastEvent?: {
		hookEvent: string
		timestamp: number
	}
}

export interface HookEvent {
	type: 'hook'
	sessionId: string
	hookEvent: HookEventType
	timestamp: number
	data: Record<string, unknown>
}

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

export interface TranscriptContentBlock {
	type: 'text' | 'tool_use' | 'thinking' | 'tool_result' | string
	text?: string
	name?: string
	id?: string // tool_use id
	input?: Record<string, unknown>
	// For tool_result blocks
	tool_use_id?: string
	content?: string | unknown
}

export interface TranscriptEntry {
	type: string
	timestamp?: string
	message?: {
		role?: string
		content?: string | TranscriptContentBlock[]
	}
	data?: Record<string, unknown>
	// Rich tool result data from Claude Code
	toolUseResult?: {
		filePath?: string
		oldString?: string
		newString?: string
		structuredPatch?: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }>
	}
}

export type WSMessage =
	| { type: 'sessions'; data: Session[] }
	| { type: 'session_update'; data: Session }
	| { type: 'event'; data: HookEvent }
