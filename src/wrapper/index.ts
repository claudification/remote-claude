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

function printHelp() {
  console.log(`
rclaude - Claude Code Session Wrapper

Wraps the claude CLI with hook injection and session forwarding to a concentrator server.

USAGE:
  rclaude [OPTIONS] [CLAUDE_ARGS...]

OPTIONS:
  --concentrator <url>   Concentrator WebSocket URL (default: ${DEFAULT_CONCENTRATOR_URL})
  --no-concentrator      Run without forwarding to concentrator
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
  let noConcentrator = false;
  const claudeArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--rclaude-help") {
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

  // Internal ID for local server validation (not sent to concentrator)
  const internalId = randomUUID();
  const cwd = process.cwd();

  // Will be set when we receive SessionStart from Claude
  let claudeSessionId: string | null = null;
  let wsClient: WsClient | null = null;
  let ptyProcess: PtyProcess | null = null;

  // Queue events until we have the real session ID
  const eventQueue: HookEvent[] = [];

  function connectToConcentrator(sessionId: string) {
    if (noConcentrator || wsClient) return;

    wsClient = createWsClient({
      concentratorUrl,
      sessionId,
      cwd,
      args: claudeArgs,
      onConnected() {
        if (process.env.RCLAUDE_DEBUG) {
          console.error(`[rclaude] Connected to concentrator (session: ${sessionId.slice(0, 8)}...)`);
        }
        // Flush queued events
        for (const event of eventQueue) {
          wsClient?.sendHookEvent({ ...event, sessionId });
        }
        eventQueue.length = 0;
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
        if (process.env.RCLAUDE_DEBUG) {
          console.error(`[rclaude] Sent to PTY: ${JSON.stringify(trimmed)} then \\r`);
        }
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
          if (process.env.RCLAUDE_DEBUG) {
            console.error(`[rclaude] Got Claude session ID: ${claudeSessionId.slice(0, 8)}...`);
          }
          // Now connect to concentrator with the real ID
          connectToConcentrator(claudeSessionId);
        }
      }

      // Forward to concentrator (or queue if not connected yet)
      if (claudeSessionId && wsClient?.isConnected()) {
        wsClient.sendHookEvent({ ...event, sessionId: claudeSessionId });
      } else if (claudeSessionId) {
        // Connected but WS not ready yet - queue it
        eventQueue.push(event);
      } else {
        // Don't have session ID yet - queue it
        eventQueue.push(event);
      }

      if (process.env.RCLAUDE_DEBUG) {
        console.error(`[rclaude] Hook: ${event.hookEvent}`);
      }
    },
  });

  // Generate merged settings with hook injection
  const settingsPath = await writeMergedSettings(internalId, localServerPort);

  // Spawn claude with PTY
  ptyProcess = spawnClaude({
    args: claudeArgs,
    settingsPath,
    sessionId: internalId,
    localServerPort,
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
