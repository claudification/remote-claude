export interface SubagentInfo {
	agentId: string
	agentType: string
	startedAt: number
	stoppedAt?: number
	status: 'running' | 'stopped'
	transcriptPath?: string
}

export interface TeamInfo {
	teamName: string
	role: 'lead' | 'teammate'
}

export type WrapperCapability = 'terminal'

export interface Session {
	id: string
	cwd: string
	model?: string
	capabilities?: WrapperCapability[]
	status: 'active' | 'idle' | 'ended'
	startedAt: number
	lastActivity: number
	eventCount: number
	activeSubagentCount: number
	totalSubagentCount: number
	team?: TeamInfo
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
	| 'TeammateIdle'
	| 'TaskCompleted'
	| 'Setup'

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
	// Rich tool result data from Claude Code
	toolUseResult?: {
		filePath?: string
		oldString?: string
		newString?: string
		structuredPatch?: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }>
	}
	// Images detected in this entry (added by concentrator)
	images?: TranscriptImage[]
}

export type WSMessage =
	| { type: 'sessions'; data: Session[] }
	| { type: 'session_update'; data: Session }
	| { type: 'event'; data: HookEvent }
