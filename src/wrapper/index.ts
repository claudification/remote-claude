#!/usr/bin/env bun
/**
 * rclaude - Claude Code Session Wrapper
 * Wraps claude CLI with hook injection and concentrator forwarding
 */

import { randomUUID } from "crypto";
import { writeMergedSettings, cleanupSettings } from "./settings-merge";
import { spawnClaude, setupTerminalPassthrough, type PtyProcess } from "./pty-spawn";
import { startLocalServer, stopLocalServer } from "./local-server";
import { createWsClient, type WsClient } from "./ws-client";
import { DEFAULT_CONCENTRATOR_URL } from "../shared/protocol";
import type { HookEvent } from "../shared/protocol";

const DEBUG = !!process.env.RCLAUDE_DEBUG;

function debug(msg: string) {
  if (DEBUG) console.error(`[rclaude] ${msg}`);
}

/**
 * Check if concentrator is running
 */
async function isConcentratorReady(url: string): Promise<boolean> {
  try {
    const httpUrl = url.replace("ws://", "http://").replace("wss://", "https://");
    const resp = await fetch(`${httpUrl}/health`, {
      signal: AbortSignal.timeout(200),
    });
    return resp.ok;
  } catch {
    return false;
  }
}


/**
 * Set terminal title via OSC 2 escape sequence (shows in tmux window name)
 * Uses last 2 path segments, max 20 chars, right segment takes priority
 */
function setTerminalTitle(cwd: string) {
  const segments = cwd.split("/").filter(Boolean);
  const last2 = segments.slice(-2);
  let title = last2.join("/");

  if (title.length > 20) {
    // Right segment is most significant - keep it, truncate left
    const right = last2[last2.length - 1];
    if (right.length >= 20) {
      title = right.slice(0, 20);
    } else if (last2.length > 1) {
      const budget = 20 - right.length - 1; // -1 for the slash
      title = budget > 0
        ? last2[0].slice(0, budget) + "/" + right
        : right;
    }
  }

  // Strip control characters to prevent terminal escape injection
  title = title.replace(/[\x00-\x1f\x7f]/g, "");
  if (!title) return;

  process.title = title;
  process.stdout.write(`\x1b]2;${title}\x07`);

  // Direct tmux rename (automatic-rename overrides OSC 2 on macOS)
  if (process.env.TMUX) {
    try {
      Bun.spawnSync(["tmux", "rename-window", title]);
      Bun.spawnSync(["tmux", "set-option", "-w", "automatic-rename", "off"]);
    } catch {}
  }
}

function printHelp() {
  console.log(`
rclaude - Claude Code Session Wrapper

Wraps the claude CLI with hook injection and session forwarding to a concentrator server.

USAGE:
  rclaude [OPTIONS] [CLAUDE_ARGS...]

OPTIONS:
  --concentrator <url>   Concentrator WebSocket URL (default: ${DEFAULT_CONCENTRATOR_URL})
  --rclaude-secret <s>   Shared secret for concentrator auth (or RCLAUDE_SECRET env)
  --no-concentrator      Run without forwarding to concentrator
  --no-terminal          Disable remote terminal capability
  --rclaude-help         Show this help message

All other arguments are passed through to claude.

EXAMPLES:
  rclaude                           # Start interactive session
  rclaude --resume                  # Resume previous session
  rclaude -p "build X"              # Non-interactive prompt
  rclaude --help                    # Show claude's help
  rclaude --no-concentrator         # Run without concentrator
  rclaude --concentrator ws://myserver:9999
`);
}

