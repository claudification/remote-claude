import { Menu } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Header } from '@/components/header'
import { SessionDetail } from '@/components/session-detail'
import { SessionList } from '@/components/session-list'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { fetchSessionEvents, fetchSessions, fetchTranscript, useSessionsStore } from '@/hooks/use-sessions'

export function App() {
	const [sheetOpen, setSheetOpen] = useState(false)
	const { setSessions, selectedSessionId, setEvents, setTranscript, setConnected } = useSessionsStore()

	const refresh = useCallback(async () => {
		try {
			const sessions = await fetchSessions()
			setSessions(sessions)
			setConnected(true)

			if (selectedSessionId) {
				const [events, transcript] = await Promise.all([
					fetchSessionEvents(selectedSessionId),
					fetchTranscript(selectedSessionId),
				])
				setEvents(selectedSessionId, events)
				setTranscript(selectedSessionId, transcript)
			}
		} catch {
			setConnected(false)
		}
	}, [selectedSessionId, setSessions, setEvents, setTranscript, setConnected])

	useEffect(() => {
		refresh()
		const interval = setInterval(refresh, 2000)
		return () => clearInterval(interval)
	}, [refresh])

	// Close sheet when a session is selected (mobile UX)
	useEffect(() => {
		if (selectedSessionId) {
			setSheetOpen(false)
		}
	}, [selectedSessionId])

	return (
		<div className="min-h-screen p-2 sm:p-4 max-w-[1400px] mx-auto">
			{/* Header with mobile menu */}
			<div className="flex items-center gap-2 mb-4">
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
			<div className="flex gap-4 h-[calc(100vh-140px)] sm:h-[calc(100vh-160px)]">
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
