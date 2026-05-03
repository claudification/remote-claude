/**
 * PTY Spawn Module
 * Spawns claude with full PTY passthrough
 */

import type { Subprocess } from 'bun'

export interface PtyOptions {
  args: string[]
  settingsPath: string
  conversationId: string
  localServerPort: number
  brokerUrl?: string
  brokerSecret?: string
  cwd?: string
  env?: Record<string, string>
  onData?: (data: string) => void
  onExit?: (code: number | null) => void
}

export interface PtyProcess {
  proc: Subprocess
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: (signal?: NodeJS.Signals) => void
  redraw: () => void
}

/**
 * Get terminal size with fallback
 */
export function getTerminalSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  }
}

/**
 * Spawn claude process with PTY
 */
export function spawnClaude(options: PtyOptions): PtyProcess {
  const { args, settingsPath, conversationId, localServerPort, brokerUrl, brokerSecret, cwd, env, onData, onExit } =
    options

  const { cols, rows } = getTerminalSize()
  const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

  // Build command args - inject --settings before other args
  const claudeArgs = ['--settings', settingsPath, ...args]

  const proc = Bun.spawn(['claude', ...claudeArgs], {
    cwd: cwd || process.cwd(),
    env: {
      ...process.env,
      ...env,
      RCLAUDE_SESSION_ID: conversationId,
      RCLAUDE_PORT: String(localServerPort),
      ...(brokerUrl ? { RCLAUDE_BROKER: brokerUrl } : {}),
      ...(brokerSecret ? { RCLAUDE_SECRET: brokerSecret } : {}),
      // Pin task list to conversation ID so tasks persist to ~/.claude/tasks/{conversationId}/
      CLAUDE_CODE_TASK_LIST_ID: conversationId,
      // Ensure color output
      FORCE_COLOR: '1',
      // Force xterm-256color regardless of outer shell (tmux sets screen-256color)
      // Remote viewer is xterm.js which IS xterm - must match
      TERM: 'xterm-256color',
      // Force CC to use OSC 52 for clipboard instead of pbcopy.
      // CC checks SSH_TTY to decide clipboard provider: if set, it writes
      // \x1b]52;c;BASE64\x07 to stdout (the PTY) which rclaude's OSC 52
      // parser intercepts and relays to the dashboard as clipboard_capture.
      // Without this, CC uses pbcopy (native macOS) which bypasses the PTY.
      // Side effects: terminal type reported as "ssh-session" (telemetry only),
      // copy-on-select skips pbcopy (irrelevant for headless sessions).
      SSH_TTY: process.env.SSH_TTY || '/dev/pts/0',
    },
    terminal: {
      cols,
      rows,
      data(_terminal, data) {
        try {
          // Write to stdout
          process.stdout.write(data)
        } catch {
          // stdout closed/broken pipe - ignore
        }
        try {
          // Decode with streaming TextDecoder to handle split UTF-8 sequences
          // Strip U+FFFD replacement chars (invalid bytes from PTY binary output)
          const decoded = utf8Decoder.decode(data, { stream: true })
          onData?.(decoded.indexOf('\uFFFD') >= 0 ? decoded.replaceAll('\uFFFD', '') : decoded)
        } catch {
          // onData callback error - swallow to prevent PTY crash
        }
      },
    },
    onExit(_proc, exitCode, _signalCode, _error) {
      onExit?.(exitCode)
    },
  })

  return {
    proc,
    write(data: string) {
      proc.terminal?.write(data)
    },
    resize(cols: number, rows: number) {
      proc.terminal?.resize(cols, rows)
    },
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      proc.kill(signal)
    },
    redraw() {
      // Send SIGWINCH to force the application to repaint the screen
      // Works with Claude Code (ink/React), vim, htop, etc.
      if (proc.pid) {
        try {
          process.kill(proc.pid, 'SIGWINCH')
        } catch {
          // Process may have exited - ignore
        }
      }
    },
  }
}

/**
 * Setup stdin passthrough and signal handling
 */
export function setupTerminalPassthrough(ptyProcess: PtyProcess): () => void {
  // Set raw mode for stdin
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }

  // Forward stdin to pty
  const stdinListener = (chunk: Buffer) => {
    ptyProcess.write(chunk.toString())
  }
  process.stdin.on('data', stdinListener)

  // Handle terminal resize
  const resizeListener = () => {
    const { cols, rows } = getTerminalSize()
    ptyProcess.resize(cols, rows)
  }
  process.stdout.on('resize', resizeListener)

  // Handle signals
  const sigintListener = () => {
    ptyProcess.proc.kill('SIGINT')
  }
  const sigtermListener = () => {
    ptyProcess.proc.kill('SIGTERM')
  }
  const sigquitListener = () => {
    ptyProcess.proc.kill('SIGQUIT')
  }

  process.on('SIGINT', sigintListener)
  process.on('SIGTERM', sigtermListener)
  process.on('SIGQUIT', sigquitListener)

  // Return cleanup function
  return () => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
    process.stdin.off('data', stdinListener)
    process.stdout.off('resize', resizeListener)
    process.off('SIGINT', sigintListener)
    process.off('SIGTERM', sigtermListener)
    process.off('SIGQUIT', sigquitListener)
  }
}
