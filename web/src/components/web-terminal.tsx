import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { useCallback, useEffect, useRef, useState } from 'react'
import '@xterm/xterm/css/xterm.css'
import { Settings, WifiOff, X } from 'lucide-react'
import { type TerminalMessage, useConversationsStore } from '@/hooks/use-conversations'
import { extractProjectLabel, projectPath } from '@/lib/types'
import { lastPathSegments } from '@/lib/utils'
import {
  getFont,
  getTheme,
  loadTerminalSettings,
  saveTerminalSettings,
  type TerminalSettings,
  TerminalSettingsPanel,
} from './terminal-settings'
import { TerminalToolbar } from './terminal-toolbar'

interface WebTerminalProps {
  conversationId: string
  onClose: () => void
  popout?: boolean
}

export function WebTerminal({ conversationId, onClose, popout }: WebTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const sessions = useConversationsStore(state => state.sessions)
  const sendWsMessage = useConversationsStore(state => state.sendWsMessage)
  const setTerminalHandler = useConversationsStore(state => state.setTerminalHandler)
  const isConnected = useConversationsStore(state => state.isConnected)
  const showSwitcher = useConversationsStore(state => state.showSwitcher)
  const [terminalError, setTerminalError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState<TerminalSettings>(loadTerminalSettings)

  const sendData = useCallback(
    (data: string) => {
      sendWsMessage({ type: 'terminal_data', conversationId, data })
    },
    [sendWsMessage, conversationId],
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
      sendWsMessage({ type: 'terminal_resize', conversationId, cols, rows })
    }
  }

  // Resolve the owning session for this wrapper (for display purposes)
  const ownerConversation = sessions.find(s => s.ccSessionIds?.includes(conversationId))

  // Set window title in popout mode
  const projectSettings = useConversationsStore(state => state.projectSettings)
  useEffect(() => {
    if (!popout) return
    if (ownerConversation) {
      const ps = projectSettings[ownerConversation.project]
      const name = ps?.label || extractProjectLabel(ownerConversation.project) || conversationId.slice(0, 8)
      document.title = `TTY: ${name}`
    } else {
      document.title = `TTY: ${conversationId.slice(0, 8)}`
    }
  }, [popout, conversationId, ownerConversation, projectSettings])

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
      // Ctrl+Shift+T - toggle terminal (handled by app.tsx)
      if (e.ctrlKey && e.shiftKey && e.key === 'T') return false
      // Ctrl+Shift+Q - close
      if (e.ctrlKey && e.shiftKey && e.key === 'Q') return false
      // Shift+Enter - send same as Alt+Enter (ESC + CR) so Claude Code treats it as newline
      // Block ALL event types (keydown+keypress+keyup) to prevent xterm from also processing Enter
      if (e.shiftKey && e.key === 'Enter') {
        if (e.type === 'keydown') {
          sendWsMessage({ type: 'terminal_data', conversationId, data: '\x1b\r' })
        }
        return false
      }
      // When switcher is open, eat all keys so they don't go to PTY
      if (useConversationsStore.getState().showSwitcher) return false
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
      if (data.length > 1) {
        console.log('[terminal] onData (multi-char, likely paste):', {
          length: data.length,
          preview: data.slice(0, 80),
        })
      }
      sendWsMessage({ type: 'terminal_data', conversationId, data })
    })

    // Paste: intercept Cmd+V / Ctrl+V and preventDefault to stop native paste
    // from also firing (which would double-paste via xterm's onData)
    function handleKeyPaste(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'v' && e.type === 'keydown') {
        e.preventDefault()
        navigator.clipboard
          .readText()
          .then(text => {
            if (text) terminal.paste(text)
          })
          .catch(() => {})
      }
    }
    terminalRef.current.addEventListener('keydown', handleKeyPaste)

    const handler = (msg: TerminalMessage) => {
      if (msg.conversationId !== conversationId) return
      if (msg.type === 'terminal_data' && msg.data) {
        // Debug: detect characters that cause line offset issues
        const d = msg.data
        for (let i = 0; i < d.length; i++) {
          const code = d.charCodeAt(i)
          // U+FFFD replacement char = encoding broke somewhere
          if (code === 0xfffd) {
            const hex = [...d.substring(Math.max(0, i - 3), i + 3)]
              .map(c => `U+${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
              .join(' ')
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
      sendWsMessage({ type: 'terminal_resize', conversationId, cols, rows })
    })
    resizeObserver.observe(terminalRef.current)

    terminal.focus()

    const termEl = terminalRef.current
    return () => {
      resizeObserver.disconnect()
      dataDisposable.dispose()
      termEl?.removeEventListener('keydown', handleKeyPaste)
      setTerminalHandler(null)
      sendWsMessage({ type: 'terminal_detach', conversationId })
      terminal.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
    }
  }, [conversationId, sendWsMessage, setTerminalHandler])

  // Re-attach when WS reconnects
  useEffect(() => {
    if (!isConnected || !xtermRef.current) return
    setTerminalError(null)
    const terminal = xtermRef.current
    const { cols, rows } = terminal
    sendWsMessage({ type: 'terminal_attach', conversationId, cols, rows })
  }, [isConnected, conversationId, sendWsMessage])

  // Terminal-local shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.shiftKey && e.key === 'Q') {
        e.preventDefault()
        onClose()
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'T') {
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

  // Prevent scroll events from leaking to parent page
  // position:fixed removes the body from scroll flow entirely (overflow:hidden alone fails on iOS Safari)
  useEffect(() => {
    const body = document.body
    const scrollY = window.scrollY
    const prev = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      overflow: body.style.overflow,
    }
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.overflow = 'hidden'
    return () => {
      body.style.position = prev.position
      body.style.top = prev.top
      body.style.left = prev.left
      body.style.right = prev.right
      body.style.overflow = prev.overflow
      window.scrollTo(0, scrollY)
    }
  }, [])

  // Catch wheel events that xterm doesn't consume (at scroll bounds)
  // xterm calls stopPropagation when it scrolls, so only leaked events bubble here
  useEffect(() => {
    const el = terminalRef.current?.closest('[data-terminal-overlay]') as HTMLElement | null
    if (!el) return
    function block(e: WheelEvent) {
      e.preventDefault()
    }
    function blockTouch(e: TouchEvent) {
      e.preventDefault()
    }
    el.addEventListener('wheel', block, { passive: false })
    el.addEventListener('touchmove', blockTouch, { passive: false })
    return () => {
      el.removeEventListener('wheel', block)
      el.removeEventListener('touchmove', blockTouch)
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

  return (
    <div
      data-terminal-overlay
      role="application"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden"
      style={{ background: currentTheme.background, overscrollBehavior: 'none' }}
      onClick={e => {
        if ((e.target as HTMLElement).closest('button, input, select, textarea')) return
        xtermRef.current?.focus()
      }}
      onKeyDown={() => xtermRef.current?.focus()}
    >
      {/* Minimal header */}
      <div
        className="shrink-0 flex items-center border-b"
        style={{ background: currentTheme.black, borderColor: currentTheme.brightBlack }}
      >
        <span className="px-3 py-1.5 text-[10px] font-mono flex-1" style={{ color: currentTheme.brightBlack }}>
          {showDisconnected && <WifiOff className="w-3 h-3 inline mr-1.5" />}
          {ownerConversation
            ? lastPathSegments(projectPath(ownerConversation.project), 2)
            : `TERMINAL - ${conversationId.slice(0, 8)}`}
        </span>
        <div className="flex items-center gap-1 px-2 shrink-0">
          <span className="text-[10px] font-mono mr-1 hidden sm:inline" style={{ color: currentTheme.brightBlack }}>
            ^, settings ^⇧Q close
          </span>
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

      {/* Shortcut toolbar - above terminal to avoid iOS task switcher conflict at bottom */}
      <TerminalToolbar onSend={sendData} />

      {/* Terminal area */}
      <div className="relative flex-1 min-h-0 overflow-hidden" style={{ overscrollBehavior: 'contain' }}>
        <div
          ref={terminalRef}
          className="absolute inset-0 p-1 overflow-hidden"
          style={{ overscrollBehavior: 'contain' }}
        />

        {showSettings && (
          <TerminalSettingsPanel
            settings={settings}
            onChange={handleSettingsChange}
            onClose={() => setShowSettings(false)}
          />
        )}
      </div>
    </div>
  )
}
