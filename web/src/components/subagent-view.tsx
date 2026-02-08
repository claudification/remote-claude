import { useEffect, useState } from 'react'
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

				return (
					<div key={agent.agentId} className="flex items-center gap-2 mb-1">
						<span className="text-muted-foreground">{prefix}</span>
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
					</div>
				)
			})}

			<div className="text-muted-foreground mt-3 border-t border-border pt-2">
				{subagents.length} total | {running} running | {stopped} stopped
			</div>
		</div>
	)
}
