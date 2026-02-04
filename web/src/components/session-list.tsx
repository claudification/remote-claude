import { fetchSessionEvents, fetchTranscript, useSessionsStore } from '@/hooks/use-sessions'
import type { Session } from '@/lib/types'
import { cn, formatAge, formatModel, lastPathSegments } from '@/lib/utils'

function StatusBadge({ status }: { status: Session['status'] }) {
	return (
		<span
			className={cn(
				'px-2 py-0.5 text-[10px] uppercase font-bold',
				status === 'active' && 'bg-active text-background',
				status === 'idle' && 'bg-idle text-background',
				status === 'ended' && 'bg-ended text-foreground',
			)}
		>
			{status}
		</span>
	)
}

function SessionItem({ session }: { session: Session }) {
	const { selectedSessionId, selectSession, setEvents, setTranscript, events } = useSessionsStore()
	const isSelected = selectedSessionId === session.id
	const cachedEvents = events[session.id] || []
	const model = cachedEvents.find(e => e.hookEvent === 'SessionStart' && e.data?.model)?.data?.model as
		| string
		| undefined

	async function handleClick() {
		selectSession(session.id)
		const [evts, transcript] = await Promise.all([fetchSessionEvents(session.id), fetchTranscript(session.id)])
		setEvents(session.id, evts)
		setTranscript(session.id, transcript)
	}

	return (
		<button
			type="button"
			onClick={handleClick}
			className={cn(
				'w-full text-left p-3 border transition-colors',
				isSelected ? 'border-accent bg-accent/10' : 'border-border hover:border-primary hover:bg-card',
			)}
		>
			{/* Path - most important */}
			<div className="text-primary font-bold text-sm">{lastPathSegments(session.cwd)}</div>
			{/* Session ID - small */}
			<div className="text-muted-foreground text-[10px] mt-0.5 font-mono">{session.id.slice(0, 8)}</div>
			{/* Status row */}
			<div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
				<StatusBadge status={session.status} />
				<span className="text-muted-foreground">{formatAge(session.lastActivity)}</span>
				<span className="text-muted-foreground">{session.eventCount} events</span>
				<span className="text-event-tool">{formatModel(model || session.model)}</span>
			</div>
		</button>
	)
}

export function SessionList() {
	const { sessions } = useSessionsStore()

	const sorted = [...sessions].sort((a, b) => {
		const aActive = a.status === 'active'
		const bActive = b.status === 'active'

		// Active sessions first
		if (aActive && !bActive) return -1
		if (!aActive && bActive) return 1

		// Within active: sort by path name (alphabetical, stable)
		if (aActive && bActive) {
			return a.cwd.localeCompare(b.cwd)
		}

		// Within inactive: sort by last activity (most recent first)
		return b.lastActivity - a.lastActivity
	})

	if (sessions.length === 0) {
		return (
			<div className="text-muted-foreground text-center py-10">
				<pre className="text-xs mb-4">
					{`
  No sessions yet

  Start a session with:
  $ rclaude
`.trim()}
				</pre>
			</div>
		)
	}

	return (
		<div className="space-y-2">
			{sorted.map(session => (
				<SessionItem key={session.id} session={session} />
			))}
		</div>
	)
}
