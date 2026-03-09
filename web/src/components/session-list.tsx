import { useState } from 'react'
import { fetchSessionEvents, fetchTranscript, useSessionsStore } from '@/hooks/use-sessions'
import type { Session } from '@/lib/types'
import { cn, formatAge, formatModel, lastPathSegments } from '@/lib/utils'
import { ProjectSettingsButton, ProjectSettingsEditor, renderProjectIcon } from './project-settings-editor'

function StatusIndicator({ status }: { status: Session['status'] }) {
	if (status === 'ended') {
		return (
			<span className="px-1.5 py-0.5 text-[10px] uppercase font-bold bg-ended text-foreground">
				ended
			</span>
		)
	}
	return (
		<span
			className={cn(
				'w-2 h-2 rounded-full shrink-0',
				status === 'active' && 'bg-active',
				status === 'idle' && 'bg-idle',
			)}
			title={status}
		/>
	)
}

function SessionItem({ session }: { session: Session }) {
	const { selectedSessionId, selectSession, openTab, setEvents, setTranscript, events, projectSettings } = useSessionsStore()
	const [showSettings, setShowSettings] = useState(false)
	const isSelected = selectedSessionId === session.id
	const cachedEvents = events[session.id] || []
	const model = cachedEvents.find(e => e.hookEvent === 'SessionStart' && e.data?.model)?.data?.model as
		| string
		| undefined
	const ps = projectSettings[session.cwd]

	async function handleClick() {
		selectSession(session.id)
		const [evts, transcript] = await Promise.all([fetchSessionEvents(session.id), fetchTranscript(session.id)])
		setEvents(session.id, evts)
		setTranscript(session.id, transcript)
	}

	const displayName = ps?.label || lastPathSegments(session.cwd)
	const displayColor = ps?.color

	return (
		<div>
			<button
				type="button"
				onClick={handleClick}
				className={cn(
					'w-full text-left p-3 border transition-colors',
					isSelected
						? 'border-accent bg-accent/15 ring-1 ring-accent/50 shadow-[0_0_8px_rgba(122,162,247,0.15)]'
						: displayColor
							? 'border-border hover:border-primary'
							: 'border-border hover:border-primary hover:bg-card',
				)}
				style={displayColor && !isSelected ? { borderLeftColor: displayColor, borderLeftWidth: '3px', backgroundColor: `${displayColor}15` } : undefined}
			>
				{/* Path - most important */}
				<div className="flex items-center gap-1.5">
					{ps?.icon && <span style={displayColor && !isSelected ? { color: displayColor } : undefined}>{renderProjectIcon(ps.icon)}</span>}
					<span className={cn('font-bold text-sm flex-1 truncate', isSelected ? 'text-accent' : 'text-primary')} style={displayColor && !isSelected ? { color: displayColor } : undefined}>{displayName}</span>
					<ProjectSettingsButton onClick={e => { e.stopPropagation(); setShowSettings(!showSettings) }} />
				</div>
				{/* Active tasks + working teammates */}
				{(session.activeTasks.length > 0 || session.teammates.some(t => t.status === 'working')) && (
					<div className="mt-1 space-y-0.5">
						{session.activeTasks.slice(0, 3).map(task => (
							<div key={task.id} className="text-[11px] text-active/80 font-mono truncate pl-1">
								<span className="text-active mr-1">{'\u25B8'}</span>
								{task.subject}
							</div>
						))}
						{session.activeTasks.length > 3 && (
							<div className="text-[10px] text-muted-foreground pl-1 font-mono">
								+{session.activeTasks.length - 3} more
							</div>
						)}
						{session.teammates.filter(t => t.status === 'working').map(t => (
							<div key={t.name} className="text-[11px] text-purple-400/80 font-mono truncate pl-1">
								<span className="text-purple-400 mr-1">{'\u2691'}</span>
								{t.name}{t.currentTaskSubject ? `: ${t.currentTaskSubject}` : ''}
							</div>
						))}
					</div>
				)}
				{/* Status row */}
				<div className="flex items-center gap-2 mt-2 text-xs flex-wrap">
					{session.status === 'ended' && <StatusIndicator status={session.status} />}
					<span className="text-muted-foreground">{formatAge(session.lastActivity)}</span>
					<span className="text-muted-foreground">{session.eventCount} events</span>
					<span className="text-event-tool">{formatModel(model || session.model)}</span>
					{session.activeSubagentCount > 0 && (
						<span
							className="px-1.5 py-0.5 bg-pink-400/20 text-pink-400 border border-pink-400/50 text-[10px] font-bold cursor-pointer hover:bg-pink-400/30"
							onClick={e => { e.stopPropagation(); openTab(session.id, 'agents') }}
						>
							{session.activeSubagentCount} agent{session.activeSubagentCount !== 1 ? 's' : ''}
						</span>
					)}
					{session.totalSubagentCount > 0 && session.activeSubagentCount === 0 && (
						<span
							className="px-1.5 py-0.5 bg-pink-400/10 text-pink-400/50 border border-pink-400/30 text-[10px] font-bold cursor-pointer hover:bg-pink-400/20"
							onClick={e => { e.stopPropagation(); openTab(session.id, 'agents') }}
						>
							{session.totalSubagentCount} agent{session.totalSubagentCount !== 1 ? 's' : ''}
						</span>
					)}
					{session.pendingTaskCount > 0 && (
						<span
							className="px-1.5 py-0.5 bg-amber-400/20 text-amber-400 border border-amber-400/50 text-[10px] font-bold cursor-pointer hover:bg-amber-400/30"
							onClick={e => { e.stopPropagation(); openTab(session.id, 'tasks') }}
						>
							[{session.pendingTaskCount}] task{session.pendingTaskCount !== 1 ? 's' : ''}
						</span>
					)}
					{session.runningBgTaskCount > 0 && (
						<span
							className="px-1.5 py-0.5 bg-emerald-400/20 text-emerald-400 border border-emerald-400/50 text-[10px] font-bold cursor-pointer hover:bg-emerald-400/30"
							onClick={e => { e.stopPropagation(); openTab(session.id, 'bg') }}
						>
							[{session.runningBgTaskCount}] bg
						</span>
					)}
					{session.team && (
						<span className="px-1.5 py-0.5 bg-purple-400/20 text-purple-400 border border-purple-400/50 text-[10px] font-bold uppercase">
							{session.team.role === 'lead' ? 'LEAD' : 'TEAM'} {session.team.teamName}
							{session.teammates.length > 0 && ` (${session.teammates.filter(t => t.status !== 'stopped').length}/${session.teammates.length})`}
						</span>
					)}
				</div>
			</button>
			{showSettings && (
				<ProjectSettingsEditor cwd={session.cwd} onClose={() => setShowSettings(false)} />
			)}
		</div>
	)
}

export function SessionList() {
	const { sessions } = useSessionsStore()
	const [showInactive, setShowInactive] = useState(false)

	const active = sessions.filter(s => s.status === 'active' || s.status === 'idle')
	const inactive = sessions.filter(s => s.status !== 'active' && s.status !== 'idle')

	const sorted = [...active].sort((a, b) => b.startedAt - a.startedAt)
	const sortedInactive = [...inactive].sort((a, b) => b.startedAt - a.startedAt)

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
			{inactive.length > 0 && (
				<label className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-xs cursor-pointer select-none">
					<input
						type="checkbox"
						checked={showInactive}
						onChange={e => setShowInactive(e.target.checked)}
						className="accent-primary"
					/>
					show inactive ({inactive.length})
				</label>
			)}
			{showInactive && sortedInactive.map(session => (
				<SessionItem key={session.id} session={session} />
			))}
		</div>
	)
}
