import type { HookEvent } from '@/lib/types'
import { cn, truncate } from '@/lib/utils'

function getEventColor(hookEvent: string): string {
	switch (hookEvent) {
		case 'SessionStart':
		case 'SessionEnd':
			return 'border-event-session text-event-session'
		case 'PreToolUse':
		case 'PostToolUse':
		case 'PostToolUseFailure':
			return 'border-event-tool text-event-tool'
		case 'UserPromptSubmit':
			return 'border-event-prompt text-event-prompt'
		case 'Stop':
			return 'border-event-stop text-event-stop'
		default:
			return 'border-event-notification text-event-notification'
	}
}

function renderEventContent(event: HookEvent) {
	const data = (event.data || {}) as Record<string, unknown>

	switch (event.hookEvent) {
		case 'SessionStart':
			return (
				<div className="mt-2 text-xs space-y-1 bg-background/50 p-2 rounded">
					<div>
						<span className="text-muted-foreground">source: </span>
						<span className="text-accent">{String(data.source || 'unknown')}</span>
					</div>
					{data.model ? (
						<div>
							<span className="text-muted-foreground">model: </span>
							<span>{String(data.model)}</span>
						</div>
					) : null}
				</div>
			)

		case 'UserPromptSubmit':
			return (
				<div className="mt-2 text-xs bg-background/50 p-2 rounded">
					<div className="text-event-prompt whitespace-pre-wrap break-words">{String(data.prompt || '')}</div>
				</div>
			)

		case 'PreToolUse':
		case 'PostToolUse': {
			const toolInput = (data.tool_input || {}) as Record<string, unknown>
			const toolResponse = data.tool_response as Record<string, unknown> | string | undefined
			let output = ''
			if (typeof toolResponse === 'string') {
				output = toolResponse
			} else if (toolResponse && (toolResponse.stdout || toolResponse.stderr)) {
				output = String(toolResponse.stdout || '') + (toolResponse.stderr ? `\n[stderr] ${toolResponse.stderr}` : '')
			}

			return (
				<div className="mt-2 text-xs space-y-1 bg-background/50 p-2 rounded">
					<div>
						<span className="text-muted-foreground">tool: </span>
						<span className="text-event-tool font-bold">{String(data.tool_name || '')}</span>
					</div>
					{toolInput.command ? (
						<div>
							<span className="text-muted-foreground">cmd: </span>
							<span className="text-accent">{String(toolInput.command)}</span>
						</div>
					) : null}
					{toolInput.file_path ? (
						<div>
							<span className="text-muted-foreground">file: </span>
							<span>{String(toolInput.file_path)}</span>
						</div>
					) : null}
					{toolInput.description ? (
						<div>
							<span className="text-muted-foreground">desc: </span>
							<span>{String(toolInput.description)}</span>
						</div>
					) : null}
					{output && (
						<div className="mt-2 p-2 bg-background text-muted-foreground max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
							{truncate(output, 500)}
						</div>
					)}
				</div>
			)
		}

		case 'Stop':
			return (
				<div className="mt-2 text-xs bg-background/50 p-2 rounded">
					<span className="text-muted-foreground">hook active: </span>
					<span>{data.stop_hook_active ? 'yes' : 'no'}</span>
				</div>
			)

		case 'Notification':
			return (
				<div className="mt-2 text-xs bg-background/50 p-2 rounded">
					<div className="text-muted-foreground italic">{String(data.message || '')}</div>
					{data.notification_type ? (
						<div className="mt-1">
							<span className="text-muted-foreground">type: </span>
							<span>{String(data.notification_type)}</span>
						</div>
					) : null}
				</div>
			)

		default:
			return null
	}
}

export function EventItem({ event }: { event: HookEvent }) {
	const colorClass = getEventColor(event.hookEvent)
	const time = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false })

	return (
		<div className={cn('p-3 border-l-4 bg-card mb-2', colorClass)}>
			<div className="flex items-center gap-3">
				<span className="text-muted-foreground text-[10px]">{time}</span>
				<span className={cn('font-bold text-xs', colorClass)}>{event.hookEvent}</span>
			</div>
			{renderEventContent(event)}
		</div>
	)
}
