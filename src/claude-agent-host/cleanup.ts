/**
 * Cleanup & Signal Handlers
 * Handles graceful shutdown, resource cleanup, and crash logging.
 */

import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentHostContext } from './agent-host-context'
import { debug } from './debug'
import { type HttpServer, stopLocalServer } from './local-server'
import { closeMcpChannel } from './mcp-channel'
import { cleanupSettings } from './settings-merge'

export interface CleanupDeps {
  conversationId: string
  rclaudeDir: string
  promptFile: string
  localServer: HttpServer
  cleanupTerminal: () => void
}

export function createCleanup(ctx: AgentHostContext, deps: CleanupDeps): () => void {
  return function cleanup() {
    if (ctx.taskWatcher) ctx.taskWatcher.close()
    ctx.transcriptWatcher?.stop()
    for (const watcher of ctx.subagentWatchers.values()) watcher.stop()
    ctx.subagentWatchers.clear()
    for (const watcher of ctx.bgTaskOutputWatchers.values()) watcher.stop()
    ctx.bgTaskOutputWatchers.clear()
    ctx.fileEditor?.destroy()
    deps.cleanupTerminal()
    stopLocalServer(deps.localServer)
    ctx.wsClient?.close()
    if (ctx.diagFlushTimer) {
      clearTimeout(ctx.diagFlushTimer)
      ctx.diagFlushTimer = null
    }
    ctx.diagBuffer.length = 0
    ctx.eventQueue.length = 0
    cleanupSettings(deps.conversationId, deps.rclaudeDir).catch(() => {})
    closeMcpChannel().catch(() => {})
    try {
      unlinkSync(deps.promptFile)
    } catch {}
    reapStaleSettings(deps.rclaudeDir)
  }
}

function reapStaleSettings(rclaudeDir: string) {
  try {
    const settingsDir = join(rclaudeDir, 'settings')
    const maxAge = 25 * 24 * 60 * 60 * 1000
    const now = Date.now()
    for (const file of readdirSync(settingsDir)) {
      const filePath = join(settingsDir, file)
      try {
        const stat = Bun.file(filePath)
        if (now - stat.lastModified > maxAge) unlinkSync(filePath)
      } catch {}
    }
  } catch {}
}

export function registerSignalHandlers(cleanup: () => void) {
  process.on('exit', cleanup)
  process.on('uncaughtException', error => {
    const msg = `[FATAL] Uncaught exception: ${error instanceof Error ? error.stack || error.message : error}`
    debug(msg)
    try {
      require('node:fs').appendFileSync('/tmp/rclaude-crash.log', `${new Date().toISOString()} ${msg}\n`)
    } catch {
      /* ignore */
    }
    // DO NOT process.exit() - keep running. The agent host must never crash.
  })
  process.on('unhandledRejection', reason => {
    const msg = `[FATAL] Unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : reason}`
    debug(msg)
    try {
      require('node:fs').appendFileSync('/tmp/rclaude-crash.log', `${new Date().toISOString()} ${msg}\n`)
    } catch {
      /* ignore */
    }
    // DO NOT process.exit() - keep running.
  })
}
