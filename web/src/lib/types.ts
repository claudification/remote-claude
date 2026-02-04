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
	type: 'text' | 'tool_use' | 'thinking' | string
	text?: string
	name?: string
	input?: Record<string, unknown>
}

export interface TranscriptEntry {
	type: string
	timestamp?: string
	message?: {
		role?: string
		content?: string | TranscriptContentBlock[]
	}
	data?: Record<string, unknown>
}

export type WSMessage =
	| { type: 'sessions'; data: Session[] }
	| { type: 'session_update'; data: Session }
	| { type: 'event'; data: HookEvent }
