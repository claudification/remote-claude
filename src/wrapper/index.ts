#!/usr/bin/env bun
/**
 * rclaude - Claude Code Session Wrapper
 * Wraps claude CLI with hook injection and concentrator forwarding
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { HookEvent, TaskInfo, TasksUpdate } from '../shared/protocol'
import { createTranscriptWatcher, type TranscriptWatcher } from './transcript-watcher'
import { DEFAULT_CONCENTRATOR_URL } from '../shared/protocol'
import { startLocalServer, stopLocalServer } from './local-server'
import { type PtyProcess, setupTerminalPassthrough, spawnClaude } from './pty-spawn'
import { cleanupSettings, writeMergedSettings } from './settings-merge'
import { createWsClient, type WsClient } from './ws-client'

const DEBUG = !!process.env.RCLAUDE_DEBUG

function debug(msg: string) {
  if (DEBUG) console.error(`[rclaude] ${msg}`)
}

/**
 * Check if concentrator is running
 */
async function isConcentratorReady(url: string): Promise<boolean> {
  try {
    const httpUrl = url.replace('ws://', 'http://').replace('wss://', 'https://')
    const resp = await fetch(`${httpUrl}/health`, {
      signal: AbortSignal.timeout(200),
    })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * Set terminal title via OSC 2 escape sequence (shows in tmux window name)
 * Uses last 2 path segments, max 20 chars, right segment takes priority
 */
function setTerminalTitle(cwd: string) {
  const segments = cwd.split('/').filter(Boolean)
  const last2 = segments.slice(-2)
  let title = last2.join('/')

  if (title.length > 20) {
    // Right segment is most significant - keep it, truncate left
    const right = last2[last2.length - 1]
    if (right.length >= 20) {
      title = right.slice(0, 20)
    } else if (last2.length > 1) {
      const budget = 20 - right.length - 1 // -1 for the slash
      title = budget > 0 ? `${last2[0].slice(0, budget)}/${right}` : right
    }
  }

  // Strip control characters to prevent terminal escape injection
  title = title.replace(/[\x00-\x1f\x7f]/g, '')
  if (!title) return

  process.title = title
  process.stdout.write(`\x1b]2;${title}\x07`)

  // Direct tmux rename (automatic-rename overrides OSC 2 on macOS)
  if (process.env.TMUX) {
    try {
      Bun.spawnSync(['tmux', 'rename-window', title])
      Bun.spawnSync(['tmux', 'set-option', '-w', 'automatic-rename', 'off'])
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
`)
}

function extToMediaType(ext: string): string {
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    avif: 'image/avif',
  }
  return map[ext] || 'application/octet-stream'
}

async function main() {
  // Parse our specific args, pass the rest to claude
  const args = process.argv.slice(2)

  let concentratorUrl = DEFAULT_CONCENTRATOR_URL
  let concentratorSecret = process.env.RCLAUDE_SECRET
  let noConcentrator = false
  let noTerminal = false
  const claudeArgs: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--rclaude-help') {
      printHelp()
      process.exit(0)
    } else if (arg === '--concentrator') {
      concentratorUrl = args[++i] || DEFAULT_CONCENTRATOR_URL
    } else if (arg === '--rclaude-secret') {
      concentratorSecret = args[++i]
    } else if (arg === '--no-concentrator') {
      noConcentrator = true
    } else if (arg === '--no-terminal') {
      noTerminal = true
    } else {
      claudeArgs.push(arg)
    }
  }

  // Check if concentrator is reachable (unless --no-concentrator)
  if (!noConcentrator && !(await isConcentratorReady(concentratorUrl))) {
    debug('Concentrator not reachable - running without it')
    noConcentrator = true
  }

  // Internal ID for local server validation (not sent to concentrator)
  const internalId = randomUUID()
  const cwd = process.cwd()

  // Will be set when we receive SessionStart from Claude
  let claudeSessionId: string | null = null
  let wsClient: WsClient | null = null
  let ptyProcess: PtyProcess | null = null
  let terminalAttached = false
  let savedTerminalSize: { cols: number; rows: number } | null = null
  let taskPollTimer: ReturnType<typeof setInterval> | null = null
  let lastTasksJson = ''
  let transcriptWatcher: TranscriptWatcher | null = null
  const subagentWatchers = new Map<string, TranscriptWatcher>()

  // Queue events until we have the real session ID
  const eventQueue: HookEvent[] = []

  /**
   * Poll ~/.claude/tasks/ for task state changes
   * Checks both claudeSessionId (--continue reuses its own ID) and internalId (fresh sessions)
   */
  function startTaskPolling(sessionId: string) {
    if (taskPollTimer) return
    const tasksBase = join(homedir(), '.claude', 'tasks')
    // claudeSessionId = what Claude actually uses; internalId = what we set CLAUDE_CODE_TASK_LIST_ID to
    const candidateDirs = [
      claudeSessionId ? join(tasksBase, claudeSessionId) : null,
      join(tasksBase, internalId),
    ].filter(Boolean) as string[]

    taskPollTimer = setInterval(() => {
      if (!wsClient?.isConnected()) return

      try {
        // Find first candidate dir that exists and has task files
        let tasksDir: string | null = null
        for (const dir of candidateDirs) {
          if (existsSync(dir)) {
            tasksDir = dir
            break
          }
        }
        if (!tasksDir) return
        const files = readdirSync(tasksDir)
          .filter(f => f.endsWith('.json'))
          .sort()
        if (files.length === 0) return

        const tasks: TaskInfo[] = []
        for (const file of files) {
          try {
            const raw = readFileSync(join(tasksDir, file), 'utf-8')
            const task = JSON.parse(raw)
            tasks.push({
              id: String(task.id || ''),
              subject: String(task.subject || ''),
              description: task.description ? String(task.description) : undefined,
              status: task.status || 'pending',
              blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : undefined,
              blocks: Array.isArray(task.blocks) ? task.blocks.map(String) : undefined,
              owner: task.owner ? String(task.owner) : undefined,
              updatedAt: Date.now(),
            })
          } catch {
            // Skip malformed task files
          }
        }

        // Only send if changed
        const json = JSON.stringify(tasks)
        if (json !== lastTasksJson) {
          lastTasksJson = json
          const msg: TasksUpdate = { type: 'tasks_update', sessionId, tasks }
          wsClient?.send(msg)
          debug(`Tasks updated: ${tasks.length} tasks`)
        }
      } catch {
        // Ignore polling errors
      }
    }, 3000)
  }

  function connectToConcentrator(sessionId: string) {
    if (noConcentrator || wsClient) return

    // Build capabilities list
    const capabilities = noTerminal ? [] : ['terminal' as const]

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
          wsClient?.sendHookEvent({ ...event, sessionId })
        }
        eventQueue.length = 0
        // Start polling task files
        startTaskPolling(sessionId)
      },
      onDisconnected() {
        debug('Disconnected from concentrator')
      },
      onError(error) {
        debug(`Concentrator error: ${error.message}`)
      },
      onInput(input) {
        if (!ptyProcess) return
        // Strip trailing whitespace
        const trimmed = input.replace(/[\r\n]+$/, '').replace(/\n/g, '\\\n')
        // Send text first
        ptyProcess.write(trimmed)
        // Then send Enter key separately after a tiny delay
        // Send two \r with a gap - sometimes the first one gets swallowed by Claude Code
        setTimeout(() => {
          ptyProcess?.write('\r')
          setTimeout(() => {
            ptyProcess?.write('\r')
          }, 100)
        }, 50)
        debug(`Sent to PTY: ${JSON.stringify(trimmed)} then 2x\\r`)
      },
      onTerminalInput(data) {
        // Raw keystrokes from browser terminal - write directly to PTY
        if (ptyProcess) {
          ptyProcess.write(data)
        }
      },
      onTerminalAttach(cols, rows) {
        terminalAttached = true
        // Save local terminal size before remote viewer takes over
        savedTerminalSize = {
          cols: process.stdout.columns || 80,
          rows: process.stdout.rows || 24,
        }
        debug(
          `Terminal attached (${cols}x${rows}), saved local size (${savedTerminalSize.cols}x${savedTerminalSize.rows})`,
        )
        if (ptyProcess) {
          ptyProcess.resize(cols, rows)
          // Force full screen repaint so remote viewer sees current state
          // Small delay to let resize settle before SIGWINCH
          setTimeout(() => ptyProcess?.redraw(), 50)
        }
      },
      onTerminalDetach() {
        terminalAttached = false
        // Restore local terminal size
        if (savedTerminalSize && ptyProcess) {
          ptyProcess.resize(savedTerminalSize.cols, savedTerminalSize.rows)
          debug(`Terminal detached, restored to ${savedTerminalSize.cols}x${savedTerminalSize.rows}`)
          savedTerminalSize = null
        } else {
          debug('Terminal detached')
        }
      },
      onTerminalResize(cols, rows) {
        if (ptyProcess) {
          ptyProcess.resize(cols, rows)
        }
        debug(`Terminal resized to ${cols}x${rows}`)
      },
      onFileRequest(requestId, path) {
        // Read file from local filesystem and respond
        readFile(path)
          .then(buf => {
            const ext = path.split('.').pop()?.toLowerCase() || ''
            const mediaType = extToMediaType(ext)
            wsClient?.sendFileResponse(requestId, buf.toString('base64'), mediaType)
            debug(`File response: ${path} (${buf.length} bytes)`)
          })
          .catch(err => {
            wsClient?.sendFileResponse(requestId, undefined, undefined, String(err))
            debug(`File request failed: ${path} - ${err}`)
          })
      },
    })
  }

  function startTranscriptWatcher(transcriptPath: string) {
    if (transcriptWatcher) return // already watching

    transcriptWatcher = createTranscriptWatcher({
      onEntries(entries, isInitial) {
        if (claudeSessionId && wsClient?.isConnected()) {
          wsClient.sendTranscriptEntries(entries, isInitial)
          debug(`Sent ${entries.length} transcript entries (initial: ${isInitial})`)
        }
      },
      onError(err) {
        debug(`Transcript watcher error: ${err.message}`)
      },
    })

    transcriptWatcher.start(transcriptPath).catch(err => {
      debug(`Failed to start transcript watcher: ${err}`)
    })
    debug(`Watching transcript: ${transcriptPath}`)
  }

  function startSubagentWatcher(agentId: string, transcriptPath: string) {
    if (subagentWatchers.has(agentId)) return

    const watcher = createTranscriptWatcher({
      onEntries(entries, isInitial) {
        if (claudeSessionId && wsClient?.isConnected()) {
          wsClient.sendSubagentTranscript(agentId, entries, isInitial)
          debug(`Sent ${entries.length} subagent transcript entries for ${agentId.slice(0, 7)}`)
        }
      },
      onError(err) {
        debug(`Subagent watcher error (${agentId.slice(0, 7)}): ${err.message}`)
      },
    })

    subagentWatchers.set(agentId, watcher)
    watcher.start(transcriptPath).catch(err => {
      debug(`Failed to start subagent watcher: ${err}`)
    })
    debug(`Watching subagent transcript: ${agentId.slice(0, 7)}`)
  }

  // Start local HTTP server for hook callbacks
  const { server: localServer, port: localServerPort } = await startLocalServer({
    sessionId: internalId,
    onHookEvent(event: HookEvent) {
      // Extract Claude's real session ID from SessionStart
      if (event.hookEvent === 'SessionStart' && event.data) {
        const data = event.data as Record<string, unknown>
        if (data.session_id && typeof data.session_id === 'string') {
          claudeSessionId = data.session_id
          debug(`Got Claude session ID: ${claudeSessionId.slice(0, 8)}...`)
          // Now connect to concentrator with the real ID
          connectToConcentrator(claudeSessionId)

          // Start transcript watcher if we have a transcript path
          if (data.transcript_path && typeof data.transcript_path === 'string') {
            startTranscriptWatcher(data.transcript_path)
          }
        }
      }

      // Watch subagent transcripts when they start
      if (event.hookEvent === 'SubagentStop' && event.data) {
        const data = event.data as Record<string, unknown>
        const agentId = String(data.agent_id || '')
        const transcriptPath = data.agent_transcript_path as string | undefined
        if (agentId && transcriptPath) {
          startSubagentWatcher(agentId, transcriptPath)
        }
      }

      // Forward to concentrator, or queue until session ID + WS are ready
      if (claudeSessionId && wsClient?.isConnected()) {
        wsClient.sendHookEvent({ ...event, sessionId: claudeSessionId })
      } else {
        eventQueue.push(event)
      }

      debug(`Hook: ${event.hookEvent}`)
    },
  })

  // Generate merged settings with hook injection
  const settingsPath = await writeMergedSettings(internalId, localServerPort)

  // Set terminal title to last 2 path segments (shows in tmux)
  setTerminalTitle(cwd)

  // Spawn claude with PTY
  // Convert WS URL to HTTP for tools/scripts that need to call the concentrator REST API
  const concentratorHttpUrl = noConcentrator
    ? undefined
    : concentratorUrl.replace('ws://', 'http://').replace('wss://', 'https://')

  ptyProcess = spawnClaude({
    args: claudeArgs,
    settingsPath,
    sessionId: internalId,
    localServerPort,
    concentratorUrl: concentratorHttpUrl,
    concentratorSecret,
    onData(data) {
      // Forward PTY output to remote terminal viewer when attached
      if (terminalAttached && claudeSessionId && wsClient?.isConnected()) {
        wsClient.sendTerminalData(data)
      }
    },
    onExit(code) {
      // Send session end to concentrator
      if (claudeSessionId) {
        wsClient?.sendSessionEnd(code === 0 ? 'normal' : `exit_code_${code}`)
      }

      // Cleanup
      cleanup()

      process.exit(code ?? 0)
    },
  })

  // Setup terminal passthrough
  const cleanupTerminal = setupTerminalPassthrough(ptyProcess)

  // Cleanup function
  function cleanup() {
    if (taskPollTimer) clearInterval(taskPollTimer)
    transcriptWatcher?.stop()
    for (const watcher of subagentWatchers.values()) watcher.stop()
    subagentWatchers.clear()
    cleanupTerminal()
    stopLocalServer(localServer)
    wsClient?.close()
    cleanupSettings(internalId).catch(() => {})
  }

  // Handle unexpected exits
  process.on('exit', cleanup)
  process.on('uncaughtException', error => {
    console.error('[rclaude] Uncaught exception:', error)
    cleanup()
    process.exit(1)
  })
}

main().catch(error => {
  console.error('[rclaude] Fatal error:', error)
  process.exit(1)
})
