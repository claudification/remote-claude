import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { useSessionsStore } from '@/hooks/use-sessions'

const ASCII_LOGO = `\u00A0██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
\u00A0╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝`

export function Header() {
	const [expanded, setExpanded] = useState(false)
	const { sessions, isConnected, agentConnected } = useSessionsStore()

	const active = sessions.filter(s => s.status === 'active').length
	const idle = sessions.filter(s => s.status === 'idle').length
	const ended = sessions.filter(s => s.status === 'ended').length
	const totalAgents = sessions.reduce((sum, s) => sum + (s.activeSubagentCount || 0), 0)
	const teamCount = sessions.filter(s => s.team).length

	return (
		<header
			className="border border-border p-2 sm:p-3 font-mono cursor-pointer select-none"
			onClick={() => setExpanded(!expanded)}
		>
			{expanded && (
				<pre className="hidden md:block text-primary text-xs leading-tight whitespace-pre mb-2">
					{ASCII_LOGO}
				</pre>
			)}

			{/* Stats row - always visible */}
			<div className="flex flex-wrap items-center gap-2 sm:gap-4 text-xs sm:text-sm">
				<span className="text-primary font-bold">CONCENTRATOR</span>
				<span className="text-muted-foreground">|</span>

				<div className="flex items-center gap-1 sm:gap-2">
					<Badge variant="outline" className="bg-active/20 text-active border-active/50 text-xs">
						{active} active
					</Badge>
					<Badge variant="outline" className="bg-idle/20 text-idle border-idle/50 text-xs">
						{idle} idle
					</Badge>
					<Badge variant="outline" className="bg-ended/20 text-ended border-ended/50 text-xs">
						{ended} ended
					</Badge>
					{totalAgents > 0 && (
						<Badge variant="outline" className="bg-pink-400/20 text-pink-400 border-pink-400/50 text-xs">
							{totalAgents} agent{totalAgents !== 1 ? 's' : ''}
						</Badge>
					)}
					{teamCount > 0 && (
						<Badge variant="outline" className="bg-purple-400/20 text-purple-400 border-purple-400/50 text-xs">
							{teamCount} team{teamCount !== 1 ? 's' : ''}
						</Badge>
					)}
				</div>

				<span className="text-muted-foreground">|</span>

				<span className={`text-xs sm:text-sm ${isConnected ? 'text-active' : 'text-destructive'}`}>
					{isConnected ? '● WS' : '○ WS'}
				</span>
				<span className={`text-xs sm:text-sm ${agentConnected ? 'text-active' : 'text-muted-foreground'}`}>
					{agentConnected ? '● Agent' : '○ Agent'}
				</span>
			</div>
		</header>
	)
}
