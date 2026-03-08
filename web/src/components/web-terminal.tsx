import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { X, WifiOff } from 'lucide-react'
import { useSessionsStore, type TerminalMessage } from '@/hooks/use-sessions'
import { TerminalToolbar } from './terminal-toolbar'

interface WebTerminalProps {
	sessionId: string
	onClose: () => void
}

// Tokyo Night color scheme
const TOKYO_NIGHT_THEME = {
	background: '#1a1b26',
	foreground: '#a9b1d6',
	cursor: '#c0caf5',
	cursorAccent: '#1a1b26',
	selectionBackground: '#33467c',
	selectionForeground: '#c0caf5',
	black: '#15161e',
	red: '#f7768e',
	green: '#9ece6a',
	yellow: '#e0af68',
	blue: '#7aa2f7',
	magenta: '#bb9af7',
	cyan: '#7dcfff',
	white: '#a9b1d6',
	brightBlack: '#414868',
	brightRed: '#f7768e',
	brightGreen: '#9ece6a',
	brightYellow: '#e0af68',
	brightBlue: '#7aa2f7',
	brightMagenta: '#bb9af7',
	brightCyan: '#7dcfff',
	brightWhite: '#c0caf5',
}

export function WebTerminal({ sessionId, onClose }: WebTerminalProps) {
	const terminalRef = useRef<HTMLDivElement>(null)
	const xtermRef = useRef<Terminal | null>(null)
	const fitAddonRef = useRef<FitAddon | null>(null)
	const sendWsMessage = useSessionsStore(state => state.sendWsMessage)
	const setTerminalHandler = useSessionsStore(state => state.setTerminalHandler)
	const isConnected = useSessionsStore(state => state.isConnected)
	const [terminalError, setTerminalError] = useState<string | null>(null)

	const sendData = useCallback(
		(data: string) => {
			sendWsMessage({ type: 'terminal_data', sessionId, data })
		},
		[sendWsMessage, sessionId],
	)

	// Main terminal setup - runs once on mount
	useEffect(() => {
		if (!terminalRef.current) return

		const terminal = new Terminal({
			theme: TOKYO_NIGHT_THEME,
			fontFamily: '"Geist Mono", "Cascadia Code", "Fira Code", monospace',
			fontSize: 14,
			lineHeight: 1.2,
			cursorBlink: true,
			cursorStyle: 'block',
			allowProposedApi: true,
			scrollback: 5000,
		})

		const fitAddon = new FitAddon()
		terminal.loadAddon(fitAddon)

		terminal.open(terminalRef.current)

		// Try WebGL renderer for performance
		try {
			const webglAddon = new WebglAddon()
			webglAddon.onContextLoss(() => webglAddon.dispose())
			terminal.loadAddon(webglAddon)
		} catch {
			// WebGL not available, canvas renderer is fine
		}

		fitAddon.fit()
		xtermRef.current = terminal
		fitAddonRef.current = fitAddon

		// Forward user keystrokes to PTY
		const dataDisposable = terminal.onData(data => {
			sendWsMessage({ type: 'terminal_data', sessionId, data })
		})

		// Subscribe to incoming terminal messages
		const handler = (msg: TerminalMessage) => {
			if (msg.sessionId !== sessionId) return
			if (msg.type === 'terminal_data' && msg.data) {
				terminal.write(msg.data)
			} else if (msg.type === 'terminal_error') {
				setTerminalError(msg.error || 'Connection lost')
			}
		}
		setTerminalHandler(handler)

		// Resize handling
		const resizeObserver = new ResizeObserver(() => {
			fitAddon.fit()
			const { cols, rows } = terminal
			sendWsMessage({ type: 'terminal_resize', sessionId, cols, rows })
		})
		resizeObserver.observe(terminalRef.current)

		// Focus terminal
		terminal.focus()

		return () => {
			resizeObserver.disconnect()
			dataDisposable.dispose()
			setTerminalHandler(null)
			sendWsMessage({ type: 'terminal_detach', sessionId })
			terminal.dispose()
			xtermRef.current = null
			fitAddonRef.current = null
		}
	}, [sessionId, sendWsMessage, setTerminalHandler])

	// Re-attach when WS reconnects
	useEffect(() => {
		if (!isConnected || !xtermRef.current) return

		// Clear any previous error - we're reconnecting
		setTerminalError(null)

		const terminal = xtermRef.current
		const { cols, rows } = terminal
		sendWsMessage({ type: 'terminal_attach', sessionId, cols, rows })
	}, [isConnected, sessionId, sendWsMessage])

	// Handle Ctrl+Shift+Q to close
	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if (e.ctrlKey && e.shiftKey && e.key === 'Q') {
				e.preventDefault()
				onClose()
			}
		}
		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [onClose])

	const showDisconnected = !isConnected || !!terminalError

	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-[#1a1b26]">
			{/* Header bar */}
			<div className="shrink-0 flex items-center justify-between px-3 py-1.5 bg-[#16161e] border-b border-[#33467c]">
				<div className="flex items-center gap-2">
					{showDisconnected && <WifiOff className="w-3 h-3 text-[#f7768e]" />}
					<span className="text-[10px] font-mono text-[#565f89]">
						TERMINAL - {sessionId.slice(0, 8)}...
					</span>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-[10px] font-mono text-[#565f89]">Ctrl+Shift+Q to close</span>
					<button
						type="button"
						onClick={onClose}
						className="p-1 text-[#565f89] hover:text-[#a9b1d6] transition-colors"
						title="Close terminal"
					>
						<X className="w-4 h-4" />
					</button>
				</div>
			</div>

			{/* Disconnected / error banner */}
			{showDisconnected && (
				<div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-[#f7768e]/10 border-b border-[#f7768e]/30">
					<WifiOff className="w-3.5 h-3.5 text-[#f7768e]" />
					<span className="text-xs font-mono text-[#f7768e]">
						{terminalError || 'Disconnected - waiting for reconnect...'}
					</span>
				</div>
			)}

			{/* Terminal area */}
			<div ref={terminalRef} className="flex-1 min-h-0 p-1" />

			{/* Shortcut toolbar */}
			<TerminalToolbar onSend={sendData} />
		</div>
	)
}
