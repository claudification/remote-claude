import { Menu } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AuthGate } from '@/components/auth-gate'
import { Header } from '@/components/header'
import { SessionDetail } from '@/components/session-detail'
import { SessionList } from '@/components/session-list'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { fetchSessionEvents, fetchTranscript, useSessionsStore } from '@/hooks/use-sessions'
import { useWebSocket } from '@/hooks/use-websocket'

function Dashboard() {
	const [sheetOpen, setSheetOpen] = useState(false)
	const [errorExpanded, setErrorExpanded] = useState(false)
	const { selectedSessionId, setEvents, setTranscript, error } = useSessionsStore()

	// Auto-expand on new error, auto-collapse after 4s
	useEffect(() => {
		if (!error) { setErrorExpanded(false); return }
		setErrorExpanded(true)
		const t = setTimeout(() => setErrorExpanded(false), 4000)
		return () => clearTimeout(t)
	}, [error])

	// Connect to WebSocket for real-time session updates
	useWebSocket()

	// Fetch initial events when session is selected (updates come via WebSocket)
	useEffect(() => {
		if (!selectedSessionId) return
		fetchSessionEvents(selectedSessionId).then(events => setEvents(selectedSessionId, events))
	}, [selectedSessionId, setEvents])

	// Poll transcript (reads from JSONL file, not pushed via WS)
	useEffect(() => {
		if (!selectedSessionId) return

		const loadTranscript = () => {
			fetchTranscript(selectedSessionId).then(transcript => setTranscript(selectedSessionId, transcript))
		}

		loadTranscript()
		const interval = setInterval(loadTranscript, 3000)
		return () => clearInterval(interval)
	}, [selectedSessionId, setTranscript])

	// Close sheet when a session is selected (mobile UX)
	useEffect(() => {
		if (selectedSessionId) {
			setSheetOpen(false)
		}
	}, [selectedSessionId])

	return (
		<div className="h-screen flex flex-col p-2 sm:p-4 max-w-[1400px] mx-auto overflow-hidden">
			{/* Error indicator */}
			{error && (
				errorExpanded ? (
					<div
						className="mb-2 px-3 py-2 border border-red-500/50 bg-red-500/10 text-red-400 font-mono text-xs shrink-0 cursor-pointer"
						onClick={() => setErrorExpanded(false)}
					>
						[ERROR] {error}
					</div>
				) : (
					<div
						className="mb-1 flex items-center gap-1.5 cursor-pointer shrink-0"
						onClick={() => setErrorExpanded(true)}
					>
						<span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
						<span className="text-red-400 font-mono text-[10px]">ERR</span>
					</div>
				)
			)}

			{/* Header with mobile menu */}
			<div className="flex items-center gap-2 mb-4 shrink-0">
				{/* Mobile menu button */}
				<Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
					<SheetTrigger asChild>
						<Button variant="outline" size="icon" className="lg:hidden shrink-0">
							<Menu className="h-5 w-5" />
							<span className="sr-only">Toggle sessions</span>
						</Button>
					</SheetTrigger>
					<SheetContent side="left" className="w-[320px] sm:w-[380px] p-0">
						<SheetHeader className="p-3 border-b border-border bg-card">
							<SheetTitle className="text-primary font-bold text-sm text-left">[ SESSIONS ]</SheetTitle>
						</SheetHeader>
						<div className="flex-1 overflow-y-auto p-2 h-[calc(100vh-60px)]">
							<SessionList />
						</div>
					</SheetContent>
				</Sheet>

				<div className="flex-1">
					<Header />
				</div>
			</div>

			{/* Main content */}
			<div className="flex gap-4 flex-1 min-h-0">
				{/* Desktop sidebar */}
				<div className="hidden lg:flex w-[350px] shrink-0 border border-border overflow-hidden flex-col">
					<div className="p-3 border-b border-border bg-card text-primary font-bold text-sm">[ SESSIONS ]</div>
					<div className="flex-1 overflow-y-auto p-2">
						<SessionList />
					</div>
				</div>

				{/* Detail panel */}
				<div className="flex-1 border border-border overflow-hidden flex flex-col min-w-0">
					<div className="p-3 border-b border-border bg-card text-primary font-bold text-sm">[ DETAILS ]</div>
					<div className="flex-1 overflow-hidden">
						<SessionDetail />
					</div>
				</div>
			</div>
		</div>
	)
}

export function App() {
	return (
		<AuthGate>
			<Dashboard />
		</AuthGate>
	)
}
