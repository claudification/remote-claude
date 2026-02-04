#!/usr/bin/env bun
/**
 * rclaude - Claude Code Session Wrapper
 * Wraps claude CLI with hook injection and concentrator forwarding
 */

import { randomUUID } from "crypto";
import { writeMergedSettings, cleanupSettings } from "./settings-merge";
import { spawnClaude, setupTerminalPassthrough } from "./pty-spawn";
import { startLocalServer, stopLocalServer } from "./local-server";
import { createWsClient, type WsClient } from "./ws-client";
import { DEFAULT_CONCENTRATOR_URL } from "../shared/protocol";
import type { HookEvent } from "../shared/protocol";

function printHelp() {
  console.log(`
rclaude - Claude Code Session Wrapper

Wraps the claude CLI with hook injection and session forwarding to a concentrator server.

USAGE:
  rclaude [OPTIONS] [CLAUDE_ARGS...]

OPTIONS:
  --concentrator <url>   Concentrator WebSocket URL (default: ${DEFAULT_CONCENTRATOR_URL})
  --no-concentrator      Run without forwarding to concentrator
  --help                 Show this help message

EXAMPLES:
  rclaude                           # Start interactive session
  rclaude --resume                  # Resume previous session
  rclaude -p "build X"              # Non-interactive prompt
  rclaude --no-concentrator         # Run without concentrator
  rclaude --concentrator ws://myserver:9999

All other arguments are passed through to claude.
`);
}

async function main() {
  // Parse our specific args, pass the rest to claude
  const args = process.argv.slice(2);

  let concentratorUrl = DEFAULT_CONCENTRATOR_URL;
  let noConcentrator = false;
  const claudeArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" && !args.includes("-p")) {
      printHelp();
      process.exit(0);
    } else if (arg === "--concentrator") {
      concentratorUrl = args[++i] || DEFAULT_CONCENTRATOR_URL;
    } else if (arg === "--no-concentrator") {
      noConcentrator = true;
    } else {
      claudeArgs.push(arg);
    }
  }

  const sessionId = randomUUID();
  const cwd = process.cwd();

  // Start local HTTP server for hook callbacks
  let wsClient: WsClient | null = null;

  const { server: localServer, port: localServerPort } = await startLocalServer({
    sessionId,
    onHookEvent(event: HookEvent) {
      // Forward to concentrator
      wsClient?.sendHookEvent(event);

      // Debug logging (could be made configurable)
      if (process.env.RCLAUDE_DEBUG) {
        console.error(`[rclaude] Hook: ${event.hookEvent}`);
      }
    },
  });

  // Connect to concentrator (unless disabled)
  if (!noConcentrator) {
    wsClient = createWsClient({
      concentratorUrl,
      sessionId,
      cwd,
      args: claudeArgs,
      onConnected() {
        if (process.env.RCLAUDE_DEBUG) {
          console.error(`[rclaude] Connected to concentrator`);
        }
      },
      onDisconnected() {
        if (process.env.RCLAUDE_DEBUG) {
          console.error(`[rclaude] Disconnected from concentrator`);
        }
      },
      onError(error) {
        if (process.env.RCLAUDE_DEBUG) {
          console.error(`[rclaude] Concentrator error:`, error.message);
        }
      },
    });
  }

  // Generate merged settings with hook injection
  const settingsPath = await writeMergedSettings(sessionId, localServerPort);

  // Spawn claude with PTY
  const ptyProcess = spawnClaude({
    args: claudeArgs,
    settingsPath,
    sessionId,
    localServerPort,
    onExit(code) {
      // Send session end to concentrator
      wsClient?.sendSessionEnd(code === 0 ? "normal" : `exit_code_${code}`);

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
    cleanupSettings(sessionId).catch(() => {});
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
