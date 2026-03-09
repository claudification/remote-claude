import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { fetchSubagents, useSessionsStore } from '@/hooks/use-sessions'
import type { SubagentInfo, HookEvent } from '@/lib/types'
import { cn } from '@/lib/utils'

function formatDuration(startMs: number, endMs?: number): string {
	const diff = (endMs || Date.now()) - startMs
	const seconds = Math.floor(diff / 1000)
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	const remainSec = seconds % 60
	if (minutes < 60) return `${minutes}m ${remainSec}s`
	const hours = Math.floor(minutes / 60)
	return `${hours}h ${minutes % 60}m`
}

function agentTypeIcon(agentType: string): string {
	switch (agentType.toLowerCase()) {
		case 'bash': return '$'
		case 'explore': return '?'
		case 'plan': return '#'
		case 'general-purpose': return '*'
		case 'code-reviewer': return '!'
		case 'code-refactorer': return '~'
		case 'unit-test-runner': return 'T'
		case 'git-commit-master': return 'G'
		default: return '>'
	}
}

export function SubagentView({ sessionId }: { sessionId: string }) {
	const [subagents, setSubagents] = useState<SubagentInfo[]>([])
	const [loaded, setLoaded] = useState(false)

	const allEvents = useSessionsStore(state => state.events)
	const events = allEvents[sessionId] || []

	// Fetch subagents on mount
	useEffect(() => {
		fetchSubagents(sessionId).then(data => {
			setSubagents(data)
			setLoaded(true)
		})
	}, [sessionId])

	// Update from real-time events
	useEffect(() => {
		if (!loaded) return

		const agentEvents = events.filter(
			(e: HookEvent) => e.hookEvent === 'SubagentStart' || e.hookEvent === 'SubagentStop',
		)
		if (agentEvents.length === 0) return

		setSubagents(prev => {
			const updated = [...prev]
			for (const evt of agentEvents) {
				const data = evt.data as Record<string, unknown>
				const agentId = String(data.agent_id || '')
				if (!agentId) continue

				if (evt.hookEvent === 'SubagentStart') {
					if (!updated.find(a => a.agentId === agentId)) {
						updated.push({
							agentId,
							agentType: String(data.agent_type || 'unknown'),
							startedAt: evt.timestamp,
							status: 'running',
							events: [],
						})
					}
				} else if (evt.hookEvent === 'SubagentStop') {
					const agent = updated.find(a => a.agentId === agentId)
					if (agent) {
						agent.stoppedAt = evt.timestamp
						agent.status = 'stopped'
					}
				}
			}
			return updated
		})
	}, [events, loaded])

	const running = subagents.filter(a => a.status === 'running').length
	const stopped = subagents.filter(a => a.status === 'stopped').length
	const [expandedAgent, setExpandedAgent] = useState<string | null>(null)

	if (subagents.length === 0 && loaded) {
		return (
			<div className="h-full flex items-center justify-center text-muted-foreground">
				<pre className="text-xs" style={{ lineHeight: 0.95 }}>
					{`
┌───────────────────────────┐
│                           │
│   No sub-agents spawned   │
│                           │
└───────────────────────────┘
`.trim()}
				</pre>
			</div>
		)
	}

	return (
		<div className="h-full overflow-y-auto font-mono text-xs">
			<div className="text-muted-foreground mb-3">
				{'┌── AGENTS ─────────────────────────'}
			</div>
			<div className="text-muted-foreground mb-1">{'│'}</div>

			{subagents.map((agent, i) => {
				const isLast = i === subagents.length - 1
				const prefix = isLast ? '└─' : '├─'
				const isRunning = agent.status === 'running'
				const isExpanded = expandedAgent === agent.agentId
				const hasEvents = agent.events && agent.events.length > 0

				return (
					<div key={agent.agentId} className="mb-1">
						<button
							type="button"
							onClick={() => setExpandedAgent(isExpanded ? null : agent.agentId)}
							className="flex items-center gap-2 w-full text-left hover:bg-muted/20 rounded px-1 -mx-1 py-0.5"
						>
							<span className="text-muted-foreground">{prefix}</span>
							{hasEvents ? (
								isExpanded
									? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
									: <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
							) : (
								<span className="w-3" />
							)}
							<span
								className={cn(
									'px-1.5 py-0.5 text-[10px] font-bold uppercase',
									isRunning
										? 'bg-active/20 text-active border border-active/50'
										: 'bg-muted/30 text-muted-foreground border border-border',
								)}
							>
								{agent.status}
							</span>
							<span className="text-accent">{agentTypeIcon(agent.agentType)}</span>
							<span className={cn('font-bold', isRunning ? 'text-foreground' : 'text-muted-foreground')}>
								{agent.agentType}
							</span>
							<span className="text-muted-foreground text-[10px]">{agent.agentId.slice(0, 8)}</span>
							<span className="text-muted-foreground text-[10px]">
								({formatDuration(agent.startedAt, agent.stoppedAt)})
							</span>
							{hasEvents && (
								<span className="text-muted-foreground text-[10px]">
									[{agent.events.length} events]
								</span>
							)}
						</button>

						{/* Expanded event list */}
						{isExpanded && hasEvents && (
							<div className="ml-8 mt-1 mb-2 border-l border-border pl-3 space-y-0.5">
								{agent.events.map((evt, j) => (
									<SubagentEventLine key={j} event={evt} />
								))}
							</div>
						)}
					</div>
				)
			})}

			<div className="text-muted-foreground mt-3 border-t border-border pt-2">
				{subagents.length} total | {running} running | {stopped} stopped
			</div>
		</div>
	)
}

function getEventLabel(evt: HookEvent): { label: string; color: string } {
	const data = evt.data as Record<string, unknown>
	switch (evt.hookEvent) {
		case 'PreToolUse':
		case 'PostToolUse': {
			const tool = String(data.tool_name || 'Tool')
			const input = (data.tool_input || {}) as Record<string, unknown>
			let detail = ''
			if (tool === 'Bash') detail = String(input.command || '').slice(0, 50)
			else if (tool === 'Read' || tool === 'Write' || tool === 'Edit') {
				const p = String(input.file_path || '')
				detail = p.split('/').pop() || p
			}
			else if (tool === 'Grep') detail = String(input.pattern || '').slice(0, 30)
			const prefix = evt.hookEvent === 'PreToolUse' ? '>' : '<'
			return {
				label: `${prefix} ${tool}${detail ? ` ${detail}` : ''}`,
				color: evt.hookEvent === 'PreToolUse' ? 'text-cyan-400' : 'text-blue-400',
			}
		}
		case 'PostToolUseFailure':
			return { label: `! ${String(data.tool_name || 'Tool')} FAILED`, color: 'text-red-400' }
		default:
			return { label: evt.hookEvent, color: 'text-muted-foreground' }
	}
}

function SubagentEventLine({ event }: { event: HookEvent }) {
	const { label, color } = getEventLabel(event)
	const time = new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
	return (
		<div className="flex items-baseline gap-2 text-[10px]">
			<span className="text-muted-foreground shrink-0">{time}</span>
			<span className={cn('truncate', color)}>{label}</span>
		</div>
	)
}
