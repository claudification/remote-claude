/**
 * WebSocket hook for real-time updates from concentrator
 */
import { useEffect, useRef, useCallback } from 'react'
import { useSessionsStore } from './use-sessions'
import type { HookEvent, Session } from '@/lib/types'

interface SessionSummary {
	id: string
	cwd: string
	model?: string
	startedAt: number
	lastActivity: number
	status: Session['status']
	eventCount: number
	activeSubagentCount?: number
	totalSubagentCount?: number
	team?: { teamName: string; role: 'lead' | 'teammate' }
}

interface DashboardMessage {
	type: 'sessions_list' | 'session_created' | 'session_ended' | 'session_update' | 'event' | 'agent_status'
	sessionId?: string
	session?: SessionSummary
	sessions?: SessionSummary[]
	event?: HookEvent
	connected?: boolean
}

const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
const RECONNECT_DELAY_MS = 2000

export function useWebSocket() {
	const wsRef = useRef<WebSocket | null>(null)
	const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	const { setSessions, setConnected, setAgentConnected, setError } = useSessionsStore()

	// Convert SessionSummary to Session (for store compatibility)
	const toSession = useCallback((summary: SessionSummary): Session => ({
		id: summary.id,
		cwd: summary.cwd,
		model: summary.model,
		startedAt: summary.startedAt,
		lastActivity: summary.lastActivity,
		status: summary.status,
		eventCount: summary.eventCount,
		activeSubagentCount: summary.activeSubagentCount ?? 0,
		totalSubagentCount: summary.totalSubagentCount ?? 0,
		team: summary.team,
	}), [])

	const connect = useCallback(() => {
		// Don't reconnect if already connected
		if (wsRef.current?.readyState === WebSocket.OPEN) return

		try {
			const ws = new WebSocket(WS_URL)
			wsRef.current = ws

			ws.onopen = () => {
				setConnected(true)
				setError(null)
				// Subscribe to dashboard updates
				ws.send(JSON.stringify({ type: 'subscribe' }))
			}

			ws.onclose = (e) => {
				setConnected(false)
				wsRef.current = null

				if (e.code === 1008 || e.code === 4401) {
					setError(`WebSocket rejected: ${e.reason || 'Unauthorized'}`)
				} else if (e.code !== 1000) {
					setError(`WebSocket closed (${e.code}${e.reason ? ': ' + e.reason : ''})`)
				}

				// Schedule reconnection
				if (!reconnectTimeoutRef.current) {
					reconnectTimeoutRef.current = setTimeout(() => {
						reconnectTimeoutRef.current = null
						connect()
					}, RECONNECT_DELAY_MS)
				}
			}

			ws.onerror = () => {
				setError(`WebSocket connection failed: ${WS_URL}`)
			}

			ws.onmessage = event => {
				try {
					const msg = JSON.parse(event.data) as DashboardMessage

					switch (msg.type) {
						case 'sessions_list': {
							// Initial load - full sessions list
							if (msg.sessions) {
								setSessions(msg.sessions.map(toSession))
							}
							break
						}
						case 'session_created': {
							// New session added
							if (msg.session) {
								const newSession = toSession(msg.session)
								useSessionsStore.setState(state => ({
									sessions: [...state.sessions, newSession],
								}))
							}
							break
						}
						case 'session_ended':
						case 'session_update': {
							// Session updated
							if (msg.session && msg.sessionId) {
								useSessionsStore.setState(state => ({
									sessions: state.sessions.map(s =>
										s.id === msg.sessionId ? { ...s, ...toSession(msg.session!) } : s,
									),
								}))
							}
							break
						}
						case 'event': {
							// New event for a session
							if (msg.event && msg.sessionId) {
								useSessionsStore.setState(state => {
									const currentEvents = state.events[msg.sessionId!] || []
									return {
										events: {
											...state.events,
											[msg.sessionId!]: [...currentEvents, msg.event!],
										},
									}
								})
							}
							break
						}
						case 'agent_status': {
							if (msg.connected !== undefined) {
								setAgentConnected(msg.connected)
							}
							break
						}
					}
				} catch {
					// Ignore parse errors
				}
			}
		} catch {
			// Connection failed, will retry
			setConnected(false)
		}
	}, [setConnected, setAgentConnected, setSessions, toSession])

	// Connect on mount
	useEffect(() => {
		connect()

		return () => {
			// Cleanup on unmount
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current)
			}
			if (wsRef.current) {
				wsRef.current.close()
			}
		}
	}, [connect])

	return {
		isConnected: wsRef.current?.readyState === WebSocket.OPEN,
	}
}
