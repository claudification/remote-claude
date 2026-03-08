import { create } from 'zustand'
import type { HookEvent, Session, SubagentInfo, TranscriptEntry } from '@/lib/types'

interface SessionsState {
	sessions: Session[]
	selectedSessionId: string | null
	events: Record<string, HookEvent[]>
	transcripts: Record<string, TranscriptEntry[]>
	isConnected: boolean
	error: string | null

	setSessions: (sessions: Session[]) => void
	selectSession: (id: string | null) => void
	setEvents: (sessionId: string, events: HookEvent[]) => void
	setTranscript: (sessionId: string, entries: TranscriptEntry[]) => void
	setConnected: (connected: boolean) => void
	setError: (error: string | null) => void

	getSelectedSession: () => Session | undefined
	getSelectedEvents: () => HookEvent[]
	getSelectedTranscript: () => TranscriptEntry[]
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
	sessions: [],
	selectedSessionId: null,
	events: {},
	transcripts: {},
	isConnected: false,
	error: null,

	setSessions: sessions => set({ sessions }),
	selectSession: id => set({ selectedSessionId: id }),
	setEvents: (sessionId, events) => set(state => ({ events: { ...state.events, [sessionId]: events } })),
	setTranscript: (sessionId, entries) =>
		set(state => ({ transcripts: { ...state.transcripts, [sessionId]: entries } })),
	setConnected: connected => set({ isConnected: connected }),
	setError: error => set({ error }),

	getSelectedSession: () => {
		const { sessions, selectedSessionId } = get()
		return sessions.find(s => s.id === selectedSessionId)
	},
	getSelectedEvents: () => {
		const { events, selectedSessionId } = get()
		return selectedSessionId ? events[selectedSessionId] || [] : []
	},
	getSelectedTranscript: () => {
		const { transcripts, selectedSessionId } = get()
		return selectedSessionId ? transcripts[selectedSessionId] || [] : []
	},
}))

const API_BASE = ''

export async function fetchSessionEvents(sessionId: string): Promise<HookEvent[]> {
	const res = await fetch(`${API_BASE}/sessions/${sessionId}/events?limit=200`)
	if (!res.ok) throw new Error('Failed to fetch events')
	return res.json()
}

export async function fetchTranscript(sessionId: string): Promise<TranscriptEntry[]> {
	const res = await fetch(`${API_BASE}/sessions/${sessionId}/transcript?limit=500`)
	if (!res.ok) return []
	return res.json()
}

export async function fetchSubagents(sessionId: string): Promise<SubagentInfo[]> {
	const res = await fetch(`${API_BASE}/sessions/${sessionId}/subagents`)
	if (!res.ok) return []
	return res.json()
}

export async function sendInput(sessionId: string, input: string): Promise<boolean> {
	const res = await fetch(`${API_BASE}/sessions/${sessionId}/input`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ input }),
	})
	return res.ok
}