async function main() {
  // Parse our specific args, pass the rest to claude
  const args = process.argv.slice(2);

  let concentratorUrl = DEFAULT_CONCENTRATOR_URL;
  let concentratorSecret = process.env.RCLAUDE_SECRET;
  let noConcentrator = false;
  let noTerminal = false;
  const claudeArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--rclaude-help") {
      printHelp();
      process.exit(0);
    } else if (arg === "--concentrator") {
      concentratorUrl = args[++i] || DEFAULT_CONCENTRATOR_URL;
    } else if (arg === "--rclaude-secret") {
      concentratorSecret = args[++i];
    } else if (arg === "--no-concentrator") {
      noConcentrator = true;
    } else if (arg === "--no-terminal") {
      noTerminal = true;
    } else {
      claudeArgs.push(arg);
    }
  }

  // Check if concentrator is reachable (unless --no-concentrator)
  if (!noConcentrator && !(await isConcentratorReady(concentratorUrl))) {
    debug("Concentrator not reachable - running without it");
    noConcentrator = true;
  }

  // Internal ID for local server validation (not sent to concentrator)
  const internalId = randomUUID();
  const cwd = process.cwd();

  // Will be set when we receive SessionStart from Claude
  let claudeSessionId: string | null = null;
  let wsClient: WsClient | null = null;
  let ptyProcess: PtyProcess | null = null;
  let terminalAttached = false;
  let savedTerminalSize: { cols: number; rows: number } | null = null;

  // Queue events until we have the real session ID
  const eventQueue: HookEvent[] = [];

  function connectToConcentrator(sessionId: string) {
    if (noConcentrator || wsClient) return;

    // Build capabilities list
    const capabilities = noTerminal ? [] : ["terminal" as const];

    wsClient = createWsClient({
      concentratorUrl,
      concentratorSecret,
      sessionId,
      cwd,
      args: claudeArgs,
      capabilities,
      onConnected() {
        debug(`Connected to concentrator (session: ${sessionId.slice(0, 8)}...)`)
        // Flush queued events
        for (const event of eventQueue) {
          wsClient?.sendHookEvent({ ...event, sessionId });
        }
        eventQueue.length = 0;
      },
      onDisconnected() {
        debug("Disconnected from concentrator");
      },
      onError(error) {
        debug(`Concentrator error: ${error.message}`);
      },
      onInput(input) {
        if (!ptyProcess) return;
        // Strip trailing whitespace
        const trimmed = input.replace(/[\r\n]+$/, "").replace(/\n/g, "\\\n");
        // Send text first
        ptyProcess.write(trimmed);
        // Then send Enter key separately after a tiny delay
        setTimeout(() => {
          ptyProcess?.write("\r");
        }, 50);
        debug(`Sent to PTY: ${JSON.stringify(trimmed)} then \\r`);
      },
      onTerminalInput(data) {
        // Raw keystrokes from browser terminal - write directly to PTY
        if (ptyProcess) {
          ptyProcess.write(data);
        }
      },
      onTerminalAttach(cols, rows) {
        terminalAttached = true;
        // Save local terminal size before remote viewer takes over
        savedTerminalSize = {
          cols: process.stdout.columns || 80,
          rows: process.stdout.rows || 24,
        };
        debug(`Terminal attached (${cols}x${rows}), saved local size (${savedTerminalSize.cols}x${savedTerminalSize.rows})`);
        if (ptyProcess) {
          ptyProcess.resize(cols, rows);
          // Force full screen repaint so remote viewer sees current state
          // Small delay to let resize settle before SIGWINCH
          setTimeout(() => ptyProcess?.redraw(), 50);
        }
      },
      onTerminalDetach() {
        terminalAttached = false;
        // Restore local terminal size
        if (savedTerminalSize && ptyProcess) {
          ptyProcess.resize(savedTerminalSize.cols, savedTerminalSize.rows);
          debug(`Terminal detached, restored to ${savedTerminalSize.cols}x${savedTerminalSize.rows}`);
          savedTerminalSize = null;
        } else {
          debug("Terminal detached");
        }
      },
      onTerminalResize(cols, rows) {
        if (ptyProcess) {
          ptyProcess.resize(cols, rows);
        }
        debug(`Terminal resized to ${cols}x${rows}`);
      },
    });
  }

  // Start local HTTP server for hook callbacks
  const { server: localServer, port: localServerPort } = await startLocalServer({
    sessionId: internalId,
    onHookEvent(event: HookEvent) {
      // Extract Claude's real session ID from SessionStart
      if (event.hookEvent === "SessionStart" && event.data) {
        const data = event.data as Record<string, unknown>;
        if (data.session_id && typeof data.session_id === "string") {
          claudeSessionId = data.session_id;
          debug(`Got Claude session ID: ${claudeSessionId.slice(0, 8)}...`);
          // Now connect to concentrator with the real ID
          connectToConcentrator(claudeSessionId);
        }
      }

      // Forward to concentrator, or queue until session ID + WS are ready
      if (claudeSessionId && wsClient?.isConnected()) {
        wsClient.sendHookEvent({ ...event, sessionId: claudeSessionId });
      } else {
        eventQueue.push(event);
      }

      debug(`Hook: ${event.hookEvent}`);
    },
  });

  // Generate merged settings with hook injection
  const settingsPath = await writeMergedSettings(internalId, localServerPort);

  // Set terminal title to last 2 path segments (shows in tmux)
  setTerminalTitle(cwd);

  // Spawn claude with PTY
  ptyProcess = spawnClaude({
    args: claudeArgs,
    settingsPath,
    sessionId: internalId,
    localServerPort,
    onData(data) {
      // Forward PTY output to remote terminal viewer when attached
      if (terminalAttached && claudeSessionId && wsClient?.isConnected()) {
        wsClient.sendTerminalData(data);
      }
    },
    onExit(code) {
      // Send session end to concentrator
      if (claudeSessionId) {
        wsClient?.sendSessionEnd(code === 0 ? "normal" : `exit_code_${code}`);
      }

      // Cleanup
      cleanup();

      process.exit(code ?? 0);
    },
  });

  // Setup terminal passthrough
  const cleanupTerminal = setupTerminalPassthrough(ptyProcess);

  // Cleanup function
  function cleanup() {
    cleanupTerminal();
    stopLocalServer(localServer);
    wsClient?.close();
    cleanupSettings(internalId).catch(() => {});
  }

  // Handle unexpected exits
  process.on("exit", cleanup);
  process.on("uncaughtException", (error) => {
    console.error("[rclaude] Uncaught exception:", error);
    cleanup();
    process.exit(1);
  });
}

main().catch((error) => {
  console.error("[rclaude] Fatal error:", error);
  process.exit(1);
});
