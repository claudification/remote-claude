import { Badge } from '@/components/ui/badge'
import { useSessionsStore } from '@/hooks/use-sessions'

const ASCII_LOGO = `\u00A0██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
\u00A0╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝`

export function Header() {
	const { sessions, isConnected } = useSessionsStore()

	const active = sessions.filter(s => s.status === 'active').length
	const idle = sessions.filter(s => s.status === 'idle').length
	const ended = sessions.filter(s => s.status === 'ended').length
	const totalAgents = sessions.reduce((sum, s) => sum + (s.activeSubagentCount || 0), 0)
	const teamCount = sessions.filter(s => s.team).length

	return (
		<header className="border border-border p-3 sm:p-4 font-mono">
			{/* Full ASCII logo: shown on md+ width AND 600px+ height */}
			<pre className="hidden md:block [@media(max-height:599px)]:!hidden text-primary text-xs leading-tight whitespace-pre">
				{ASCII_LOGO}
			</pre>

			{/* Compact title: shown on small width OR short screens */}
			<div className="md:hidden [@media(max-height:599px)]:!block text-primary font-bold text-lg">
				CLAUDE CONCENTRATOR
			</div>

			{/* Stats row */}
			<div className="mt-2 flex flex-wrap items-center gap-2 sm:gap-4 text-xs sm:text-sm">
				<span className="hidden sm:inline text-accent">CONCENTRATOR</span>
				<span className="hidden sm:inline text-muted-foreground">|</span>

				{/* Session counts as badges on mobile, inline on desktop */}
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

				<span className="hidden sm:inline text-muted-foreground">|</span>

				{/* Connection status */}
				<span className={`text-xs sm:text-sm ${isConnected ? 'text-active' : 'text-destructive'}`}>
					{isConnected ? '● Connected' : '○ Disconnected'}
				</span>
			</div>
		</header>
	)
}
