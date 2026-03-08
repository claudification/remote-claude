import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { Settings, X, WifiOff } from 'lucide-react'
import { useSessionsStore, type TerminalMessage } from '@/hooks/use-sessions'
import { canTerminal } from '@/lib/types'
import { lastPathSegments } from '@/lib/utils'
import { TerminalToolbar } from './terminal-toolbar'
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

export function WebTerminal({ sessionId, onClose, onSwitchSession }: WebTerminalProps) {
	const terminalRef = useRef<HTMLDivElement>(null)
	const xtermRef = useRef<Terminal | null>(null)
	const fitAddonRef = useRef<FitAddon | null>(null)
	const sessions = useSessionsStore(state => state.sessions)
	const sendWsMessage = useSessionsStore(state => state.sendWsMessage)
	const setTerminalHandler = useSessionsStore(state => state.setTerminalHandler)
	const isConnected = useSessionsStore(state => state.isConnected)
	const showSwitcher = useSessionsStore(state => state.showSwitcher)
	const [terminalError, setTerminalError] = useState<string | null>(null)
	const [showSettings, setShowSettings] = useState(false)
	const [settings, setSettings] = useState<TerminalSettings>(loadTerminalSettings)

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
			cursorBlink: false,
			cursorStyle: 'block',
			allowProposedApi: true,
			scrollback: 5000,
		})

		const fitAddon = new FitAddon()
		terminal.loadAddon(fitAddon)

		// Intercept shortcuts before xterm sends them to PTY
		terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
			// Ctrl+K - global switcher (handled by app.tsx)
			if (e.ctrlKey && e.key === 'k') return false
			// Ctrl+, - settings
			if (e.ctrlKey && e.key === ',') return false
			// Ctrl+Shift+Q - close
			if (e.ctrlKey && e.shiftKey && e.key === 'Q') return false
			// When switcher is open, eat all keys so they don't go to PTY
			if (useSessionsStore.getState().showSwitcher) return false
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

		// Prime xterm.js with a clean state before PTY data flows in
		// RIS (reset) + clear + cursor home + hide cursor (Claude Code renders its own)
		terminal.write('\x1bc\x1b[2J\x1b[H\x1b[?25l')

		const dataDisposable = terminal.onData(data => {
			// Shift+Enter in xterm.js sends ESC[13;2u (CSI u) - translate to \n for Claude Code
			const translated = data === '\x1b[13;2u' ? '\n' : data
			sendWsMessage({ type: 'terminal_data', sessionId, data: translated })
		})

		const handler = (msg: TerminalMessage) => {
			if (msg.sessionId !== sessionId) return
			if (msg.type === 'terminal_data' && msg.data) {
				// Debug: detect characters that cause line offset issues
				const d = msg.data
				for (let i = 0; i < d.length; i++) {
					const code = d.charCodeAt(i)
					// U+FFFD replacement char = encoding broke somewhere
					if (code === 0xfffd) {
						const hex = [...d.substring(Math.max(0, i - 3), i + 3)].map(c => 'U+' + c.charCodeAt(0).toString(16).padStart(4, '0')).join(' ')
						console.warn(`[term] REPLACEMENT CHAR at ${i}/${d.length}, nearby: ${hex}`)
					}
					// Lone surrogates = broken string
					if (code >= 0xd800 && code <= 0xdfff) {
						const isHigh = code <= 0xdbff
						const next = d.charCodeAt(i + 1)
						if (isHigh && !(next >= 0xdc00 && next <= 0xdfff)) {
							console.warn(`[term] LONE SURROGATE U+${code.toString(16)} at ${i}/${d.length}`)
						} else if (!isHigh) {
							console.warn(`[term] ORPHAN LOW SURROGATE U+${code.toString(16)} at ${i}/${d.length}`)
						}
					}
					// Zero-width chars that shouldn't be in terminal data
					if (code === 0xfeff || code === 0x200b || code === 0x200c || code === 0x200d || code === 0x2060) {
						console.warn(`[term] ZERO-WIDTH U+${code.toString(16)} at ${i}/${d.length}`)
					}
				}
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

	// Terminal-local shortcuts (Ctrl+, for settings, Ctrl+Shift+Q for close)
	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if (e.ctrlKey && e.shiftKey && e.key === 'Q') {
				e.preventDefault()
				onClose()
			}
			if (e.ctrlKey && e.key === ',') {
				e.preventDefault()
				setShowSettings(prev => !prev)
			}
		}
		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [onClose])

	// Prevent wheel/touch events from bubbling to window (scroll containment)
	useEffect(() => {
		const el = terminalRef.current
		if (!el) return
		function stopWheel(e: WheelEvent) {
			e.stopPropagation()
		}
		function stopTouch(e: TouchEvent) {
			e.stopPropagation()
		}
		el.addEventListener('wheel', stopWheel, { passive: true })
		el.addEventListener('touchmove', stopTouch, { passive: true })
		return () => {
			el.removeEventListener('wheel', stopWheel)
			el.removeEventListener('touchmove', stopTouch)
		}
	}, [])

	// Re-focus terminal when switcher/settings close
	useEffect(() => {
		if (!showSwitcher && !showSettings) {
			xtermRef.current?.focus()
		}
	}, [showSwitcher, showSettings])

	const showDisconnected = !isConnected || !!terminalError
	const currentTheme = getTheme(settings.themeId)

	// Terminal-capable sessions for tabs
	const terminalSessions = sessions.filter(canTerminal)

	return (
		<div className="fixed inset-0 z-50 flex flex-col overflow-hidden" style={{ background: currentTheme.background }}>
			{/* Header bar with session tabs */}
			<div
				className="shrink-0 flex items-center border-b"
				style={{ background: currentTheme.black, borderColor: currentTheme.brightBlack }}
			>
				{/* Session tabs */}
				<div className="flex items-center overflow-x-auto min-w-0 flex-1">
					{terminalSessions.map(s => (
						<button
							key={s.id}
							type="button"
							onClick={() => { if (s.id !== sessionId) onSwitchSession(s.id) }}
							className="shrink-0 px-3 py-1.5 text-[10px] font-mono border-r transition-colors flex items-center gap-1.5"
							style={{
								borderColor: `${currentTheme.brightBlack}60`,
								background: s.id === sessionId ? currentTheme.background : 'transparent',
								color: s.id === sessionId ? currentTheme.foreground : currentTheme.brightBlack,
							}}
							title={s.cwd}
						>
							<span
								className="w-1.5 h-1.5 rounded-full shrink-0"
								style={{ background: s.status === 'active' ? currentTheme.green : currentTheme.yellow }}
							/>
							{lastPathSegments(s.cwd, 2)}
						</button>
					))}
					{terminalSessions.length === 0 && (
						<span className="px-3 py-1.5 text-[10px] font-mono" style={{ color: currentTheme.brightBlack }}>
							{showDisconnected && <WifiOff className="w-3 h-3 inline mr-1.5" />}
							TERMINAL - {sessionId.slice(0, 8)}
						</span>
					)}
				</div>
				{/* Actions */}
				<div className="flex items-center gap-1 px-2 shrink-0">
					<span className="text-[10px] font-mono mr-1 hidden sm:inline" style={{ color: currentTheme.brightBlack }}>
						^K switch  ^, settings  ^Q close
					</span>
					<button
						type="button"
						onClick={() => useSessionsStore.getState().toggleSwitcher()}
						className="p-1 transition-colors"
						style={{ color: showSwitcher ? currentTheme.blue : currentTheme.brightBlack }}
						title="Switch session (Ctrl+K)"
					>
						<span className="text-[10px] font-mono">TTY</span>
					</button>
					<button
						type="button"
						onClick={() => setShowSettings(prev => !prev)}
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
			<div className="relative flex-1 min-h-0" style={{ overscrollBehavior: 'contain' }}>
				<div ref={terminalRef} className="absolute inset-0 p-1" style={{ overscrollBehavior: 'contain' }} />

				{showSettings && (
					<TerminalSettingsPanel
						settings={settings}
						onChange={handleSettingsChange}
						onClose={() => setShowSettings(false)}
					/>
				)}
			</div>

			{/* Shortcut toolbar */}
			<TerminalToolbar onSend={sendData} />
		</div>
	)
}
