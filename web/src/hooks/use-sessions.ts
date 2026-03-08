import { create } from 'zustand'
import type { HookEvent, Session, SubagentInfo, TranscriptEntry } from '@/lib/types'

export interface TerminalMessage {
	type: 'terminal_data' | 'terminal_error'
	sessionId: string
	data?: string
	error?: string
}

interface SessionsState {
	sessions: Session[]
	selectedSessionId: string | null
	events: Record<string, HookEvent[]>
	transcripts: Record<string, TranscriptEntry[]>
	isConnected: boolean
	agentConnected: boolean
	error: string | null
	ws: WebSocket | null
	terminalHandler: ((msg: TerminalMessage) => void) | null
	showTerminal: boolean
	showSwitcher: boolean

	setSessions: (sessions: Session[]) => void
	selectSession: (id: string | null) => void
	setShowTerminal: (show: boolean) => void
	setShowSwitcher: (show: boolean) => void
	toggleSwitcher: () => void
	openTerminal: (sessionId: string) => void
	setEvents: (sessionId: string, events: HookEvent[]) => void
	setTranscript: (sessionId: string, entries: TranscriptEntry[]) => void
	setConnected: (connected: boolean) => void
	setAgentConnected: (connected: boolean) => void
	setError: (error: string | null) => void
	setWs: (ws: WebSocket | null) => void
	setTerminalHandler: (handler: ((msg: TerminalMessage) => void) | null) => void
	sendWsMessage: (msg: Record<string, unknown>) => void

	getSelectedSession: () => Session | undefined
	getSelectedEvents: () => HookEvent[]
	getSelectedTranscript: () => TranscriptEntry[]
}

function updateHash(fragment: string) {
	const next = fragment ? `#${fragment}` : ''
	if (window.location.hash !== next) {
		history.replaceState(null, '', next || window.location.pathname)
	}
}

let hashApplied = false

export function applyHashRoute() {
	if (hashApplied) return
	hashApplied = true

	const hash = window.location.hash.slice(1)
	if (!hash) return

	const [mode, sessionId] = hash.split('/')
	if (!sessionId) return

	const store = useSessionsStore.getState()
	if (mode === 'terminal') {
		store.openTerminal(sessionId)
	} else if (mode === 'session') {
		store.selectSession(sessionId)
	}
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
	sessions: [],
	selectedSessionId: null,
	events: {},
	transcripts: {},
	isConnected: false,
	agentConnected: false,
	error: null,
	ws: null,
	terminalHandler: null,
	showTerminal: false,
	showSwitcher: false,

	setSessions: sessions => set({ sessions }),
	selectSession: id => {
		set({ selectedSessionId: id })
		updateHash(id ? `session/${id}` : '')
	},
	setShowTerminal: show => {
		set({ showTerminal: show })
		if (!show) {
			const { selectedSessionId } = get()
			updateHash(selectedSessionId ? `session/${selectedSessionId}` : '')
		}
	},
	setShowSwitcher: show => set({ showSwitcher: show }),
	toggleSwitcher: () => set(state => ({ showSwitcher: !state.showSwitcher })),
	openTerminal: sessionId => {
		set({ selectedSessionId: sessionId, showTerminal: true, showSwitcher: false })
		updateHash(`terminal/${sessionId}`)
	},
	setEvents: (sessionId, events) => set(state => ({ events: { ...state.events, [sessionId]: events } })),
	setTranscript: (sessionId, entries) =>
		set(state => ({ transcripts: { ...state.transcripts, [sessionId]: entries } })),
	setConnected: connected => set({ isConnected: connected }),
	setAgentConnected: connected => set({ agentConnected: connected }),
	setError: error => set({ error }),
	setWs: ws => set({ ws }),
	setTerminalHandler: handler => set({ terminalHandler: handler }),
	sendWsMessage: msg => {
		const { ws } = get()
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg))
		}
	},

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

export async function reviveSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
	const res = await fetch(`${API_BASE}/sessions/${sessionId}/revive`, { method: 'POST' })
	if (!res.ok) {
		const data = await res.json().catch(() => ({ error: 'Request failed' }))
		return { success: false, error: data.error || `HTTP ${res.status}` }
	}
	return { success: true }
}

export async function sendInput(sessionId: string, input: string): Promise<boolean> {
	const res = await fetch(`${API_BASE}/sessions/${sessionId}/input`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ input }),
	})
	return res.ok
}
