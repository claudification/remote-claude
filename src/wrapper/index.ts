#!/usr/bin/env bun
/**
 * rclaude - Claude Code Session Wrapper
 * Wraps claude CLI with hook injection and concentrator forwarding
 */

import { randomUUID } from "crypto";
import { realpathSync, existsSync } from "fs";
import { dirname, join } from "path";
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
 * Find the concentrator binary
 * Priority: CONCENTRATOR_PATH env -> same dir as rclaude -> PATH
 */
function findConcentratorBinary(): string | null {
  // 1. Check env var
  if (process.env.CONCENTRATOR_PATH) {
    if (existsSync(process.env.CONCENTRATOR_PATH)) {
      return process.env.CONCENTRATOR_PATH;
    }
    debug(`CONCENTRATOR_PATH set but not found: ${process.env.CONCENTRATOR_PATH}`);
  }

  // 2. Check same directory as rclaude (resolve symlinks)
  try {
    // Use process.execPath for compiled Bun executables (process.argv[1] points to $bunfs)
    const execPath = process.execPath;
    const realPath = realpathSync(execPath);
    const binDir = dirname(realPath);
    const sameDirPath = join(binDir, "concentrator");
    debug(`Checking same dir as ${realPath}: ${sameDirPath}`);
    if (existsSync(sameDirPath)) {
      return sameDirPath;
    }
  } catch (err) {
    debug(`Error resolving rclaude path: ${err}`);
  }

  // 3. Check PATH using `which`
  try {
    const result = Bun.spawnSync(["which", "concentrator"]);
    if (result.success && result.stdout) {
      const path = result.stdout.toString().trim();
      if (path && existsSync(path)) {
        debug(`Found in PATH: ${path}`);
        return path;
      }
    }
  } catch {
    // which not available or failed
  }

  debug("Concentrator binary not found");
  return null;
}

/**
 * Find web directory for concentrator
 * Priority: CONCENTRATOR_WEB_DIR env -> web/dist relative to binary
 */
function findWebDir(concentratorPath: string): string | null {
  // 1. Check env var
  if (process.env.CONCENTRATOR_WEB_DIR) {
    if (existsSync(process.env.CONCENTRATOR_WEB_DIR)) {
      return process.env.CONCENTRATOR_WEB_DIR;
    }
    debug(`CONCENTRATOR_WEB_DIR set but not found: ${process.env.CONCENTRATOR_WEB_DIR}`);
  }

  // 2. Check web/dist relative to concentrator binary
  try {
    const realPath = realpathSync(concentratorPath);
    const binDir = dirname(realPath);
    const webDistPath = join(binDir, "..", "web", "dist");
    if (existsSync(webDistPath)) {
      return webDistPath;
    }
    // Also check sibling to bin/
    const webDistPath2 = join(binDir, "..", "web", "dist");
    if (existsSync(webDistPath2)) {
      return webDistPath2;
    }
  } catch {
    // Ignore errors
  }

  return null;
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
 * Ensure concentrator is running, start it if needed
 */
async function ensureConcentrator(url: string): Promise<boolean> {
  // Already running?
  if (await isConcentratorReady(url)) {
    debug("Concentrator already running");
    return true;
  }

  // Find binary
  const concentratorPath = findConcentratorBinary();
  if (!concentratorPath) {
    debug("Could not find concentrator binary");
    return false;
  }

  // Build args
  const args: string[] = [];
  const webDir = findWebDir(concentratorPath);
  if (webDir) {
    args.push("--web-dir", webDir);
    debug(`Using web dir: ${webDir}`);
  }

  // Spawn detached
  debug(`Starting concentrator: ${concentratorPath} ${args.join(" ")}`);
  try {
    const proc = Bun.spawn([concentratorPath, ...args], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
  } catch (err) {
    debug(`Failed to spawn concentrator: ${err}`);
    return false;
  }

  // Poll until ready (max 3 seconds)
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(100);
    if (await isConcentratorReady(url)) {
      debug("Concentrator started successfully");
      return true;
    }
  }

  // Maybe someone else started it?
  if (await isConcentratorReady(url)) {
    debug("Concentrator ready (started by another process)");
    return true;
  }

  debug("Concentrator did not start in time");
  return false;
}

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

  // Ensure concentrator is running (unless --no-concentrator)
  if (!noConcentrator) {
    await ensureConcentrator(concentratorUrl);
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

      debug(`Hook: ${event.hookEvent}`);
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
