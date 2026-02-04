import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { sendInput, useSessionsStore } from '@/hooks/use-sessions'
import { cn, formatAge, formatModel } from '@/lib/utils'
import { EventsView } from './events-view'
import { TranscriptView } from './transcript-view'

type Tab = 'transcript' | 'events'

export function SessionDetail() {
	const [activeTab, setActiveTab] = useState<Tab>('transcript')
	const [follow, setFollow] = useState(true)
	const [inputValue, setInputValue] = useState('')
	const [isSending, setIsSending] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)

	const sessions = useSessionsStore(state => state.sessions)
	const selectedSessionId = useSessionsStore(state => state.selectedSessionId)
	const allEvents = useSessionsStore(state => state.events)
	const allTranscripts = useSessionsStore(state => state.transcripts)

	// Derive values from raw state (no new object creation in selector)
	const session = sessions.find(s => s.id === selectedSessionId)
	const events = selectedSessionId ? allEvents[selectedSessionId] || [] : []
	const transcript = selectedSessionId ? allTranscripts[selectedSessionId] || [] : []

	if (!session) {
		return (
			<div className="flex items-center justify-center h-full text-muted-foreground">
				<pre className="text-xs" style={{ lineHeight: 0.95 }}>
					{`
┌───────────────────────────┐
│                           │
│   Select a session to     │
│   view details            │
│                           │
│   _                       │
│                           │
└───────────────────────────┘
`.trim()}
				</pre>
			</div>
		)
	}

	const model = events.find(e => e.hookEvent === 'SessionStart' && e.data?.model)?.data?.model as string | undefined

	async function handleSendInput() {
		if (!selectedSessionId || !inputValue.trim() || isSending) return

		setIsSending(true)
		try {
			const success = await sendInput(selectedSessionId, inputValue)
			if (success) {
				setInputValue('')
				inputRef.current?.focus()
			}
		} finally {
			setIsSending(false)
		}
	}

	function handleKeyDown(e: React.KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			handleSendInput()
		}
	}

	const canSendInput = session?.status === 'active' || session?.status === 'idle'

	return (
		<div className="h-full flex flex-col">
			{/* Session Info */}
			<div className="p-3 sm:p-4 border-b border-border">
				<h3 className="text-accent text-xs uppercase tracking-wider mb-3">Session Info</h3>
				<dl className="grid grid-cols-[80px_1fr] sm:grid-cols-[100px_1fr] gap-x-2 sm:gap-x-4 gap-y-1 text-xs">
					<dt className="text-muted-foreground">ID</dt>
					<dd className="text-foreground break-all font-mono text-[10px]">{session.id}</dd>
					<dt className="text-muted-foreground">Status</dt>
					<dd>
						<span
							className={cn(
								'px-2 py-0.5 text-[10px] uppercase font-bold',
								session.status === 'active' && 'bg-active text-background',
								session.status === 'idle' && 'bg-idle text-background',
								session.status === 'ended' && 'bg-ended text-foreground',
							)}
						>
							{session.status}
						</span>
					</dd>
					<dt className="text-muted-foreground">CWD</dt>
					<dd className="text-foreground break-all">{session.cwd}</dd>
					<dt className="text-muted-foreground">Model</dt>
					<dd className="text-foreground">{formatModel(model || session.model)}</dd>
					<dt className="text-muted-foreground">Started</dt>
					<dd className="text-foreground">{new Date(session.startedAt).toLocaleString()}</dd>
					<dt className="text-muted-foreground">Activity</dt>
					<dd className="text-foreground">{formatAge(session.lastActivity)}</dd>
					<dt className="text-muted-foreground">Events</dt>
					<dd className="text-foreground">{session.eventCount}</dd>
				</dl>
			</div>

			{/* Tabs with follow checkbox */}
			<div className="flex items-center border-b border-border">
				<button
					type="button"
					onClick={() => setActiveTab('transcript')}
					className={cn(
						'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
						activeTab === 'transcript'
							? 'border-accent text-accent'
							: 'border-transparent text-muted-foreground hover:text-foreground',
					)}
				>
					Transcript
				</button>
				<button
					type="button"
					onClick={() => setActiveTab('events')}
					className={cn(
						'px-3 sm:px-4 py-2 text-xs border-b-2 transition-colors',
						activeTab === 'events'
							? 'border-accent text-accent'
							: 'border-transparent text-muted-foreground hover:text-foreground',
					)}
				>
					Events
				</button>

				{/* Follow checkbox - pushed to right */}
				<div className="ml-auto pr-3 flex items-center gap-2">
					<Checkbox
						id="follow"
						checked={follow}
						onCheckedChange={checked => setFollow(checked === true)}
						className="h-3.5 w-3.5"
					/>
					<label htmlFor="follow" className="text-[10px] text-muted-foreground cursor-pointer select-none">
						follow
					</label>
				</div>
			</div>

			{/* Content */}
			{activeTab === 'transcript' && (
				<div className="flex-1 min-h-0 p-3 sm:p-4">
					<TranscriptView entries={transcript} follow={follow} />
				</div>
			)}
			{activeTab === 'events' && (
				<div className="flex-1 min-h-0 p-3 sm:p-4">
					<EventsView events={events} follow={follow} />
				</div>
			)}

			{/* Input box */}
			{canSendInput && (
				<div className="p-3 border-t border-border">
					<div className="flex gap-2">
						<input
							ref={inputRef}
							type="text"
							value={inputValue}
							onChange={e => setInputValue(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Send input to session..."
							disabled={isSending}
							className={cn(
								'flex-1 bg-input border border-border rounded px-3 py-2',
								'text-xs font-mono text-foreground placeholder:text-muted-foreground',
								'focus:outline-none focus:ring-1 focus:ring-ring',
								'disabled:opacity-50',
							)}
						/>
						<Button onClick={handleSendInput} disabled={isSending || !inputValue.trim()} size="sm" className="text-xs">
							{isSending ? '...' : 'Send'}
						</Button>
					</div>
					<p className="text-[10px] text-muted-foreground mt-1">Press Enter to send</p>
				</div>
			)}
		</div>
	)
}
