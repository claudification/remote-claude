import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { Settings, X, WifiOff } from 'lucide-react'
import { useSessionsStore, type TerminalMessage } from '@/hooks/use-sessions'
import { TerminalToolbar } from './terminal-toolbar'
import { SessionSwitcher } from './session-switcher'
import {
	TerminalSettingsPanel,
	loadTerminalSettings,
	saveTerminalSettings,
	getTheme,
	getFont,
	type TerminalSettings,
} from './terminal-settings'

interface WebTerminalProps {
	sessionId: string
	onClose: () => void
	onSwitchSession: (sessionId: string) => void
}

// Ref to track switcher state for the xterm key handler (can't use React state in there)
let switcherOpenRef = false

export function WebTerminal({ sessionId, onClose, onSwitchSession }: WebTerminalProps) {
	const terminalRef = useRef<HTMLDivElement>(null)
	const xtermRef = useRef<Terminal | null>(null)
	const fitAddonRef = useRef<FitAddon | null>(null)
	const sendWsMessage = useSessionsStore(state => state.sendWsMessage)
	const setTerminalHandler = useSessionsStore(state => state.setTerminalHandler)
	const isConnected = useSessionsStore(state => state.isConnected)
	const [terminalError, setTerminalError] = useState<string | null>(null)
	const [showSettings, setShowSettings] = useState(false)
	const [showSwitcher, setShowSwitcher] = useState(false)
	const [settings, setSettings] = useState<TerminalSettings>(loadTerminalSettings)

	// Keep module-level ref in sync
	useEffect(() => {
		switcherOpenRef = showSwitcher
	}, [showSwitcher])

	const sendData = useCallback(
		(data: string) => {
			sendWsMessage({ type: 'terminal_data', sessionId, data })
		},
		[sendWsMessage, sessionId],
	)

	function applySettings(terminal: Terminal, s: TerminalSettings) {
		const theme = getTheme(s.themeId)
		const font = getFont(s.fontId)
		terminal.options.theme = theme
		terminal.options.fontFamily = font.family
		terminal.options.fontSize = s.fontSize
		fitAddonRef.current?.fit()
	}

	function handleSettingsChange(newSettings: TerminalSettings) {
		setSettings(newSettings)
		saveTerminalSettings(newSettings)
		if (xtermRef.current) {
			applySettings(xtermRef.current, newSettings)
			const { cols, rows } = xtermRef.current
			sendWsMessage({ type: 'terminal_resize', sessionId, cols, rows })
		}
	}

	// Main terminal setup
	useEffect(() => {
		if (!terminalRef.current) return

		const initialSettings = loadTerminalSettings()
		const theme = getTheme(initialSettings.themeId)
		const font = getFont(initialSettings.fontId)

		const terminal = new Terminal({
			theme,
			fontFamily: font.family,
			fontSize: initialSettings.fontSize,
			lineHeight: 1.2,
			cursorBlink: true,
			cursorStyle: 'block',
			allowProposedApi: true,
			scrollback: 5000,
		})

		const fitAddon = new FitAddon()
		terminal.loadAddon(fitAddon)

		// Intercept global shortcuts before xterm processes them
		terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
			// Ctrl+K - session switcher (don't send to PTY)
			if (e.ctrlKey && e.key === 'k') return false
			// Ctrl+, - settings (don't send to PTY)
			if (e.ctrlKey && e.key === ',') return false
			// Ctrl+Shift+Q - close (don't send to PTY)
			if (e.ctrlKey && e.shiftKey && e.key === 'Q') return false
			// When switcher is open, eat all keys so they don't go to PTY
			if (switcherOpenRef) return false
			return true
		})

		terminal.open(terminalRef.current)

		try {
			const webglAddon = new WebglAddon()
			webglAddon.onContextLoss(() => webglAddon.dispose())
			terminal.loadAddon(webglAddon)
		} catch {
			// WebGL not available
		}

		fitAddon.fit()
		xtermRef.current = terminal
		fitAddonRef.current = fitAddon

		const dataDisposable = terminal.onData(data => {
			sendWsMessage({ type: 'terminal_data', sessionId, data })
		})

		const handler = (msg: TerminalMessage) => {
			if (msg.sessionId !== sessionId) return
			if (msg.type === 'terminal_data' && msg.data) {
				terminal.write(msg.data)
			} else if (msg.type === 'terminal_error') {
				setTerminalError(msg.error || 'Connection lost')
			}
		}
		setTerminalHandler(handler)

		const resizeObserver = new ResizeObserver(() => {
			fitAddon.fit()
			const { cols, rows } = terminal
			sendWsMessage({ type: 'terminal_resize', sessionId, cols, rows })
		})
		resizeObserver.observe(terminalRef.current)

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
		setTerminalError(null)
		const terminal = xtermRef.current
		const { cols, rows } = terminal
		sendWsMessage({ type: 'terminal_attach', sessionId, cols, rows })
	}, [isConnected, sessionId, sendWsMessage])

	// Global keyboard shortcuts
	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if (e.ctrlKey && e.shiftKey && e.key === 'Q') {
				e.preventDefault()
				onClose()
			}
			if (e.ctrlKey && e.key === ',') {
				e.preventDefault()
				setShowSettings(prev => !prev)
				setShowSwitcher(false)
			}
			if (e.ctrlKey && e.key === 'k') {
				e.preventDefault()
				setShowSwitcher(prev => !prev)
				setShowSettings(false)
			}
		}
		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [onClose])

	// Re-focus terminal when switcher/settings close
	useEffect(() => {
		if (!showSwitcher && !showSettings) {
			xtermRef.current?.focus()
		}
	}, [showSwitcher, showSettings])

	function handleSwitchSession(targetSessionId: string) {
		setShowSwitcher(false)
		if (targetSessionId !== sessionId) {
			onSwitchSession(targetSessionId)
		}
	}

	const showDisconnected = !isConnected || !!terminalError
	const currentTheme = getTheme(settings.themeId)

	return (
		<div className="fixed inset-0 z-50 flex flex-col" style={{ background: currentTheme.background }}>
			{/* Header bar */}
			<div
				className="shrink-0 flex items-center justify-between px-3 py-1.5 border-b"
				style={{ background: currentTheme.black, borderColor: currentTheme.brightBlack }}
			>
				<div className="flex items-center gap-2">
					{showDisconnected && <WifiOff className="w-3 h-3" style={{ color: currentTheme.red }} />}
					<span className="text-[10px] font-mono" style={{ color: currentTheme.brightBlack }}>
						TERMINAL - {sessionId.slice(0, 8)}...
					</span>
				</div>
				<div className="flex items-center gap-1">
					<span className="text-[10px] font-mono mr-2" style={{ color: currentTheme.brightBlack }}>
						^K switch  ^, settings  ^Q close
					</span>
					<button
						type="button"
						onClick={() => { setShowSwitcher(prev => !prev); setShowSettings(false) }}
						className="p-1 transition-colors"
						style={{ color: showSwitcher ? currentTheme.blue : currentTheme.brightBlack }}
						title="Switch session (Ctrl+K)"
					>
						<span className="text-[10px] font-mono">TTY</span>
					</button>
					<button
						type="button"
						onClick={() => { setShowSettings(prev => !prev); setShowSwitcher(false) }}
						className="p-1 transition-colors"
						style={{ color: showSettings ? currentTheme.blue : currentTheme.brightBlack }}
						title="Settings (Ctrl+,)"
					>
						<Settings className="w-3.5 h-3.5" />
					</button>
					<button
						type="button"
						onClick={onClose}
						className="p-1 transition-colors"
						style={{ color: currentTheme.brightBlack }}
						title="Close terminal (Ctrl+Shift+Q)"
					>
						<X className="w-4 h-4" />
					</button>
				</div>
			</div>

			{/* Disconnected / error banner */}
			{showDisconnected && (
				<div
					className="shrink-0 flex items-center gap-2 px-3 py-2 border-b"
					style={{ background: `${currentTheme.red}15`, borderColor: `${currentTheme.red}40` }}
				>
					<WifiOff className="w-3.5 h-3.5" style={{ color: currentTheme.red }} />
					<span className="text-xs font-mono" style={{ color: currentTheme.red }}>
						{terminalError || 'Disconnected - waiting for reconnect...'}
					</span>
				</div>
			)}

			{/* Terminal area */}
			<div className="relative flex-1 min-h-0">
				<div ref={terminalRef} className="absolute inset-0 p-1" />

				{showSettings && (
					<TerminalSettingsPanel
						settings={settings}
						onChange={handleSettingsChange}
						onClose={() => setShowSettings(false)}
					/>
				)}
			</div>

			{/* Session switcher overlay */}
			{showSwitcher && (
				<SessionSwitcher
					onSelect={handleSwitchSession}
					onClose={() => setShowSwitcher(false)}
				/>
			)}

			{/* Shortcut toolbar */}
			<TerminalToolbar onSend={sendData} />
		</div>
	)
}
