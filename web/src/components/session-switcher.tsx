import { useEffect, useRef, useState } from 'react'
import { useSessionsStore } from '@/hooks/use-sessions'
import { cn, lastPathSegments, formatAge } from '@/lib/utils'
import { canTerminal, type Session } from '@/lib/types'

interface SessionSwitcherProps {
	onSelect: (sessionId: string) => void
	onClose: () => void
}

export function SessionSwitcher({ onSelect, onClose }: SessionSwitcherProps) {
	const sessions = useSessionsStore(state => state.sessions)
	const selectedSessionId = useSessionsStore(state => state.selectedSessionId)
	const [filter, setFilter] = useState('')
	const [activeIndex, setActiveIndex] = useState(0)
	const inputRef = useRef<HTMLInputElement>(null)

	// Hide ended sessions if an active/idle session exists in the same cwd
	const activeCwds = new Set(sessions.filter(s => s.status !== 'ended').map(s => s.cwd))
	const deduplicated = sessions.filter(s => s.status !== 'ended' || !activeCwds.has(s.cwd))
	const allSessions = [...deduplicated].sort((a, b) => b.startedAt - a.startedAt)

	const filtered = filter
		? allSessions.filter(s => {
				const haystack = `${s.cwd} ${s.id} ${s.model || ''} ${s.status}`.toLowerCase()
				return filter
					.toLowerCase()
					.split(/\s+/)
					.every(word => haystack.includes(word))
			})
		: allSessions

	// Clamp active index
	useEffect(() => {
		if (activeIndex >= filtered.length) {
			setActiveIndex(Math.max(0, filtered.length - 1))
		}
	}, [filtered.length, activeIndex])

	// Focus input on mount
	useEffect(() => {
		inputRef.current?.focus()
	}, [])

	function handleKeyDown(e: React.KeyboardEvent) {
		switch (e.key) {
			case 'Escape':
				e.preventDefault()
				onClose()
				break
			case 'ArrowDown':
				e.preventDefault()
				setActiveIndex(i => Math.min(i + 1, filtered.length - 1))
				break
			case 'ArrowUp':
				e.preventDefault()
				setActiveIndex(i => Math.max(i - 1, 0))
				break
			case 'Enter':
				e.preventDefault()
				if (filtered[activeIndex]) {
					onSelect(filtered[activeIndex].id)
				}
				break
		}
	}

	function statusIndicator(s: Session) {
		if (canTerminal(s)) return '\u25B6' // ▶ terminal available
		if (s.id === selectedSessionId) return '\u25C9' // ◉ current
		if (s.status === 'active') return '\u25CF' // ●
		if (s.status === 'idle') return '\u25CB' // ○
		return '\u2716' // ✖ ended
	}

	function statusColor(s: Session) {
		if (canTerminal(s)) return s.status === 'active' ? 'text-[#9ece6a]' : 'text-[#e0af68]'
		if (s.id === selectedSessionId) return 'text-[#7aa2f7]'
		if (s.status === 'active') return 'text-[#9ece6a]'
		if (s.status === 'idle') return 'text-[#e0af68]'
		return 'text-[#565f89]'
	}

	function actionLabel(s: Session) {
		if (canTerminal(s)) return s.id === selectedSessionId ? 'TTY (current)' : 'TTY'
		if (s.status === 'ended') return 'revive'
		return ''
	}

	return (
		<div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]" onClick={onClose}>
			<div
				className="w-full max-w-lg bg-[#16161e] border border-[#33467c] shadow-2xl font-mono"
				onClick={e => e.stopPropagation()}
			>
				{/* Search input */}
				<div className="px-3 py-2 border-b border-[#33467c]">
					<input
						ref={inputRef}
						type="text"
						value={filter}
						onChange={e => {
							setFilter(e.target.value)
							setActiveIndex(0)
						}}
						onKeyDown={handleKeyDown}
						placeholder="Switch terminal..."
						className="w-full bg-transparent text-sm text-[#a9b1d6] placeholder:text-[#565f89] outline-none"
						autoComplete="off"
						spellCheck={false}
					/>
				</div>

				{/* Session list */}
				<div className="max-h-[40vh] overflow-y-auto">
					{filtered.length === 0 && (
						<div className="px-3 py-4 text-center text-[10px] text-[#565f89]">
							{allSessions.length === 0 ? 'No sessions' : 'No matches'}
						</div>
					)}
					{filtered.map((session, i) => (
						<button
							key={session.id}
							type="button"
							onClick={() => onSelect(session.id)}
							onMouseEnter={() => setActiveIndex(i)}
							className={cn(
								'w-full px-3 py-2 flex items-center gap-3 text-left transition-colors',
								i === activeIndex ? 'bg-[#33467c]/50' : 'hover:bg-[#33467c]/25',
							)}
						>
							<span className={cn('text-sm', statusColor(session))}>{statusIndicator(session)}</span>
							<div className="flex-1 min-w-0">
								<div className="text-xs text-[#a9b1d6] truncate">{lastPathSegments(session.cwd, 3)}</div>
								<div className="text-[10px] text-[#565f89] flex items-center gap-2">
									<span>{session.id.slice(0, 8)}</span>
									<span>{formatAge(session.lastActivity)}</span>
									{session.model && <span>{session.model.replace('claude-', '').replace(/-\d{8}$/, '')}</span>}
								</div>
							</div>
							{actionLabel(session) && (
								<span className={cn(
									'text-[10px]',
									canTerminal(session) ? 'text-[#9ece6a]' : 'text-[#565f89]',
								)}>
									{actionLabel(session)}
								</span>
							)}
						</button>
					))}
				</div>

				{/* Footer hints */}
				<div className="px-3 py-1.5 border-t border-[#33467c]/50 flex items-center gap-3 text-[10px] text-[#565f89]">
					<span>
						<kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">↑↓</kbd> navigate
					</span>
					<span>
						<kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">⏎</kbd> open terminal
					</span>
					<span>
						<kbd className="px-1 py-0.5 bg-[#33467c]/30 rounded">esc</kbd> close
					</span>
				</div>
			</div>
		</div>
	)
}
