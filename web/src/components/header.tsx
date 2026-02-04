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

	return (
		<header className="border border-border p-3 sm:p-4 font-mono">
			{/* Desktop: Full ASCII logo */}
			<pre className="hidden md:block text-primary text-xs leading-tight whitespace-pre">{ASCII_LOGO}</pre>

			{/* Mobile: Compact title */}
			<div className="md:hidden text-primary font-bold text-lg">CLAUDE CONCENTRATOR</div>

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
