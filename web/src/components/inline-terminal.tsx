/**
 * Inline Terminal - xterm.js rendered in the content area (not fullscreen overlay)
 * Used when defaultView is 'tty' - shows terminal where transcript would be.
 */

import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { WifiOff } from 'lucide-react'
import { type TerminalMessage, useConversationsStore } from '@/hooks/use-sessions'
import { getFont, getTheme, loadTerminalSettings } from './terminal-settings'
import { TerminalToolbar } from './terminal-toolbar'

interface InlineTerminalProps {
  conversationId: string
}

export function InlineTerminal({ conversationId }: InlineTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sendWsMessage = useConversationsStore(state => state.sendWsMessage)
  const setTerminalHandler = useConversationsStore(state => state.setTerminalHandler)
  const isConnected = useConversationsStore(state => state.isConnected)
  const showSwitcher = useConversationsStore(state => state.showSwitcher)
  const [terminalError, setTerminalError] = useState<string | null>(null)
  const [themeColors] = useState(() => getTheme(loadTerminalSettings().themeId))

  useEffect(() => {
    if (!terminalRef.current) return

    const settings = loadTerminalSettings()
    const theme = getTheme(settings.themeId)
    const font = getFont(settings.fontId)

    const terminal = new Terminal({
      theme,
      fontFamily: font.family,
      fontSize: settings.fontSize,
      lineHeight: 1.2,
      cursorBlink: false,
      cursorStyle: 'block',
      allowProposedApi: true,
      scrollback: 5000,
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // Let global shortcuts pass through
      if (e.ctrlKey && e.key === 'k') return false
      if (e.ctrlKey && e.shiftKey && (e.key === 'Q' || e.key === 'T')) return false
      // Block ALL event types to prevent xterm from also processing Enter
      if (e.shiftKey && e.key === 'Enter') {
        if (e.type === 'keydown') {
          sendWsMessage({ type: 'terminal_data', conversationId, data: '\n' })
        }
        return false
      }
      if (useConversationsStore.getState().showSwitcher) return false
      return true
    })

    terminal.open(terminalRef.current)

    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => webglAddon.dispose())
      terminal.loadAddon(webglAddon)
    } catch {}

    fitAddon.fit()
    xtermRef.current = terminal
    fitAddonRef.current = fitAddon

    // Clean slate before PTY data flows in
    terminal.write('\x1bc\x1b[2J\x1b[H\x1b[?25l')

    const dataDisposable = terminal.onData(data => {
      sendWsMessage({ type: 'terminal_data', conversationId, data })
    })

    const handler = (msg: TerminalMessage) => {
      if (msg.conversationId !== conversationId) return
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
      sendWsMessage({ type: 'terminal_resize', conversationId, cols, rows })
    })
    resizeObserver.observe(terminalRef.current)

    terminal.focus()

    return () => {
      resizeObserver.disconnect()
      dataDisposable.dispose()
      setTerminalHandler(null)
      sendWsMessage({ type: 'terminal_detach', conversationId })
      terminal.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
    }
  }, [conversationId, sendWsMessage, setTerminalHandler])

  // Re-attach on WS reconnect
  useEffect(() => {
    if (!isConnected || !xtermRef.current) return
    setTerminalError(null)
    const { cols, rows } = xtermRef.current
    sendWsMessage({ type: 'terminal_attach', conversationId, cols, rows })
  }, [isConnected, conversationId, sendWsMessage])

  // Re-focus when switcher closes
  useEffect(() => {
    if (!showSwitcher) xtermRef.current?.focus()
  }, [showSwitcher])

  const showDisconnected = !isConnected || !!terminalError

  return (
    <div
      role="application"
      className="flex flex-col h-full"
      style={{ background: themeColors.background }}
      onClick={e => {
        if ((e.target as HTMLElement).closest('button, input, select, textarea')) return
        xtermRef.current?.focus()
      }}
      onKeyDown={() => xtermRef.current?.focus()}
    >
      {showDisconnected && (
        <div
          className="shrink-0 flex items-center gap-2 px-3 py-2 border-b"
          style={{ background: `${themeColors.red}15`, borderColor: `${themeColors.red}40` }}
        >
          <WifiOff className="w-3.5 h-3.5" style={{ color: themeColors.red }} />
          <span className="text-xs font-mono" style={{ color: themeColors.red }}>
            {terminalError || 'Disconnected - waiting for reconnect...'}
          </span>
        </div>
      )}
      <TerminalToolbar onSend={data => sendWsMessage({ type: 'terminal_data', conversationId, data })} />
      <div ref={terminalRef} className="flex-1 min-h-0 p-1 overflow-hidden" />
    </div>
  )
}
