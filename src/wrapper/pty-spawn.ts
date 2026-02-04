/**
 * PTY Spawn Module
 * Spawns claude with full PTY passthrough
 */

import type { Subprocess } from "bun";

export interface PtyOptions {
  args: string[];
  settingsPath: string;
  sessionId: string;
  localServerPort: number;
  cwd?: string;
  env?: Record<string, string>;
  onData?: (data: string) => void;
  onExit?: (code: number | null) => void;
}

export interface PtyProcess {
  proc: Subprocess;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: NodeJS.Signals) => void;
}

/**
 * Get terminal size with fallback
 */
function getTerminalSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

/**
 * Spawn claude process with PTY
 */
export function spawnClaude(options: PtyOptions): PtyProcess {
  const { args, settingsPath, sessionId, localServerPort, cwd, env, onData, onExit } =
    options;

  const { cols, rows } = getTerminalSize();

  // Build command args - inject --settings before other args
  const claudeArgs = ["--settings", settingsPath, ...args];

  const proc = Bun.spawn(["claude", ...claudeArgs], {
    cwd: cwd || process.cwd(),
    env: {
      ...process.env,
      ...env,
      RCLAUDE_SESSION_ID: sessionId,
      RCLAUDE_PORT: String(localServerPort),
      // Ensure color output
      FORCE_COLOR: "1",
      TERM: process.env.TERM || "xterm-256color",
    },
    terminal: {
      cols,
      rows,
      data(_terminal, data) {
        // Write to stdout
        process.stdout.write(data);
        // Optional callback for ANSI tracking
        onData?.(data.toString());
      },
    },
    onExit(_proc, exitCode, _signalCode, _error) {
      onExit?.(exitCode);
    },
  });

  return {
    proc,
    write(data: string) {
      proc.terminal?.write(data);
    },
    resize(cols: number, rows: number) {
      proc.terminal?.resize(cols, rows);
    },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      proc.kill(signal);
    },
  };
}

/**
 * Setup stdin passthrough and signal handling
 */
export function setupTerminalPassthrough(ptyProcess: PtyProcess): () => void {
  // Set raw mode for stdin
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  // Forward stdin to pty
  const stdinListener = (chunk: Buffer) => {
    ptyProcess.write(chunk.toString());
  };
  process.stdin.on("data", stdinListener);

  // Handle terminal resize
  const resizeListener = () => {
    const { cols, rows } = {
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    };
    ptyProcess.resize(cols, rows);
  };
  process.stdout.on("resize", resizeListener);

  // Handle signals
  const sigintListener = () => {
    ptyProcess.proc.kill("SIGINT");
  };
  const sigtermListener = () => {
    ptyProcess.proc.kill("SIGTERM");
  };
  const sigquitListener = () => {
    ptyProcess.proc.kill("SIGQUIT");
  };

  process.on("SIGINT", sigintListener);
  process.on("SIGTERM", sigtermListener);
  process.on("SIGQUIT", sigquitListener);

  // Return cleanup function
  return () => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.off("data", stdinListener);
    process.stdout.off("resize", resizeListener);
    process.off("SIGINT", sigintListener);
    process.off("SIGTERM", sigtermListener);
    process.off("SIGQUIT", sigquitListener);
  };
}
